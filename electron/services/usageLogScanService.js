/**
 * 用量日志扫描与解析服务
 *
 * 负责：
 * - Claude / Codex 日志行解析
 * - DSH 会话日志（zstd 多帧容器）扫描与用量归属
 * - 时间窗口内日志扫描与去重
 * - Codex session 增量计算
 *
 * @module electron/services/usageLogScanService
 */

const path = require('path')
const os = require('os')
const { scanLogFilesInRange, readClaudeUsageLines } = require('../logScanner')

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
  const scanOptions = deps.claudeLegacyWholeFileRead === true ? undefined : { claudeUsageOnly: true }
  const scanResult = await scanLogFilesInRangeFn(claudeBasePath, start, end, scanOptions)
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
  const result = await scanLogFilesInRangeFn(codexBasePath, start, end, { codexUsageOnly: true })
  const { collectCodexUsageRecords } = await import('./codexUsageRecords.mjs')
  return collectCodexUsageRecords(result.files, start, end)
}

/** DSH 会话日志文件名（两代格式） */
const DSH_LOG_NAME_REGEX = /^session(?:\.v\d+)?\.jsonl\.zstd$/i

/**
 * DSH 日志时间范围索引：path → { mtimeMs, sizeBytes, createdAtMs }
 *
 * 逐日重算（累计至今会走 100+ 天）时，每天都要判断"哪些日志可能落在这天"。
 * 只按 mtime 下界筛的话，历史每一天都会命中全部日志并整份读取；
 * 这里按 header 的 createdAt 补一个上界，并把结果缓存下来，避免重复读首帧。
 */
const dshLogIndex = new Map()

/** 索引条目上限，超过即整体重建，避免长期运行时无界增长 */
const DSH_LOG_INDEX_MAX_ENTRIES = 5000

/** zstdFrames 模块只加载一次 */
let dshZstdModulePromise = null

/** zstdFrames 的同步句柄（Node 24 起支持 require(ESM)） */
let dshZstdModuleSync = null

/** dshUsageRecords 的同步句柄 */
let dshRecordsModuleSync = null

/**
 * 同步加载 zstdFrames 模块
 *
 * 扫描主路径要求同步消费行序列（逐帧产出），因此优先用 require(ESM)。
 * @returns {object} 模块导出
 */
function requireZstdModuleSync() {
  if (!dshZstdModuleSync) {
    dshZstdModuleSync = require('./zstdFrames.mjs')
  }
  return dshZstdModuleSync
}

/**
 * 同步加载 dshUsageRecords 模块
 * @returns {object} 模块导出
 */
function requireDshRecordsModuleSync() {
  if (!dshRecordsModuleSync) {
    dshRecordsModuleSync = require('./dshUsageRecords.mjs')
  }
  return dshRecordsModuleSync
}

/**
 * 懒加载 DSH zstd 解压模块（ESM）
 * @returns {Promise<object>}
 */
function loadDshZstdModule() {
  if (!dshZstdModulePromise) {
    dshZstdModulePromise = import('./zstdFrames.mjs')
  }
  return dshZstdModulePromise
}

/**
 * 取会话日志的创建时刻（只解首帧 header），带缓存
 *
 * 用于判断"这个日志是否可能含窗口内事件"：createdAt 是事件时间的安全下界。
 * 读不到时返回 null，调用方按"可能包含"处理（宁可多读不可漏算）。
 *
 * @param {string} filePath - 日志路径
 * @param {number} sizeBytes - 文件大小（缓存键的一部分）
 * @param {number} mtimeMs - 修改时间毫秒（缓存键的一部分）
 * @param {object} [deps] - 依赖注入
 * @returns {number|null} 创建时刻毫秒
 */
function readDshCreatedAt(filePath, sizeBytes, mtimeMs, deps = {}) {
  const cached = dshLogIndex.get(filePath)
  if (cached && cached.mtimeMs === mtimeMs && cached.sizeBytes === sizeBytes) {
    return cached.createdAtMs
  }

  // 索引只增不减会随会话数长期增长；超过上限时整体丢弃重建（成本仅一次首帧读取）
  if (dshLogIndex.size > DSH_LOG_INDEX_MAX_ENTRIES) {
    dshLogIndex.clear()
  }

  let createdAtMs = null

  try {
    const readFileFn = deps.readFileFn || require('fs').readFileSync
    const firstFrameFn = deps.decompressFirstFrameFn || requireZstdModuleSync().decompressFirstFrame
    const headerLine = String(firstFrameFn(readFileFn(filePath))).split('\n').find((line) => line.trim())

    if (headerLine) {
      const createdAt = Number(JSON.parse(headerLine)?.createdAt)
      if (Number.isFinite(createdAt)) createdAtMs = createdAt
    }
  } catch {
    createdAtMs = null
  }

  dshLogIndex.set(filePath, { mtimeMs, sizeBytes, createdAtMs })
  return createdAtMs
}

/**
 * 递归列出可能与窗口重叠的 DSH 会话日志
 *
 * 重叠判据（两端都是安全边界，不会漏算）：
 * - 文件最后写入时间 < 窗口起点 → 不可能含窗口内事件
 * - 会话创建时间 ≥ 窗口结束 → 不可能含窗口内事件
 *
 * @param {string} basePath - ~/.dsh/sessions
 * @param {Date} startTime - 窗口起点
 * @param {Date} [endTime] - 窗口终点
 * @param {object} [deps] - 依赖注入
 * @returns {Promise<Array<{path: string, mtime: Date}>>}
 */
async function listDshSessionLogs(basePath, startTime, endTime, deps = {}) {
  const fs = deps.fsPromises || require('fs/promises')
  const maxDepth = typeof deps.maxDepth === 'number' ? deps.maxDepth : 6
  const candidates = []

  /**
   * @param {string} currentPath - 当前目录
   * @param {number} depth - 当前深度
   * @returns {Promise<void>}
   */
  async function walk(currentPath, depth) {
    if (depth > maxDepth) return

    let entries
    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name)

      if (entry.isDirectory()) {
        await walk(fullPath, depth + 1)
        continue
      }

      if (!entry.isFile() || !DSH_LOG_NAME_REGEX.test(entry.name)) continue

      try {
        const stat = await fs.stat(fullPath)
        candidates.push({ path: fullPath, mtime: stat.mtime, sizeBytes: stat.size })
      } catch {
        // 单文件 stat 失败静默跳过
      }
    }
  }

  await walk(basePath, 0)

  const startMs = startTime instanceof Date ? startTime.getTime() : Number.NEGATIVE_INFINITY
  const endMs = endTime instanceof Date ? endTime.getTime() : Number.POSITIVE_INFINITY
  const found = []

  for (const candidate of candidates) {
    const mtimeMs = candidate.mtime.getTime()
    if (mtimeMs < startMs) continue

    const createdAtMs = readDshCreatedAt(candidate.path, candidate.sizeBytes, mtimeMs, deps)
    if (createdAtMs !== null && createdAtMs >= endMs) continue

    found.push({ path: candidate.path, mtime: candidate.mtime })
  }

  return found
}

/**
 * 同步读取 DSH 日志的压缩字节
 *
 * 先读后解：读失败要立刻抛出（由调用方按文件粒度跳过），不能藏在惰性生成器里。
 * 压缩体只有 MB 级，可以整份持有；真正大的是解压后的正文，那部分才需要逐帧流式。
 *
 * @param {string} filePath - 日志路径
 * @param {object} [deps] - 依赖注入（测试用；`readFileFn` 必须同步返回 Buffer）
 * @returns {Buffer} 压缩字节
 */
function readDshBufferSync(filePath, deps = {}) {
  const readFileFn = deps.readFileFn || require('fs').readFileSync
  const raw = readFileFn(filePath)

  if (!Buffer.isBuffer(raw)) {
    throw new TypeError('DSH 日志读取必须同步返回 Buffer')
  }

  return raw
}

/**
 * 逐帧解压并产出非空行
 *
 * 峰值内存只与单帧相关；跨帧保留半行残片，避免把一行的 JSON 切断。
 *
 * @param {Buffer} buffer - 压缩字节
 * @param {object} [deps] - 依赖注入
 * @returns {Generator<string>} 非空行
 */
function* iterateDshLines(buffer, deps = {}) {
  const iterateFn = deps.iterateFramesFn || requireZstdModuleSync().iterateZstdFrames

  // pending 保存上一帧末尾那段"还没有换行"的半行，必须拼到下一帧首段，
  // 否则帧边界落在行中间时该行会整条丢失（用量静默漏计）。
  let pending = ''

  for (const frame of iterateFn(buffer)) {
    const parts = String(frame).split('\n')
    parts[0] = pending + parts[0]
    pending = parts.pop() ?? ''

    for (const part of parts) {
      if (part.trim()) yield part
    }
  }

  if (pending.trim()) yield pending
}

/**
 * 扫描 DSH 会话日志并提取用量记录
 *
 * DSH 是第三个来源：任何异常都 fail-soft 返回空数组，绝不能拖垮既有 Claude/Codex 统计。
 * 单个文件损坏或残帧只跳过该文件，其余文件照常计入。
 *
 * @param {Date} start - 窗口开始（含）
 * @param {Date} end - 窗口结束（不含）
 * @param {object} [deps] - 依赖注入（测试用）
 * @returns {Promise<Array<object>>} 用量记录；失败时为空数组
 */
/** 隔离进程执行器；由主进程启动时注入 */
let dshIsolatedRunner = null

/**
 * 注入隔离进程执行器（主进程启动时调用一次）
 * @param {((start: Date, end: Date) => Promise<Array<object>>)|null} runner - 执行器
 */
function setDshIsolatedRunner(runner) {
  dshIsolatedRunner = typeof runner === 'function' ? runner : null
}

/**
 * 扫描 DSH 会话日志并提取用量记录
 *
 * 生产默认走**隔离进程**：本机实测「重日重算之后紧接着做原生 zstd 解压」会让 Electron
 * 原生层 SIGTRAP（JS 无法捕获）。隔离后子进程崩溃不再拖垮主进程，只是本次窗口降级为无 DSH 数据。
 * 未注入执行器时（单元测试）走进程内实现。
 *
 * @param {Date} start - 窗口开始（含）
 * @param {Date} end - 窗口结束（不含）
 * @param {object} [deps] - 依赖注入（测试用）
 * @returns {Promise<Array<object>>} 用量记录；失败时为空数组
 */
async function scanDshLogs(start, end, deps = {}) {
  if (dshIsolatedRunner && deps.useDshIsolation !== false) {
    try {
      return await dshIsolatedRunner(start, end)
    } catch {
      return []
    }
  }

  return scanDshLogsInProcess(start, end, deps)
}

/**
 * 进程内扫描实现（worker 内部与单元测试使用）
 * @param {Date} start - 窗口开始（含）
 * @param {Date} end - 窗口结束（不含）
 * @param {object} [deps] - 依赖注入（测试用）
 * @returns {Promise<Array<object>>} 用量记录；失败时为空数组
 */
async function scanDshLogsInProcess(start, end, deps = {}) {
  try {
    const pathExistsFn = deps.pathExistsFn || pathExists
    const homeDir = deps.homeDir || os.homedir()
    const listFn = deps.listDshSessionLogsFn || listDshSessionLogs

    const basePath = path.join(homeDir, '.dsh', 'sessions')
    if (!(await pathExistsFn(basePath))) return []

    const listed = await listFn(basePath, start, end, deps)
    // 下界预筛在扫描层再兜一次，避免自定义列实现漏筛
    const eligible = (listed || []).filter((item) => {
      if (!item?.path) return false
      if (item.mtime instanceof Date && item.mtime < start) return false
      return true
    })
    if (eligible.length === 0) return []

    const dshModule = requireDshRecordsModuleSync()
    const collectFn = deps.collectRecordsFn || dshModule.collectDshUsageRecords

    // 逐文件、逐帧处理：读一个、解一帧、解析一帧、立刻释放。
    // 峰值内存只与单帧相关，不会把几十 MB 会话正文同时压在内存里。
    const selected = dshModule.selectHighestGenerationFiles(eligible)
    const records = []
    let failedFiles = 0

    for (const item of selected) {
      try {
        // 先读（立即暴露错误），再逐帧交给解析器消费
        const buffer = readDshBufferSync(item.path, deps)
        const lines = iterateDshLines(buffer, deps)
        for (const record of collectFn([{ path: item.path, lines }], start, end) || []) {
          records.push(record)
        }
      } catch {
        // 单文件读取/解压失败静默跳过
        failedFiles += 1
      }

      // 文件之间让出事件循环：逐帧流式已把单文件峰值压到帧级，
      // 但一个窗口要连续解压几十个文件；让出后 GC 有机会回收，避免原生解压在高水位下崩溃。
      await new Promise((resolve) => setImmediate(resolve))
    }

    // 与 Claude 截断同款：降级留痕但不阻断。
    // 否则「日志全读失败」与「确实没有 DSH 用量」对用户完全无法区分。
    if (failedFiles > 0) {
      console.warn(`DSH usage scan degraded: ${failedFiles}/${selected.length} log files unreadable`)
    }

    return records
  } catch {
    return []
  }
}

/**
 * 找 DSH 日志中最早的日期（北京时区）
 *
 * 会话 header（含 createdAt）是文件第一行、也是第一帧，因此只解首帧即可，
 * 不必为探测起点解压全部会话正文。
 *
 * @param {string} dshBasePath - ~/.dsh/sessions
 * @param {object} [deps] - 依赖注入（测试用）
 * @returns {Promise<string|null>} YYYY-MM-DD 或 null
 */
async function findEarliestDshDate(dshBasePath, deps = {}) {
  const listFn = deps.listDshSessionLogsFn || listDshSessionLogs
  const readFileFn = deps.readFileFn || require('fs/promises').readFile
  const decompressFirstFrameFn = deps.decompressFirstFrameFn
    || (await loadDshZstdModule()).decompressFirstFrame

  const listed = await listFn(dshBasePath, new Date(0), undefined, deps)
  let earliest = null

  for (const item of listed || []) {
    try {
      const raw = await readFileFn(item.path)
      const headerLine = String(decompressFirstFrameFn(raw)).split('\n').find((line) => line.trim())
      if (!headerLine) continue

      const header = JSON.parse(headerLine)
      const createdAt = Number(header?.createdAt)
      if (Number.isFinite(createdAt) && (earliest === null || createdAt < earliest)) {
        earliest = createdAt
      }
    } catch {
      // 单文件失败跳过，不影响其余候选
    }
  }

  return earliest === null ? null : toBeijingDateKey(new Date(earliest))
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

/**
 * 找 Claude/Codex 日志中最早的日期（北京时区）。
 * 用于「累计至今」周期的动态起点，避免对新装机用户从 2020-01-01 空扫几千天。
 * @param {object} [deps] - 依赖注入（测试用）
 * @returns {Promise<string|null>} YYYY-MM-DD 或 null（两边都没数据）
 */
async function findEarliestLogDate(deps = {}) {
  const pathExistsFn = deps.pathExistsFn || pathExists
  const homeDir = deps.homeDir || os.homedir()
  const findClaudeFn = deps.findEarliestClaudeDateFn || findEarliestClaudeDate
  const findCodexFn = deps.findEarliestCodexDateFn || findEarliestCodexDate
  const findDshFn = deps.findEarliestDshDateFn || findEarliestDshDate

  const claudeBasePath = path.join(homeDir, '.claude', 'projects')
  const codexBasePath = path.join(homeDir, '.codex', 'sessions')
  const dshBasePath = path.join(homeDir, '.dsh', 'sessions')

  const [claudeExists, codexExists, dshExists] = await Promise.all([
    pathExistsFn(claudeBasePath),
    pathExistsFn(codexBasePath),
    pathExistsFn(dshBasePath)
  ])

  const [claudeDate, codexDate, dshDate] = await Promise.all([
    claudeExists ? findClaudeFn(claudeBasePath, deps).catch(() => null) : Promise.resolve(null),
    codexExists ? findCodexFn(codexBasePath, deps).catch(() => null) : Promise.resolve(null),
    dshExists ? findDshFn(dshBasePath, deps).catch(() => null) : Promise.resolve(null)
  ])

  // DSH 进不了起点探测，它早于另外两源的用量就会被累计至今静默漏算
  const dates = [claudeDate, codexDate, dshDate].filter(Boolean)
  if (dates.length === 0) return null
  return dates.reduce((earliest, current) => (current < earliest ? current : earliest))
}

module.exports = {
  toSafeInt,
  normalizeModelName,
  parseClaudeLog,
  parseCodexTokenSnapshot,
  parseCodexRateLimits,
  extractCodexSessionId,
  pickCodexMaxSnapshot,
  pickLatestClaudeRecord,
  scanClaudeLogs,
  scanCodexLogs,
  aggregateByModel,
  aggregateByProject,
  pathExists,
  toBeijingDateKey,
  findFirstCodexUsageTimestampInFile,
  findEarliestCodexDate,
  findFirstClaudeTimestampInFile,
  listJsonlFilesRecursive,
  findEarliestClaudeDate,
  scanDshLogs,
  scanDshLogsInProcess,
  setDshIsolatedRunner,
  readClaudeUsageLines,
  listDshSessionLogs,
  iterateDshLines,
  findEarliestDshDate,
  findEarliestLogDate,
}
