/**
 * 日志扫描模块
 *
 * 负责：
 * - 递归收集指定目录下的 `.jsonl` 日志文件
 * - 按文件修改时间做下界预筛，减少无关旧文件读取
 * - 按修改时间倒序读取并限制文件数/行数，避免大目录拖垮进程
 *
 * @module electron/logScanner
 */

const fs = require('fs/promises')
const path = require('path')
const { createReadStream } = require('fs')
const readline = require('readline')
const { StringDecoder } = require('string_decoder')

/**
 * 流式提取 Codex 计量证据，不让正文和工具输出滞留或跨 IPC 传输。
 * @param {string} filePath - JSONL 文件
 * @returns {Promise<string[]>} 保持原顺序的精简事件
 */
async function readCodexUsageLines(filePath) {
  const stream = createReadStream(filePath, { encoding: 'utf-8' })
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity })
  const lines = []
  try {
    for await (const line of reader) {
      let data
      try { data = JSON.parse(line) } catch { continue }
      if (!data || typeof data !== 'object') continue
      const payload = data.payload
      let event
      if (data.type === 'turn_context') {
        event = { type: data.type, payload: { model: payload?.model, cwd: payload?.cwd } }
      } else if (data.type === 'session_meta') {
        event = { type: data.type, payload: { forked_from_id: payload?.forked_from_id } }
      } else if (data.type === 'event_msg' && payload?.type === 'token_count' && payload.info?.total_token_usage) {
        const usage = payload.info.total_token_usage
        event = { type: data.type, timestamp: data.timestamp, payload: { type: 'token_count', info: { total_token_usage: {
          input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, cached_input_tokens: usage.cached_input_tokens, total_tokens: usage.total_tokens,
        } } } }
      }
      if (event) lines.push(JSON.stringify(event))
    }
    return lines
  } finally {
    reader.close()
    stream.destroy()
  }
}

/**
 * 流式提取 Claude 用量行（不整份读文件）
 *
 * 语义与旧实现（`fs.readFile` 全文 → split('\n') → 过滤空行 → 取**末尾 N 行** → 逐行 parse）
 * **完全等价**，但不再把整份日志读成字符串常驻内存（本机单文件最大 115MB，三源并行时是
 * 内存峰值的主因）。要点：
 *
 * - 环形缓冲**按「非空行」占槽**，而不是按「用量行」占槽。否则"末尾 N 行里没有用量行"
 *   的情况下会把本应被裁掉的旧用量行多算出来 —— 那是行为漂移，不是优化。
 * - 不含 `"usage"` 字样的行不可能是用量行（`parseClaudeLog` 必返回 null），直接跳过，
 *   省掉 `JSON.parse`；这只是必要条件预筛，不改变结果。
 * - 只保留用量必要字段，逐行紧凑化，内存量级由"末尾 N 行"决定，与文件总大小无关。
 *
 * @param {string} filePath - JSONL 文件
 * @param {number} maxLinesPerFile - 保留末尾多少个非空行；<=0 视为不保留
 * @returns {Promise<string[]>} 紧凑化后的用量行（保持原顺序）
 */
async function readClaudeUsageLines(filePath, maxLinesPerFile) {
  const stream = createReadStream(filePath)
  const decoder = new StringDecoder('utf8')

  const limit = maxLinesPerFile > 0 ? maxLinesPerFile : 0
  const ring = limit > 0 ? new Array(limit).fill(null) : null
  let nonEmptyCount = 0
  let pending = ''

  /**
   * 与旧实现 `content.split('\n').filter(line => line.trim())` **逐行等价**：
   * - 只按 LF 分行。不要用 readline：它把裸 CR 也当行边界，而 JSON 字段之间的
   *   CR 是合法空白，按 readline 会把一条完整记录拆坏（旧实现不会）。
   * - 不做 `"usage"` 子串预筛。子串匹配不是「含 usage 字段」的必要条件——
   *   键写成 `"us\u0061ge"` 时 JSON.parse 仍得到 usage，但子串不中，
   *   预筛会静默丢掉这条合法记录。正确性优先于这点 CPU。
   */
  function handleLine(raw) {
    if (!raw.trim()) return

    const index = nonEmptyCount
    nonEmptyCount += 1

    let compact = null
    try {
      const data = JSON.parse(raw)
      const message = data?.message
      if (message?.usage) {
        compact = JSON.stringify({
          timestamp: data.timestamp || message.timestamp || null,
          cwd: typeof data.cwd === 'string' ? data.cwd : null,
          message: {
            id: typeof message.id === 'string' ? message.id : null,
            model: message.model,
            usage: message.usage,
          },
        })
      }
    } catch {
      compact = null
    }

    if (ring) ring[index % limit] = compact
  }

  try {
    for await (const chunk of stream) {
      pending += decoder.write(chunk)
      let index
      while ((index = pending.indexOf('\n')) >= 0) {
        handleLine(pending.slice(0, index))
        pending = pending.slice(index + 1)
      }
    }
    pending += decoder.end()
    if (pending !== '') handleLine(pending)
  } finally {
    stream.destroy()
  }

  if (!ring) return []

  // 环形缓冲此刻正好覆盖末尾 min(总非空行数, limit) 行，按时间顺序回放
  const keep = Math.min(nonEmptyCount, limit)
  const kept = []
  for (let index = nonEmptyCount - keep; index < nonEmptyCount; index += 1) {
    const line = ring[index % limit]
    if (line) kept.push(line)
  }
  return kept
}

/**
 * 扫描并读取可能包含时间窗口记录的日志文件
 * @param {string} basePath - 扫描根目录（已展开）
 * @param {Date} startTime - 开始时间（包含）
 * @param {Date} endTime - 结束时间（不包含）
 * @param {{maxFiles?: number, maxLinesPerFile?: number, maxDepth?: number, codexUsageOnly?: boolean, claudeUsageOnly?: boolean}} [options] - 扫描选项
 * @returns {Promise<{files: Array<{path: string, lines: string[], mtime: string}>, totalMatched: number, scannedCount: number, truncated: boolean}>}
 */
async function scanLogFilesInRange(basePath, startTime, endTime, options = {}) {
  const maxFiles = typeof options.maxFiles === 'number' ? options.maxFiles : 5000
  const candidates = await enumerateLogCandidates(basePath, startTime, options)
  const selectedCandidates = candidates.slice(0, maxFiles)

  const files = await readSelectedCandidates(selectedCandidates, options)

  return {
    files,
    totalMatched: candidates.length,
    scannedCount: selectedCandidates.length,
    truncated: candidates.length > maxFiles
  }
}

/**
 * 枚举窗口内可能的日志候选文件（**只做目录遍历与 stat，不读文件内容**）
 *
 * 与旧实现共享同一套筛选口径：递归收集 `*.jsonl`、**只做 mtime 下界预筛**（不能做上界，
 * 因为会话文件可能在窗口结束后的次日继续写入，窗口内真正的裁剪交给逐行 timestamp），
 * 然后按 mtime 倒序 —— 这个顺序决定了 `maxFiles` 截断选中哪些文件。
 *
 * @param {string} basePath - 扫描根目录（已展开）
 * @param {Date} startTime - 下界（含）
 * @param {{maxDepth?: number}} [options] - 扫描选项
 * @returns {Promise<Array<{path: string, mtime: Date}>>} 已按 mtime 倒序的候选
 */
async function enumerateLogCandidates(basePath, startTime, options = {}) {
  const maxDepth = typeof options.maxDepth === 'number' ? options.maxDepth : 10
  const candidates = []

  async function collect(currentPath, depth = 0) {
    if (depth > maxDepth) return
    try {
      const entries = await fs.readdir(currentPath, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry.name)
        if (entry.isDirectory()) {
          await collect(fullPath, depth + 1)
          continue
        }
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
        try {
          const stat = await fs.stat(fullPath)
          if (stat.mtime < startTime) continue
          candidates.push({ path: fullPath, mtime: stat.mtime })
        } catch {
          // 单文件 stat 失败时静默跳过
        }
      }
    } catch {
      // 目录不可读/不存在时静默跳过
    }
  }

  await collect(basePath, 0)
  // 优先读取最近更新的文件，避免截断时随机漏算
  candidates.sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
  return candidates
}

/**
 * 读取已选中的候选文件，产出与旧实现同形的 `{path, lines, mtime}` 列表
 *
 * 逐工具语义保持原样：Codex 保留完整事件链、Claude 只取末尾 N 个非空行、其余走整份读 + 末尾截断。
 * 单文件读取失败静默跳过，不影响整体统计。
 *
 * @param {Array<{path: string, mtime: Date}>} selectedCandidates - 已截断的选中文件
 * @param {object} [options] - 扫描选项
 * @returns {Promise<Array<{path: string, lines: string[], mtime: string}>>}
 */
async function readSelectedCandidates(selectedCandidates, options = {}) {
  const maxLinesPerFile = typeof options.maxLinesPerFile === 'number' ? options.maxLinesPerFile : 10000
  const files = []

  for (const candidate of selectedCandidates) {
    try {
      const lines = await readCandidateLines(candidate, options)
      files.push({ path: candidate.path, lines, mtime: candidate.mtime.toISOString() })
    } catch {
      // 单文件读取失败时静默跳过，避免影响整体统计
    }
  }

  return files
}

/**
 * 读取单个候选文件的行（按选项选择逐工具读取方式）
 * @param {{path: string}} candidate - 候选文件
 * @param {object} [options] - 扫描选项
 * @returns {Promise<string[]>}
 */
async function readCandidateLines(candidate, options = {}) {
  const maxLinesPerFile = typeof options.maxLinesPerFile === 'number' ? options.maxLinesPerFile : 10000

  if (options.codexUsageOnly === true) {
    // 计量需要完整事件链，但不需要保留完整对话正文。
    return readCodexUsageLines(candidate.path)
  }
  if (options.claudeUsageOnly === true) {
    // Claude 计量只需要末尾 N 行里的用量字段：流式读取，避免整份日志驻留内存。
    return readClaudeUsageLines(candidate.path, maxLinesPerFile)
  }
  const content = await fs.readFile(candidate.path, 'utf-8')
  const lines = content.split('\n').filter(line => line.trim())
  if (maxLinesPerFile <= 0) return []
  return lines.length <= maxLinesPerFile ? lines : lines.slice(-maxLinesPerFile)
}

/**
 * 创建「每个查询窗口只枚举一次、每个文件最多解析一次」的扫描上下文
 *
 * 存在意义：区间聚合原本逐日调用 `scanLogFilesInRange`，170 天要做 510 次目录遍历，
 * 同一批文件也被反复解析。本上下文把这两件事各收敛到「每窗口一次」。
 *
 * **零行为变化的两个关键点**：
 * 1. 每天的候选集由**同一份枚举结果按天重建**：`mtime >= 当天起点` → 取前 `maxFiles`。
 *    枚举结果本身已按 mtime 倒序，`filter` 保持顺序，因此与逐日独立遍历的选中集合**逐条相同**。
 * 2. **读取可以共用，归属不能共用**：解析结果按文件记忆、跨天复用，但某一天的记录只来自
 *    「该文件属于那一天候选集」的那些文件。否则 mtime 落在前一天、内容含后一天事件的文件，
 *    会把事件错误地计入后一天（旧实现因 mtime 下界本就不含它）。
 *
 * @param {Date} windowStart - 整个查询区间的起点（用于一次性枚举）
 * @returns {{scanForDay: (basePath: string, dayStart: Date, options?: object) => Promise<object>, stats: () => object}}
 */
function createLogScanWindowContext(windowStart) {
  const enumerationCache = new Map()
  const readCache = new Map()
  // 通用 memo：服务层用它按 (文件, mtime) 缓存「解析后的记录/事件」，
  // 消掉同一次查询里每天重复 JSON.parse 的 CPU（读取已经只做一次）。
  const memo = new Map()

  function optionsKey(options = {}) {
    return [
      options.maxFiles ?? 5000,
      options.maxLinesPerFile ?? 10000,
      options.maxDepth ?? 10,
      options.codexUsageOnly === true ? 'codex' : (options.claudeUsageOnly === true ? 'claude' : 'raw')
    ].join('|')
  }

  function enumerate(basePath, options) {
    const key = `${basePath}|${optionsKey(options)}`
    if (!enumerationCache.has(key)) {
      enumerationCache.set(key, enumerateLogCandidates(basePath, windowStart, options))
    }
    return enumerationCache.get(key)
  }

  function readOnce(candidate, options) {
    const key = `${candidate.path}|${candidate.mtime.getTime()}|${optionsKey(options)}`
    if (!readCache.has(key)) {
      // 失败也记忆（记为 null），与旧实现「该文件在所有天都被跳过」一致
      readCache.set(key, Promise.resolve()
        .then(() => readCandidateLines(candidate, options))
        .catch(() => null))
    }
    return readCache.get(key)
  }

  return {
    async scanForDay(basePath, dayStart, options = {}) {
      const maxFiles = typeof options.maxFiles === 'number' ? options.maxFiles : 5000
      const all = await enumerate(basePath, options)
      const inDay = all.filter((candidate) => candidate.mtime.getTime() >= dayStart.getTime())
      const selected = inDay.slice(0, maxFiles)
      const files = []

      for (const candidate of selected) {
        const lines = await readOnce(candidate, options)
        if (lines === null) continue
        files.push({ path: candidate.path, lines, mtime: candidate.mtime.toISOString() })
      }

      return {
        files,
        totalMatched: inDay.length,
        scannedCount: selected.length,
        truncated: inDay.length > maxFiles
      }
    },

    memo,

    stats() {
      return { enumerated: enumerationCache.size, parsedFiles: readCache.size, memoized: memo.size }
    }
  }
}

module.exports = {
  scanLogFilesInRange,
  enumerateLogCandidates,
  readCandidateLines,
  createLogScanWindowContext,
  readClaudeUsageLines
}
