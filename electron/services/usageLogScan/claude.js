/**
 * 用量日志扫描 · claude
 *
 * 负责：Claude Code 日志：行解析、窗口扫描与去重、最早用量日期探测
 *
 * 由 usageLogScanService 统一对外导出（B2-8 按数据源拆分，行为不变）。
 *
 * @module electron/services/usageLogScan/claude
 */
const path = require('path')
const os = require('os')
const { scanLogFilesInRange } = require('../../logScanner')
const { extractProjectNameFromCwd, listJsonlFilesRecursive, normalizeModelName, pathExists, toBeijingDateKey, toSafeInt } = require('./common')

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

  // 审计开关：置 true 时走"整份读文件"的旧路径，仅用于新旧实现对账（不是生产路径）
  const scanOptions = deps.claudeLegacyWholeFileRead === true ? undefined : { claudeUsageOnly: true, ...(deps.strictScan ? {strictScan:true} : {}) }
  // 注入窗口上下文时走「每窗口枚举一次 + 每文件解析一次」；按天重建候选集，语义与逐日独立遍历逐条相同
  const scanResult = deps.windowContext
    ? await deps.windowContext.scanForDay(claudeBasePath, start, scanOptions || {})
    : await scanLogFilesInRangeFn(claudeBasePath, start, end, scanOptions)
  // 同一文件在同一次查询里只解析一次 JSON（跨天复用）；每天只做「窗口裁剪 + messageId 去重」。
  // 解析结果按「文件顺序 + 行号」保存，因此 streamOrder 的推进顺序与逐日独立解析完全一致。
  const memo = deps.windowContext?.memo
  const parsedFiles = []

  for (const file of scanResult.files || []) {
    const cacheKey = `claude:${file.path}|${file.mtime}`
    let parsed = memo?.get(cacheKey)

    if (!parsed) {
      parsed = []
      const lines = file.lines || []
      for (let index = 0; index < lines.length; index += 1) {
        const record = parseClaudeLog(lines[index])
        if (!record?.timestamp) continue
        record.project = extractProjectNameFromCwd(record.cwdPath) || extractProjectNameFromClaudePath(file.path) || '未知项目'
        parsed.push({ record, index })
      }
      memo?.set(cacheKey, parsed)
    }

    parsedFiles.push({ file, parsed })
  }

  const latestByMessage = new Map()
  let streamOrder = 0

  for (const { file, parsed } of parsedFiles) {
    for (const { record, index } of parsed) {
      if (record.timestamp >= start && record.timestamp < end) {
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
 * 在文件流中按行读取，找到第一条带 timestamp 的 Claude 记录就返回。
 * @param {string} filePath - 日志文件路径
 * @param {object} deps - 依赖注入
 * @returns {Promise<Date|null>}
 */
async function findFirstClaudeTimestampInFile(filePath, deps = {}) {
  const fsSync = deps.fsSync || require('fs')
  const readline = deps.readline || require('readline')

  return new Promise((resolve) => {
    let resolved = false
    let stream
    try {
      stream = fsSync.createReadStream(filePath, { encoding: 'utf-8' })
    } catch {
      resolve(null)
      return
    }

    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })

    const finish = (value) => {
      if (resolved) return
      resolved = true
      rl.close()
      stream.destroy()
      resolve(value)
    }

    rl.on('line', (line) => {
      const record = parseClaudeLog(line)
      // parseClaudeLog 只在有 message.usage 时才返回；
      // 早期 config 行（permission-mode 等）不会命中，正是我们想跳过的
      if (record?.timestamp && !Number.isNaN(record.timestamp.getTime())) {
        finish(record.timestamp)
      }
    })

    rl.on('close', () => finish(null))
    rl.on('error', () => finish(null))
    stream.on('error', () => finish(null))
  })
}

/**
 * 找 Claude 日志最早日期。
 * 策略：按 mtime 升序遍历所有 jsonl 文件，读首条带 timestamp 的记录，取最小值。
 * 不用 mtime 当锚点：rsync / Time Machine / touch 都会让 mtime 失真，
 *   但记录内 timestamp 是写入时的真值，更可靠。
 * 不限制采样数：早期文件可能全是 config-only（无 usage 记录），
 *   截断 K 个会让函数返回 null 即使后面有数据。
 *   每个文件 readline 命中首条 timestamp 即停，单文件成本通常 < 几 KB，全量扫描可控。
 * @param {string} claudeBasePath - ~/.claude/projects
 * @param {object} deps - 依赖注入
 * @returns {Promise<string|null>} YYYY-MM-DD（北京时间）或 null
 */
async function findEarliestClaudeDate(claudeBasePath, deps = {}) {
  const fs = deps.fsPromises || require('fs/promises')
  const listFiles = deps.listJsonlFilesRecursiveFn || listJsonlFilesRecursive
  const findFirstTs = deps.findFirstClaudeTimestampInFileFn || findFirstClaudeTimestampInFile

  const files = await listFiles(claudeBasePath, deps)
  if (files.length === 0) return null

  const stated = []
  for (const file of files) {
    try {
      const st = await fs.stat(file)
      stated.push({ file, mtimeMs: st.mtimeMs })
    } catch {
      // 单个 stat 失败不影响整体
    }
  }

  stated.sort((a, b) => a.mtimeMs - b.mtimeMs)

  let earliest = null
  for (const { file } of stated) {
    const ts = await findFirstTs(file, deps)
    if (ts && (!earliest || ts < earliest)) {
      earliest = ts
    }
  }

  return earliest ? toBeijingDateKey(earliest) : null
}

module.exports = {
  parseClaudeLog,
  pickLatestClaudeRecord,
  scanClaudeLogs,
  findFirstClaudeTimestampInFile,
  findEarliestClaudeDate,
}
