/**
 * 用量日志扫描 · dsh
 *
 * 负责：DSH 会话日志（zstd 多帧容器）：文件索引、逐帧读行、独立进程扫描入口、最早用量日期探测
 *
 * 由 usageLogScanService 统一对外导出（B2-8 按数据源拆分，行为不变）。
 *
 * @module electron/services/usageLogScan/dsh
 */
const path = require('path')
const os = require('os')
const { pathExists, toBeijingDateKey } = require('./common')

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
    dshZstdModuleSync = require('../zstdFrames.mjs')
  }
  return dshZstdModuleSync
}

/**
 * 同步加载 dshUsageRecords 模块
 * @returns {object} 模块导出
 */
function requireDshRecordsModuleSync() {
  if (!dshRecordsModuleSync) {
    dshRecordsModuleSync = require('../dshUsageRecords.mjs')
  }
  return dshRecordsModuleSync
}

/**
 * 懒加载 DSH zstd 解压模块（ESM）
 * @returns {Promise<object>}
 */
function loadDshZstdModule() {
  if (!dshZstdModulePromise) {
    dshZstdModulePromise = import('../zstdFrames.mjs')
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
      return await (deps.strictScan ? dshIsolatedRunner(start, end, {strictScan:true}) : dshIsolatedRunner(start, end))
    } catch (error) {
      if (deps.strictScan) throw error
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
      if (deps.strictScan) throw new Error('DSH_LOG_FILES_UNREADABLE')
      console.warn(`DSH usage scan degraded: ${failedFiles}/${selected.length} log files unreadable`)
    }

    return records
  } catch (error) {
    if (deps.strictScan) throw error
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

module.exports = {
  listDshSessionLogs,
  iterateDshLines,
  setDshIsolatedRunner,
  scanDshLogs,
  scanDshLogsInProcess,
  findEarliestDshDate,
}
