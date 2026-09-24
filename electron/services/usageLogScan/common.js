/**
 * 用量日志扫描 · common
 *
 * 负责：各数据源共用的小工具：路径检查、整数归一、模型名归一、项目名、按模型 / 项目聚合、北京日期、递归列 jsonl
 *
 * 由 usageLogScanService 统一对外导出（B2-8 按数据源拆分，行为不变）。
 *
 * @module electron/services/usageLogScan/common
 */
const path = require('path')

/**
 * 检查路径是否存在
 * @param {string} filepath - 目标路径
 * @returns {Promise<boolean>}
 */
async function pathExists(filepath) {
  const fs = require('fs/promises')
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
 * 标准化模型名称
 *
 * 实现在 modelAlias.mjs，与渲染进程共用同一份正则（此前两处各持一份，缺 minor
 * 的型号如 claude-opus-5 会漏格式化成原始 id）。
 * @param {string} model - 原始模型名
 * @returns {string}
 */
function normalizeModelName(model) {
  if (!modelAliasModule) {
    modelAliasModule = require('../modelAlias.mjs')
  }
  return modelAliasModule.normalizeClaudeModelName(model)
}

/** modelAlias 模块懒加载缓存（require(esm) 不需要在模块顶层执行） */
let modelAliasModule = null

/**
 * 从真实工作目录中提取项目名
 * 优先识别 `/trae_projects/<project>` 这类工作区根目录，避免把子目录误识别成项目名。
 * @param {string|null|undefined} cwdPath - 当前工作目录
 * @returns {string|null}
 */
function extractProjectNameFromCwd(cwdPath) {
  if (!cwdPath || typeof cwdPath !== 'string') return null

  try {
    const normalized = cwdPath
      .replace(/\\/g, '/')
      .replace(/\/+$/, '')

    const workspaceMarker = '/trae_projects/'
    const workspaceIdx = normalized.indexOf(workspaceMarker)
    if (workspaceIdx !== -1) {
      const afterWorkspace = normalized.substring(workspaceIdx + workspaceMarker.length)
      const projectDir = afterWorkspace.split('/')[0]
      if (projectDir) {
        return projectDir
      }
    }

    const segments = normalized.split('/').filter(Boolean)
    if (segments.length === 0) return null

    return segments[segments.length - 1]
  } catch {
    return null
  }
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
        input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0, count: 0
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
 * 按项目聚合记录
 * @param {Array<object>} records - 原始记录
 * @returns {Map<string, {name: string, value: number}>}
 */
function aggregateByProject(records) {
  const aggregated = new Map()

  for (const record of records) {
    const projectName = record.project || '未知项目'
    const current = aggregated.get(projectName) || { name: projectName, value: 0 }
    current.value += (record.input || 0) + (record.output || 0) + (record.cacheRead || 0) + (record.cacheCreate || 0)
    aggregated.set(projectName, current)
  }

  return aggregated
}

/**
 * 把 Date 转成北京时间日期 key（YYYY-MM-DD）。
 * 就地实现避免与 usageDateRangeAggregationService 循环依赖。
 * @param {Date} date - 时间
 * @returns {string|null}
 */
function toBeijingDateKey(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return null
  }

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
  return `${map.year}-${map.month}-${map.day}`
}

/**
 * 递归列出目录下所有 .jsonl 文件路径
 * @param {string} dir - 起始目录
 * @param {object} deps - 依赖注入
 * @returns {Promise<string[]>}
 */
async function listJsonlFilesRecursive(dir, deps = {}) {
  const fs = deps.fsPromises || require('fs/promises')
  const result = []

  async function walk(current) {
    let entries
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        result.push(full)
      }
    }
  }

  await walk(dir)
  return result
}

module.exports = {
  pathExists,
  toSafeInt,
  normalizeModelName,
  extractProjectNameFromCwd,
  aggregateByModel,
  aggregateByProject,
  toBeijingDateKey,
  listJsonlFilesRecursive,
}
