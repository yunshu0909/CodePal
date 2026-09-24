/**
 * 用量日志扫描 · codex
 *
 * 负责：Codex 日志：token 快照 / 限额解析、session 增量扫描、最早用量日期探测
 *
 * 由 usageLogScanService 统一对外导出（B2-8 按数据源拆分，行为不变）。
 *
 * @module electron/services/usageLogScan/codex
 */
const path = require('path')
const os = require('os')
const { scanLogFilesInRange } = require('../../logScanner')
const { pathExists, toBeijingDateKey, toSafeInt } = require('./common')

const CODEX_SESSION_ID_REGEX = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

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
 * 解析 Codex rate_limits 快照行
 *
 * rate_limits 只出现在 event_msg / token_count 行的 payload.rate_limits 里。
 * 必须 JSON.parse 后判结构（payload.rate_limits 为对象），不能用字符串预筛——
 * 对话正文里也可能出现 "rate_limits" 文本，字符串匹配会误命中。
 *
 * @param {string} line - JSONL 行
 * @returns {{timestamp: Date|null, rateLimits: object}|null} 非额度行/解析失败返回 null
 */
function parseCodexRateLimits(line) {
  try {
    const data = JSON.parse(line)

    if (data.type !== 'event_msg' || data.payload?.type !== 'token_count') {
      return null
    }

    const rateLimits = data.payload.rate_limits
    if (!rateLimits || typeof rateLimits !== 'object') {
      return null
    }

    return {
      timestamp: data.timestamp ? new Date(data.timestamp) : null,
      rateLimits
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
 * 扫描完整 Codex 日志，按用量事件所属模型和日期计量。
 * @param {Date} start - 窗口开始（含）
 * @param {Date} end - 窗口结束（不含）
 * @param {object} deps - 测试依赖
 * @returns {Promise<Array<object>>} 逐事件记录
 */
async function scanCodexLogs(start, end, deps = {}) {
  const pathExistsFn = deps.pathExistsFn || pathExists
  const scanLogFilesInRangeFn = deps.scanLogFilesInRangeFn || scanLogFilesInRange
  const codexBasePath = path.join(deps.homeDir || os.homedir(), '.codex', 'sessions')
  if (!(await pathExistsFn(codexBasePath))) return []
  // 模型上下文和窗口前基线可能在文件开头，不能只读最后 10000 行。
  const codexOptions = { codexUsageOnly: true, ...(deps.strictScan ? {strictScan:true} : {}) }
  const result = deps.windowContext
    ? await deps.windowContext.scanForDay(codexBasePath, start, codexOptions)
    : await scanLogFilesInRangeFn(codexBasePath, start, end, codexOptions)

  // 逐行 JSON.parse 的结果按文件缓存（跨天复用）。Codex 的收集本身是有状态的顺序算法
  // （跨文件累计高水位），不能按文件分解，因此只省解析、不省重放。
  const memo = deps.windowContext?.memo
  if (memo) {
    for (const file of result.files || []) {
      const cacheKey = `codex:${file.path}|${file.mtime}`
      if (!memo.has(cacheKey)) {
        memo.set(cacheKey, (file.lines || []).map((line) => {
          try { return JSON.parse(line) } catch { return null }
        }))
      }
      file.events = memo.get(cacheKey)
    }
  }

  const { collectCodexUsageRecords } = await import('../codexUsageRecords.mjs')
  return collectCodexUsageRecords(result.files, start, end)
}

/**
 * 在 Codex 文件中找到第一条有实际用量的 token_count 时间戳。
 * 空文件、只有配置/正文的残留文件以及 totalTokens=0 的初始化快照都不算使用记录。
 * @param {string} filePath - Codex JSONL 文件
 * @param {object} deps - 依赖注入
 * @returns {Promise<Date|null>}
 */
async function findFirstCodexUsageTimestampInFile(filePath, deps = {}) {
  const readFileFn = deps.readFileFn || deps.fsPromises?.readFile

  // 单测和小文件诊断可注入 readFile；生产默认走流式读取，避免把大 session 全载入内存。
  if (typeof readFileFn === 'function') {
    try {
      const content = await readFileFn(filePath, 'utf-8')
      for (const line of String(content).split('\n')) {
        const snapshot = parseCodexTokenSnapshot(line)
        if (
          snapshot?.timestamp
          && !Number.isNaN(snapshot.timestamp.getTime())
          && snapshot.totalTokens > 0
        ) {
          return snapshot.timestamp
        }
      }
    } catch {
      return null
    }
    return null
  }

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
      const snapshot = parseCodexTokenSnapshot(line)
      if (
        snapshot?.timestamp
        && !Number.isNaN(snapshot.timestamp.getTime())
        && snapshot.totalTokens > 0
      ) {
        finish(snapshot.timestamp)
      }
    })
    rl.on('close', () => finish(null))
    rl.on('error', () => finish(null))
    stream.on('error', () => finish(null))
  })
}

/**
 * Codex 目录按 YYYY/MM/DD 分层，但目录和 JSONL 可能只是空残留。
 * 三层升序遍历，并以文件内第一条有效 token_count 为准；没有用量则继续下一天。
 * @param {string} codexBasePath - ~/.codex/sessions
 * @param {object} deps - 依赖注入
 * @returns {Promise<string|null>} YYYY-MM-DD（北京时间）或 null
 */
async function findEarliestCodexDate(codexBasePath, deps = {}) {
  const fs = deps.fsPromises || require('fs/promises')
  const findFirstUsageTs = deps.findFirstCodexUsageTimestampInFileFn || findFirstCodexUsageTimestampInFile

  async function listSortedSubdirs(dirPath, validator) {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true })
      return entries
        .filter((entry) => entry.isDirectory() && validator(entry.name))
        .map((entry) => entry.name)
        .sort()
    } catch {
      return []
    }
  }

  async function listJsonlFiles(dirPath) {
    try {
      const entries = await fs.readdir(dirPath)
      return entries
        .filter((name) => name.endsWith('.jsonl'))
        .sort()
        .map((name) => path.join(dirPath, name))
    } catch {
      return []
    }
  }

  const isYear = (name) => /^\d{4}$/.test(name)
  const isMonthOrDay = (name) => /^\d{2}$/.test(name)

  const years = await listSortedSubdirs(codexBasePath, isYear)
  for (const year of years) {
    const months = await listSortedSubdirs(path.join(codexBasePath, year), isMonthOrDay)
    for (const month of months) {
      const days = await listSortedSubdirs(path.join(codexBasePath, year, month), isMonthOrDay)
      for (const day of days) {
        const dayPath = path.join(codexBasePath, year, month, day)
        const files = await listJsonlFiles(dayPath)
        let earliestInDay = null

        for (const file of files) {
          const timestamp = await findFirstUsageTs(file, deps).catch(() => null)
          if (timestamp && (!earliestInDay || timestamp < earliestInDay)) {
            earliestInDay = timestamp
          }
        }

        if (earliestInDay) {
          return toBeijingDateKey(earliestInDay)
        }
      }
    }
  }
  return null
}

module.exports = {
  parseCodexTokenSnapshot,
  parseCodexRateLimits,
  extractCodexSessionId,
  pickCodexMaxSnapshot,
  scanCodexLogs,
  findFirstCodexUsageTimestampInFile,
  findEarliestCodexDate,
}
