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

  // Claude 完整格式：claude-{tier}-{major}-{minor}[-datestring]
  const claudeMatch = model.match(/^claude-([a-z]+)-(\d+)-(\d+)(?:-\d{8,})?$/i)
  if (claudeMatch) {
    const tier = claudeMatch[1].charAt(0).toUpperCase() + claudeMatch[1].slice(1).toLowerCase()
    return `Claude ${tier} ${claudeMatch[2]}.${claudeMatch[3]}`
  }

  // 非 Claude 模型：保留原始名称
  return model
}

/**
 * 从 Claude 归档目录路径中提取项目名
 * 仅作为旧日志缺失 cwd 时的兜底策略。
 * @param {string} filePath - 日志文件路径
 * @returns {string|null}
 */
function extractProjectNameFromClaudePath(filePath) {
  if (!filePath || typeof filePath !== 'string') return null

  try {
    const normalized = filePath.replace(/\\/g, '/')
    const projectsIdx = normalized.indexOf('projects/')
    if (projectsIdx === -1) return null

    const afterProjects = normalized.substring(projectsIdx + 'projects/'.length)
    const projectDir = afterProjects.split('/')[0]
    if (!projectDir) return null

    const segments = projectDir.split('-').filter(Boolean)
    if (segments.length === 0) return null

    return segments[segments.length - 1]
  } catch {
    return null
  }
}

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
 * 解析 Claude 日志行
 * @param {string} line - JSONL 行
 * @returns {{timestamp: Date|null, model: string, messageId: string|null, cwdPath: string|null, input: number, output: number, cacheRead: number, cacheCreate: number}|null}
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
      cwdPath: typeof data.cwd === 'string' ? data.cwd : null,
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
        record.project = extractProjectNameFromCwd(record.cwdPath) || extractProjectNameFromClaudePath(file.path) || '未知项目'
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

// Codex 子 agent（subagent）回放检测阈值：
// 子 agent 启动时会回放父对话历史，产生密集的 token 快照（数百个快照在 <1 秒内完成）。
// 5 秒足够覆盖任意长度的回放，同时不会误吞真正的新工作（新工作快照间隔通常 > 5 秒）。
const CODEX_REPLAY_WINDOW_MS = 5000

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
    const state = sessionSnapshots.get(sessionId) || {
      beforeWindow: null,
      inWindow: null,
      model: null,
      cwd: null,
      forkedFromId: null,
      firstSnapshotTs: null,
      replayBaseline: null
    }

    for (const line of file.lines || []) {
      try {
        const parsed = JSON.parse(line)
        if (parsed.type === 'turn_context' && parsed.payload) {
          if (parsed.payload.model) {
            state.model = parsed.payload.model
          }
          if (parsed.payload.cwd) {
            state.cwd = parsed.payload.cwd
          }
        }
        // 检测子 agent：session_meta 中带 forked_from_id 表示从父 session fork 而来
        if (parsed.type === 'session_meta' && parsed.payload?.forked_from_id) {
          state.forkedFromId = parsed.payload.forked_from_id
        }
      } catch { /* ignore */ }

      const snapshot = parseCodexTokenSnapshot(line)
      if (!snapshot?.timestamp) continue

      // 记录首个快照时间戳，用于回放阶段检测
      if (!state.firstSnapshotTs) {
        state.firstSnapshotTs = snapshot.timestamp
      }

      if (snapshot.timestamp < start) {
        state.beforeWindow = pickCodexMaxSnapshot(state.beforeWindow, snapshot)
        continue
      }

      if (snapshot.timestamp >= start && snapshot.timestamp < end) {
        state.inWindow = pickCodexMaxSnapshot(state.inWindow, snapshot)

        // 子 agent 回放阶段：首个快照后 5 秒内的快照属于父对话历史回放，
        // 其累计值包含已在父 session 中统计过的 token，不应重复计入。
        if (state.forkedFromId && state.firstSnapshotTs &&
            (snapshot.timestamp.getTime() - state.firstSnapshotTs.getTime()) < CODEX_REPLAY_WINDOW_MS) {
          state.replayBaseline = pickCodexMaxSnapshot(state.replayBaseline, snapshot)
        }
      }
    }

    sessionSnapshots.set(sessionId, state)
  }

  const records = []

  for (const state of sessionSnapshots.values()) {
    if (!state.inWindow) continue

    // 子 agent 用回放基线作为起点，只计新工作增量；普通 session 用窗口前快照或零值
    const before = (state.forkedFromId && state.replayBaseline)
      ? state.replayBaseline
      : state.beforeWindow || {
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
      model: state.model || 'codex',
      project: extractProjectNameFromCwd(state.cwd) || '未知项目',
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
  aggregateByProject,
  pathExists,
}
