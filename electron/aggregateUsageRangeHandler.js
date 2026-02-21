/**
 * 自定义日期区间聚合处理器
 *
 * 负责：
 * - 校验自定义日期区间参数（开始/结束/北京时间边界）
 * - 读取/写入日维度汇总文件（daily-stats）
 * - 对缺失日期执行实时补算并回填缓存
 * - 返回与前端展示一致的聚合视图数据
 *
 * @module electron/aggregateUsageRangeHandler
 */

const fs = require('fs/promises')
const path = require('path')
const os = require('os')
const { scanLogFilesInRange } = require('./logScanner')

const CODEX_SESSION_ID_REGEX = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

// 日汇总缓存 schema 版本号：
// - v1：旧口径（Claude 未按 message.id 最终态去重）
// - v2：新口径（Claude 按 message.id 最终态去重）
const DAILY_SUMMARY_SCHEMA_VERSION = 2

// 模型颜色映射表（沿用前端聚合口径，确保图例颜色稳定）
const MODEL_COLORS = {
  opus: '#f59e0b',
  'claude-opus': '#f59e0b',
  sonnet: '#6366f1',
  'claude-sonnet': '#6366f1',
  haiku: '#8b5cf6',
  'claude-haiku': '#8b5cf6',
  claude: '#ec4899',
  'gpt-5': '#e67e22',
  'gpt-4o': '#f97316',
  'gpt-4': '#fbbf24',
  'gpt-3.5': '#f59e0b',
  kimi: '#16a34a',
  'kimi-pro': '#22c55e',
  deepseek: '#a855f7',
  gemini: '#dc2626',
  qwen: '#10b981',
  yi: '#ec4899',
  llama: '#06b6d4',
  mistral: '#fbbf24',
  codex: '#3b82f6',
  default: '#8b919a'
}

/**
 * 检查路径是否存在
 * @param {string} filepath - 目标路径
 * @returns {Promise<boolean>}
 */
async function pathExists(filepath) {
  try {
    await fs.access(filepath)
    return true
  } catch {
    return false
  }
}

/**
 * 将任意输入转换为非负整数
 * @param {unknown} value - 输入值
 * @returns {number}
 */
function toSafeInt(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    return 0
  }
  return Math.max(0, Math.floor(parsed))
}

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
 * 获取北京时间年月日
 * @param {Date} date - 参考时间
 * @returns {{year: string, month: string, day: string}}
 */
function getBeijingDateParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  })

  const parts = formatter.formatToParts(date)
  const map = {}

  for (const part of parts) {
    if (part.type === 'year' || part.type === 'month' || part.type === 'day') {
      map[part.type] = part.value
    }
  }

  return {
    year: map.year,
    month: map.month,
    day: map.day
  }
}

/**
 * 获取北京时间日期 key（YYYY-MM-DD）
 * @param {Date} date - 参考时间
 * @returns {string}
 */
function getBeijingDayKey(date = new Date()) {
  const parts = getBeijingDateParts(date)
  return `${parts.year}-${parts.month}-${parts.day}`
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
 * 生成闭区间日期序列
 * @param {string} startDate - 开始日期（YYYY-MM-DD）
 * @param {string} endDate - 结束日期（YYYY-MM-DD）
 * @returns {string[]}
 */
function buildDateRange(startDate, endDate) {
  const result = []
  const cursor = getBeijingDayStartByKey(startDate)
  const end = getBeijingDayStartByKey(endDate)

  while (cursor <= end) {
    result.push(getBeijingDayKey(cursor))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }

  return result
}

/**
 * 标准化模型名称
 * @param {string} model - 原始模型名
 * @returns {string}
 */
function normalizeModelName(model) {
  if (!model || typeof model !== 'string') {
    return 'unknown'
  }

  const lowerModel = model.toLowerCase()

  if (lowerModel.includes('claude-opus') || lowerModel.includes('opus')) return 'opus'
  if (lowerModel.includes('claude-sonnet') || lowerModel.includes('sonnet')) return 'sonnet'
  if (lowerModel.includes('claude-haiku') || lowerModel.includes('haiku')) return 'haiku'
  if (lowerModel.includes('claude')) return 'claude'

  if (lowerModel.includes('gpt-5') || lowerModel.includes('gpt5')) return 'gpt-5'
  if (lowerModel.includes('gpt-4o')) return 'gpt-4o'
  if (lowerModel.includes('gpt-4')) return 'gpt-4'
  if (lowerModel.includes('gpt-3.5') || lowerModel.includes('gpt3')) return 'gpt-3.5'

  if (lowerModel.includes('kimi')) return 'kimi'
  if (lowerModel.includes('deepseek')) return 'deepseek'
  if (lowerModel.includes('gemini')) return 'gemini'
  if (lowerModel.includes('qwen')) return 'qwen'
  if (lowerModel.includes('yi')) return 'yi'
  if (lowerModel.includes('llama')) return 'llama'
  if (lowerModel.includes('mistral')) return 'mistral'

  return lowerModel.split(':')[0].split('-').slice(0, 2).join('-')
}

/**
 * 解析 Claude 日志行
 * @param {string} line - JSONL 行
 * @returns {{timestamp: Date|null, model: string, messageId: string|null, input: number, output: number, cacheRead: number, cacheCreate: number}|null}
 */
function parseClaudeLog(line) {
  try {
    const data = JSON.parse(line)

    if (!data.message?.usage) {
      return null
    }

    const usage = data.message.usage
    const timestamp = data.timestamp || data.message.timestamp
    const model = normalizeModelName(data.message.model || 'unknown')
    const messageId = typeof data.message.id === 'string' ? data.message.id : null

    return {
      timestamp: timestamp ? new Date(timestamp) : null,
      model,
      messageId,
      input: toSafeInt(usage.input_tokens),
      output: toSafeInt(usage.output_tokens),
      cacheRead: toSafeInt(usage.cache_read_input_tokens || usage.cache_read_tokens),
      cacheCreate: toSafeInt(usage.cache_creation_input_tokens || usage.cache_creation_tokens)
    }
  } catch {
    return null
  }
}

/**
 * 解析 Codex token_count 累计快照
 * @param {string} line - JSONL 行
 * @returns {{timestamp: Date|null, model: string, inputTotal: number, outputTotal: number, cacheReadTotal: number, totalTokens: number}|null}
 */
function parseCodexTokenSnapshot(line) {
  try {
    const data = JSON.parse(line)

    if (data.type !== 'event_msg' || data.payload?.type !== 'token_count') {
      return null
    }

    const info = data.payload.info
    if (!info?.total_token_usage) {
      return null
    }

    const totalUsage = info.total_token_usage
    const inputTotal = toSafeInt(totalUsage.input_tokens)
    const outputTotal = toSafeInt(totalUsage.output_tokens)
    const cacheReadTotal = toSafeInt(totalUsage.cached_input_tokens)
    const totalTokens = toSafeInt(totalUsage.total_tokens) || (inputTotal + outputTotal + cacheReadTotal)

    return {
      timestamp: data.timestamp ? new Date(data.timestamp) : null,
      model: 'codex',
      inputTotal,
      outputTotal,
      cacheReadTotal,
      totalTokens
    }
  } catch {
    return null
  }
}

/**
 * 从 Codex 文件路径提取 session ID
 * @param {string} filePath - 日志文件路径
 * @returns {string}
 */
function extractCodexSessionId(filePath) {
  const normalizedPath = typeof filePath === 'string' ? filePath : ''
  const fileName = normalizedPath.split(/[\\/]/).pop() || ''
  const stem = fileName.replace(/\.jsonl$/i, '')
  const matched = stem.match(CODEX_SESSION_ID_REGEX)
  return (matched?.[1] || stem || 'unknown-codex-session').toLowerCase()
}

/**
 * 选择累计值更大的 Codex 快照
 * @param {object|null} current - 现有快照
 * @param {object} incoming - 新快照
 * @returns {object}
 */
function pickCodexMaxSnapshot(current, incoming) {
  if (!current) return incoming
  if (incoming.totalTokens > current.totalTokens) return incoming

  // 总量相同场景优先更新更晚快照，避免日志顺序抖动
  if (incoming.totalTokens === current.totalTokens && incoming.timestamp > current.timestamp) {
    return incoming
  }

  return current
}

/**
 * 选择时间更晚的 Claude message 快照
 * @param {{record: object, order: number}|null} current - 当前保留快照
 * @param {{record: object, order: number}} incoming - 新快照
 * @returns {{record: object, order: number}} 需要保留的快照
 */
function pickLatestClaudeRecord(current, incoming) {
  if (!current) return incoming

  const currentTs = current.record.timestamp?.getTime?.() || 0
  const incomingTs = incoming.record.timestamp?.getTime?.() || 0

  if (incomingTs > currentTs) return incoming
  if (incomingTs < currentTs) return current

  // 同时间戳时取后写入项，规避同一瞬间多条日志的顺序抖动
  if (incoming.order > current.order) return incoming

  return current
}

/**
 * 扫描 Claude 日志并提取窗口记录
 * @param {Date} start - 窗口开始（含）
 * @param {Date} end - 窗口结束（不含）
 * @param {object} deps - 依赖注入
 * @returns {Promise<Array<object>>}
 */
async function scanClaudeLogs(start, end, deps = {}) {
  const pathExistsFn = deps.pathExistsFn || pathExists
  const scanLogFilesInRangeFn = deps.scanLogFilesInRangeFn || scanLogFilesInRange
  const homeDir = deps.homeDir || os.homedir()

  const claudeBasePath = path.join(homeDir, '.claude', 'projects')
  const exists = await pathExistsFn(claudeBasePath)

  if (!exists) {
    return []
  }

  const scanResult = await scanLogFilesInRangeFn(claudeBasePath, start, end)
  const latestByMessage = new Map()
  let streamOrder = 0

  for (const file of scanResult.files || []) {
    for (let index = 0; index < (file.lines || []).length; index += 1) {
      const line = file.lines[index]
      const record = parseClaudeLog(line)
      if (record?.timestamp && record.timestamp >= start && record.timestamp < end) {
        streamOrder += 1
        // Claude 同一 message.id 可能写入中间态与最终态，按“最新快照”保留才能避免重复累计
        const messageId = record.messageId || `${file.path || 'unknown-file'}:${index}`
        const incoming = { record, order: streamOrder }
        const current = latestByMessage.get(messageId)
        const picked = pickLatestClaudeRecord(current, incoming)
        if (picked !== current) {
          latestByMessage.set(messageId, picked)
        }
      }
    }
  }

  return Array.from(latestByMessage.values(), (item) => item.record)
}

/**
 * 扫描 Codex 日志并提取窗口增量记录
 * @param {Date} start - 窗口开始（含）
 * @param {Date} end - 窗口结束（不含）
 * @param {object} deps - 依赖注入
 * @returns {Promise<Array<object>>}
 */
async function scanCodexLogs(start, end, deps = {}) {
  const pathExistsFn = deps.pathExistsFn || pathExists
  const scanLogFilesInRangeFn = deps.scanLogFilesInRangeFn || scanLogFilesInRange
  const homeDir = deps.homeDir || os.homedir()

  const codexBasePath = path.join(homeDir, '.codex', 'sessions')
  const exists = await pathExistsFn(codexBasePath)

  if (!exists) {
    return []
  }

  const scanResult = await scanLogFilesInRangeFn(codexBasePath, start, end)
  const sessionSnapshots = new Map()

  for (const file of scanResult.files || []) {
    const sessionId = extractCodexSessionId(file.path)
    const state = sessionSnapshots.get(sessionId) || { beforeWindow: null, inWindow: null }

    for (const line of file.lines || []) {
      const snapshot = parseCodexTokenSnapshot(line)
      if (!snapshot?.timestamp) continue

      if (snapshot.timestamp < start) {
        state.beforeWindow = pickCodexMaxSnapshot(state.beforeWindow, snapshot)
        continue
      }

      if (snapshot.timestamp >= start && snapshot.timestamp < end) {
        state.inWindow = pickCodexMaxSnapshot(state.inWindow, snapshot)
      }
    }

    sessionSnapshots.set(sessionId, state)
  }

  const records = []

  for (const state of sessionSnapshots.values()) {
    if (!state.inWindow) continue

    const before = state.beforeWindow || {
      inputTotal: 0,
      outputTotal: 0,
      cacheReadTotal: 0,
      totalTokens: 0
    }

    const deltaInputTotal = Math.max(0, state.inWindow.inputTotal - before.inputTotal)
    const deltaOutput = Math.max(0, state.inWindow.outputTotal - before.outputTotal)
    const deltaCacheRead = Math.max(0, state.inWindow.cacheReadTotal - before.cacheReadTotal)

    // Codex 的 input_tokens 包含 cached_input_tokens，因此需要拆分
    const deltaNonCachedInput = Math.max(0, deltaInputTotal - deltaCacheRead)
    const deltaTotal = deltaNonCachedInput + deltaOutput + deltaCacheRead

    if (deltaTotal <= 0) continue

    records.push({
      timestamp: state.inWindow.timestamp,
      model: state.inWindow.model,
      input: deltaNonCachedInput,
      output: deltaOutput,
      cacheRead: deltaCacheRead,
      cacheCreate: 0
    })
  }

  return records
}

/**
 * 按模型聚合记录
 * @param {Array<object>} records - 原始记录
 * @returns {Map<string, {name: string, input: number, output: number, cacheRead: number, cacheCreate: number, total: number, count: number}>}
 */
function aggregateByModel(records) {
  const aggregated = new Map()

  for (const record of records) {
    const model = record.model || 'unknown'

    if (!aggregated.has(model)) {
      aggregated.set(model, {
        name: model,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheCreate: 0,
        total: 0,
        count: 0
      })
    }

    const modelData = aggregated.get(model)
    modelData.input += record.input || 0
    modelData.output += record.output || 0
    modelData.cacheRead += record.cacheRead || 0
    modelData.cacheCreate += record.cacheCreate || 0
    modelData.total += (record.input || 0) + (record.output || 0) + (record.cacheRead || 0) + (record.cacheCreate || 0)
    modelData.count += 1
  }

  return aggregated
}

/**
 * 获取模型颜色
 * @param {string} model - 模型名
 * @returns {string}
 */
function getModelColor(model) {
  const normalized = (model || '').toLowerCase()

  if (MODEL_COLORS[normalized]) {
    return MODEL_COLORS[normalized]
  }

  for (const [key, color] of Object.entries(MODEL_COLORS)) {
    if (normalized.includes(key)) {
      return color
    }
  }

  return MODEL_COLORS.default
}

/**
 * 使用最大余数法计算百分比，确保总和为 100%
 * @param {Array<object>} models - 模型数组
 * @param {number} total - 总量
 * @returns {Array<object>}
 */
function calculatePercentagesWithLargestRemainder(models, total) {
  if (total === 0 || models.length === 0) {
    return models.map((model) => ({ ...model, percent: 0 }))
  }

  const withFraction = models.map((model) => {
    const exactPercent = (model.total / total) * 100
    const floorPercent = Math.floor(exactPercent)
    const fraction = exactPercent - floorPercent

    return {
      ...model,
      exactPercent,
      floorPercent,
      fraction
    }
  })

  let remaining = 100 - withFraction.reduce((sum, model) => sum + model.floorPercent, 0)

  const sortedByFraction = withFraction
    .map((model, index) => ({ ...model, originalIndex: index }))
    .sort((a, b) => b.fraction - a.fraction || b.total - a.total)

  for (let i = 0; i < remaining && i < sortedByFraction.length; i += 1) {
    sortedByFraction[i].floorPercent += 1
  }

  return sortedByFraction
    .sort((a, b) => a.originalIndex - b.originalIndex)
    .map((model) => ({
      ...model,
      percent: model.floorPercent
    }))
}

/**
 * 百分比显示文案
 * @param {number} percent - 百分比
 * @param {number} modelTotal - 模型总量
 * @param {number} grandTotal - 总量
 * @returns {string}
 */
function formatPercentDisplay(percent, modelTotal, grandTotal) {
  if (percent === 0 && modelTotal > 0 && grandTotal > 0) {
    return '<1%'
  }
  return `${percent}%`
}

/**
 * 从模型聚合 Map 生成展示数据
 * @param {Map<string, object>} aggregated - 模型聚合 Map
 * @returns {{total:number,input:number,output:number,cache:number,models:Array,distribution:Array,isExtremeScenario:boolean,modelCount:number}}
 */
function generateViewData(aggregated) {
  const nonZeroModels = Array.from(aggregated.values())
    .filter((model) => model.total > 0)

  const models = nonZeroModels
    .sort((a, b) => (b.total - a.total) || a.name.localeCompare(b.name))
    .map((model) => ({
      ...model,
      color: getModelColor(model.name)
    }))

  const total = models.reduce((sum, model) => sum + model.total, 0)
  const totalInput = models.reduce((sum, model) => sum + model.input, 0)
  const totalOutput = models.reduce((sum, model) => sum + model.output, 0)
  const totalCache = models.reduce((sum, model) => sum + model.cacheRead + model.cacheCreate, 0)

  const modelsWithPercent = calculatePercentagesWithLargestRemainder(models, total)

  const isExtremeScenario = models.length > 5
  let distribution = []

  if (!isExtremeScenario) {
    distribution = modelsWithPercent.map((model) => ({
      name: model.name,
      percent: model.percent,
      displayPercent: formatPercentDisplay(model.percent, model.total, total),
      color: model.color,
      key: model.name
    }))
  } else {
    const topModels = modelsWithPercent.slice(0, 5)
    const otherModels = modelsWithPercent.slice(5)

    distribution = topModels.map((model) => ({
      name: model.name,
      percent: model.percent,
      displayPercent: formatPercentDisplay(model.percent, model.total, total),
      color: model.color,
      key: model.name
    }))

    const othersTotal = otherModels.reduce((sum, model) => sum + model.total, 0)
    const othersPercent = othersTotal > 0
      ? 100 - topModels.reduce((sum, model) => sum + model.percent, 0)
      : 0

    if (otherModels.length > 0) {
      distribution.push({
        name: `其他 (${otherModels.length}个模型)`,
        percent: othersPercent,
        displayPercent: formatPercentDisplay(othersPercent, othersTotal, total),
        color: MODEL_COLORS.default,
        key: 'others'
      })
    }
  }

  return {
    total,
    input: totalInput,
    output: totalOutput,
    cache: totalCache,
    models,
    distribution,
    isExtremeScenario,
    modelCount: models.length
  }
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

    result[modelName] = {
      input,
      output,
      cacheRead,
      cacheCreate,
      total
    }
  }

  return result
}

/**
 * 归一化日汇总数据
 * @param {object} raw - 原始日汇总 JSON
 * @param {string} expectedDateKey - 期望日期 key
 * @returns {{date:string,generatedAt:string,models:Record<string, object>,summary:{total:number,input:number,output:number,cache:number}}|null}
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

  const total = Object.values(models).reduce((sum, model) => sum + model.total, 0)
  const input = Object.values(models).reduce((sum, model) => sum + model.input, 0)
  const output = Object.values(models).reduce((sum, model) => sum + model.output, 0)
  const cache = Object.values(models).reduce((sum, model) => sum + model.cacheRead + model.cacheCreate, 0)

  return {
    version: DAILY_SUMMARY_SCHEMA_VERSION,
    date,
    generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : new Date().toISOString(),
    models,
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
  const pathExistsFn = deps.pathExistsFn || pathExists
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
 * @param {Map<string, object>} aggregated - 聚合 Map
 * @param {Date} generatedAt - 生成时间
 * @returns {object}
 */
function buildDailySummary(dateKey, aggregated, generatedAt = new Date()) {
  const models = {}

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

  return buildDailySummary(dateKey, aggregated, deps.nowFn ? deps.nowFn() : new Date())
}

/**
 * 将日汇总列表合并为模型聚合 Map
 * @param {Array<object>} dailySummaries - 日汇总数组
 * @returns {Map<string, object>}
 */
function mergeDailySummaries(dailySummaries) {
  const aggregated = new Map()

  for (const dailySummary of dailySummaries) {
    for (const [modelName, modelData] of Object.entries(dailySummary.models || {})) {
      if (!aggregated.has(modelName)) {
        aggregated.set(modelName, {
          name: modelName,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheCreate: 0,
          total: 0,
          count: 0
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
  }

  return aggregated
}

/**
 * 处理 aggregate-usage-range IPC 请求
 * @param {{startDate?: string, endDate?: string, timezone?: string}} params - 请求参数
 * @param {{nowFn?: function, readDailySummaryFn?: function, writeDailySummaryFn?: function, recomputeDailySummaryFn?: function, scanLogFilesInRangeFn?: function, pathExistsFn?: function, readFileFn?: function, writeFileFn?: function, mkdirFn?: function, homeDir?: string}} [deps] - 依赖注入（测试用）
 * @returns {Promise<{success: boolean, data?: object, meta?: object, error?: string}>}
 */
async function handleAggregateUsageRange(params, deps = {}) {
  const now = deps.nowFn ? deps.nowFn() : new Date()

  const readDailySummaryFn = deps.readDailySummaryFn || readDailySummary
  const writeDailySummaryFn = deps.writeDailySummaryFn || writeDailySummary
  const recomputeDailySummaryFn = deps.recomputeDailySummaryFn || recomputeDailySummary

  const { startDate, endDate, timezone } = params || {}

  if (typeof startDate !== 'string' || typeof endDate !== 'string') {
    return { success: false, error: 'INVALID_DATE_RANGE' }
  }

  if (!isValidDateKey(startDate) || !isValidDateKey(endDate)) {
    return { success: false, error: 'INVALID_DATE_RANGE' }
  }

  if (startDate > endDate) {
    return { success: false, error: 'INVALID_DATE_RANGE' }
  }

  // 当前版本仅支持北京时间口径
  if (timezone && timezone !== 'Asia/Shanghai') {
    return { success: false, error: 'INVALID_TIMEZONE' }
  }

  const todayKey = getBeijingDayKey(now)
  if (endDate >= todayKey) {
    return { success: false, error: 'DATE_OUT_OF_RANGE' }
  }

  const dateRange = buildDateRange(startDate, endDate)

  let fromDailySummaryDays = 0
  let recomputedDays = 0
  let failedDays = 0
  let lastError = null

  const collectedSummaries = []

  for (const dateKey of dateRange) {
    let dailySummary = await readDailySummaryFn(dateKey, deps)

    if (dailySummary) {
      fromDailySummaryDays += 1
      collectedSummaries.push(dailySummary)
      continue
    }

    try {
      dailySummary = await recomputeDailySummaryFn(dateKey, deps)

      if (!dailySummary) {
        failedDays += 1
        lastError = 'RECOMPUTE_EMPTY'
        continue
      }

      recomputedDays += 1
      collectedSummaries.push(dailySummary)

      // 写盘失败不影响主流程，只影响后续缓存命中率
      try {
        await writeDailySummaryFn(dateKey, dailySummary, deps)
      } catch {
        // noop
      }
    } catch (error) {
      failedDays += 1
      lastError = error?.message || 'RECOMPUTE_FAILED'
    }
  }

  if (collectedSummaries.length === 0) {
    return {
      success: false,
      error: lastError || 'AGGREGATE_FAILED'
    }
  }

  const merged = mergeDailySummaries(collectedSummaries)
  const viewData = generateViewData(merged)

  return {
    success: true,
    data: {
      ...viewData,
      period: 'custom',
      startDate,
      endDate
    },
    meta: {
      fromDailySummaryDays,
      recomputedDays,
      totalDays: dateRange.length,
      failedDays
    }
  }
}

module.exports = {
  handleAggregateUsageRange
}
