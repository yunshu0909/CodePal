/**
 * 日维度汇总缓存服务
 *
 * 负责：
 * - 日汇总文件的读写
 * - 日汇总数据归一化
 * - 多日汇总合并
 * - 单日汇总重算
 *
 * @module electron/services/dailySummaryService
 */

const fs = require('fs/promises')
const path = require('path')
const os = require('os')
const { toSafeInt, scanClaudeLogs, scanCodexLogs, aggregateByModel, aggregateByProject } = require('./usageLogScanService')

// 日汇总缓存 schema 版本号：
// - v1：旧口径（Claude 未按 message.id 最终态去重）
// - v2：新口径（Claude 按 message.id 最终态去重）
// - v3：补充 projects 维度，并与实时页保持相同字段口径
// - v4：Codex 子 agent 回放去重（forked session 的历史回放 token 不再重复计入）
const DAILY_SUMMARY_SCHEMA_VERSION = 4

/**
 * 校验日期 key 是否为 YYYY-MM-DD 且可解析
 * @param {string} dateKey - 日期 key
 * @returns {boolean}
 */
function isValidDateKey(dateKey) {
  if (typeof dateKey !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    return false
  }

  const date = new Date(`${dateKey}T00:00:00+08:00`)
  return !Number.isNaN(date.getTime())
}

/**
 * 根据日期 key 获取北京时间当日 UTC 起点
 * @param {string} dateKey - YYYY-MM-DD
 * @returns {Date}
 */
function getBeijingDayStartByKey(dateKey) {
  return new Date(`${dateKey}T00:00:00+08:00`)
}

/**
 * 获取 daily-stats 文件路径
 * @param {string} dateKey - YYYY-MM-DD
 * @param {object} deps - 依赖注入
 * @returns {string}
 */
function getDailySummaryFilePath(dateKey, deps = {}) {
  const homeDir = deps.homeDir || os.homedir()
  return path.join(homeDir, '.ai-workbench', 'daily-stats', `${dateKey}.json`)
}

/**
 * 归一化日汇总模型对象
 * @param {Record<string, any>} models - 原始模型对象
 * @returns {Record<string, {input:number,output:number,cacheRead:number,cacheCreate:number,total:number}>}
 */
function normalizeSummaryModels(models) {
  const result = {}

  if (!models || typeof models !== 'object') {
    return result
  }

  for (const [modelName, modelData] of Object.entries(models)) {
    if (!modelData || typeof modelData !== 'object') continue

    const input = toSafeInt(modelData.input)
    const output = toSafeInt(modelData.output)
    const cacheRead = toSafeInt(modelData.cacheRead)
    const cacheCreate = toSafeInt(modelData.cacheCreate)
    const total = toSafeInt(modelData.total) || (input + output + cacheRead + cacheCreate)

    result[modelName] = { input, output, cacheRead, cacheCreate, total }
  }

  return result
}

/**
 * 归一化日汇总项目对象
 * @param {Record<string, any>} projects - 原始项目对象
 * @returns {Record<string, {value:number}>}
 */
function normalizeSummaryProjects(projects) {
  const result = {}

  if (!projects || typeof projects !== 'object') {
    return result
  }

  for (const [projectName, projectData] of Object.entries(projects)) {
    if (!projectData || typeof projectData !== 'object') continue

    result[projectName] = {
      value: toSafeInt(projectData.value)
    }
  }

  return result
}

/**
 * 归一化日汇总数据
 * @param {object} raw - 原始日汇总 JSON
 * @param {string} expectedDateKey - 期望日期 key
 * @returns {object|null}
 */
function normalizeDailySummary(raw, expectedDateKey) {
  if (!raw || typeof raw !== 'object') {
    return null
  }

  // 版本不匹配时强制补算，避免继续读取旧口径的日汇总缓存。
  if (toSafeInt(raw.version) !== DAILY_SUMMARY_SCHEMA_VERSION) {
    return null
  }

  const date = typeof raw.date === 'string' ? raw.date : expectedDateKey
  if (!isValidDateKey(date)) {
    return null
  }

  const models = normalizeSummaryModels(raw.models)
  const projects = normalizeSummaryProjects(raw.projects)

  const total = Object.values(models).reduce((sum, model) => sum + model.total, 0)
  const input = Object.values(models).reduce((sum, model) => sum + model.input, 0)
  const output = Object.values(models).reduce((sum, model) => sum + model.output, 0)
  const cache = Object.values(models).reduce((sum, model) => sum + model.cacheRead + model.cacheCreate, 0)

  return {
    version: DAILY_SUMMARY_SCHEMA_VERSION,
    date,
    generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : new Date().toISOString(),
    models,
    projects,
    summary: {
      total: toSafeInt(raw.summary?.total) || total,
      input: toSafeInt(raw.summary?.input) || input,
      output: toSafeInt(raw.summary?.output) || output,
      cache: toSafeInt(raw.summary?.cache) || cache
    }
  }
}

/**
 * 读取日汇总文件
 * @param {string} dateKey - YYYY-MM-DD
 * @param {object} deps - 依赖注入
 * @returns {Promise<object|null>}
 */
async function readDailySummary(dateKey, deps = {}) {
  const pathExistsFn = deps.pathExistsFn || (async (fp) => {
    try { await fs.access(fp); return true } catch { return false }
  })
  const readFileFn = deps.readFileFn || fs.readFile

  const filePath = getDailySummaryFilePath(dateKey, deps)
  const exists = await pathExistsFn(filePath)

  if (!exists) {
    return null
  }

  try {
    const raw = await readFileFn(filePath, 'utf-8')
    const parsed = JSON.parse(raw)
    return normalizeDailySummary(parsed, dateKey)
  } catch {
    // 文件损坏场景走补算，避免直接抛错阻断主流程
    return null
  }
}

/**
 * 写入日汇总文件
 * @param {string} dateKey - YYYY-MM-DD
 * @param {object} summary - 日汇总对象
 * @param {object} deps - 依赖注入
 */
async function writeDailySummary(dateKey, summary, deps = {}) {
  const mkdirFn = deps.mkdirFn || fs.mkdir
  const writeFileFn = deps.writeFileFn || fs.writeFile

  const filePath = getDailySummaryFilePath(dateKey, deps)
  const dirPath = path.dirname(filePath)

  await mkdirFn(dirPath, { recursive: true })
  await writeFileFn(filePath, `${JSON.stringify(summary, null, 2)}\n`, 'utf-8')
}

/**
 * 将聚合 Map 转为日汇总文件结构
 * @param {string} dateKey - 日期 key
 * @param {Map<string, object>} aggregated - 模型聚合 Map
 * @param {Map<string, {name: string, value: number}>} projectAggregated - 项目聚合 Map
 * @param {Date} generatedAt - 生成时间
 * @returns {object}
 */
function buildDailySummary(dateKey, aggregated, projectAggregated = new Map(), generatedAt = new Date()) {
  const models = {}
  const projects = {}

  for (const [modelName, modelData] of aggregated.entries()) {
    if (modelData.total <= 0) continue
    models[modelName] = {
      input: modelData.input,
      output: modelData.output,
      cacheRead: modelData.cacheRead,
      cacheCreate: modelData.cacheCreate,
      total: modelData.total
    }
  }

  for (const [projectName, projectData] of projectAggregated.entries()) {
    if (projectData.value <= 0) continue
    projects[projectName] = {
      value: projectData.value
    }
  }

  const summary = {
    total: Object.values(models).reduce((sum, model) => sum + model.total, 0),
    input: Object.values(models).reduce((sum, model) => sum + model.input, 0),
    output: Object.values(models).reduce((sum, model) => sum + model.output, 0),
    cache: Object.values(models).reduce((sum, model) => sum + model.cacheRead + model.cacheCreate, 0)
  }

  return {
    version: DAILY_SUMMARY_SCHEMA_VERSION,
    date: dateKey,
    generatedAt: generatedAt.toISOString(),
    models,
    projects,
    summary
  }
}

/**
 * 重算单日日汇总
 * @param {string} dateKey - YYYY-MM-DD
 * @param {object} deps - 依赖注入
 * @returns {Promise<object>}
 */
async function recomputeDailySummary(dateKey, deps = {}) {
  const start = getBeijingDayStartByKey(dateKey)
  const end = new Date(start)
  end.setUTCDate(end.getUTCDate() + 1)

  const [claudeRecords, codexRecords] = await Promise.all([
    scanClaudeLogs(start, end, deps),
    scanCodexLogs(start, end, deps)
  ])

  const allRecords = [...claudeRecords, ...codexRecords]
  const aggregated = aggregateByModel(allRecords)
  const projectAggregated = aggregateByProject(allRecords)

  return buildDailySummary(dateKey, aggregated, projectAggregated, deps.nowFn ? deps.nowFn() : new Date())
}

/**
 * 将日汇总列表合并为模型聚合 Map
 * @param {Array<object>} dailySummaries - 日汇总数组
 * @returns {{models: Map<string, object>, projects: Map<string, {name: string, value: number}>}}
 */
function mergeDailySummaries(dailySummaries) {
  const aggregated = new Map()
  const aggregatedProjects = new Map()

  for (const dailySummary of dailySummaries) {
    for (const [modelName, modelData] of Object.entries(dailySummary.models || {})) {
      if (!aggregated.has(modelName)) {
        aggregated.set(modelName, {
          name: modelName,
          input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0, count: 0
        })
      }

      const acc = aggregated.get(modelName)
      acc.input += toSafeInt(modelData.input)
      acc.output += toSafeInt(modelData.output)
      acc.cacheRead += toSafeInt(modelData.cacheRead)
      acc.cacheCreate += toSafeInt(modelData.cacheCreate)
      acc.total += toSafeInt(modelData.total)
      acc.count += 1
    }

    for (const [projectName, projectData] of Object.entries(dailySummary.projects || {})) {
      if (!aggregatedProjects.has(projectName)) {
        aggregatedProjects.set(projectName, {
          name: projectName,
          value: 0
        })
      }

      const acc = aggregatedProjects.get(projectName)
      acc.value += toSafeInt(projectData.value)
    }
  }

  return {
    models: aggregated,
    projects: aggregatedProjects
  }
}

module.exports = {
  DAILY_SUMMARY_SCHEMA_VERSION,
  isValidDateKey,
  getBeijingDayStartByKey,
  getDailySummaryFilePath,
  normalizeSummaryModels,
  normalizeSummaryProjects,
  normalizeDailySummary,
  readDailySummary,
  writeDailySummary,
  buildDailySummary,
  recomputeDailySummary,
  mergeDailySummaries,
}
