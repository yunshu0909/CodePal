/**
 * 用量日志扫描与解析服务
 *
 * 负责：
 * - Claude / Codex 日志行解析
 * - 时间窗口内日志扫描与去重
 * - Codex session 增量计算
 *
 * @module electron/services/usageLogScanService
 */

const path = require('path')
const os = require('os')
const { scanLogFilesInRange } = require('../logScanner')

const CODEX_SESSION_ID_REGEX = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

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
        // Claude 同一 message.id 可能写入中间态与最终态，按"最新快照"保留才能避免重复累计
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

module.exports = {
  toSafeInt,
  normalizeModelName,
  parseClaudeLog,
  parseCodexTokenSnapshot,
  extractCodexSessionId,
  pickCodexMaxSnapshot,
  pickLatestClaudeRecord,
  scanClaudeLogs,
  scanCodexLogs,
  aggregateByModel,
  pathExists,
}
