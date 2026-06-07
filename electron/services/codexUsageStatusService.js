/**
 * Codex 会员额度状态服务
 *
 * 负责：
 * - 从 ~/.codex/sessions 的会话日志读取 Codex 最新 rate_limits（5 小时 / 7 天窗口）
 * - 把 Codex 原始字段归一化成与 Claude snapshot 完全相同的形状（前端组件零改动复用）
 * - 汇总前端展示所需的接入状态（ready / no_data / no_rate_limits / read_error）
 *
 * 与 Claude 的本质区别：Codex 零配置——CLI 自己把 rate_limits 写进 session 日志，
 * 本服务只被动读取，不安装脚本、不写任何文件、无 install/config/conflict 概念。
 *
 * @module electron/services/codexUsageStatusService
 */

const path = require('path')
const os = require('os')
const { scanLogFilesInRange } = require('../logScanner')
const { parseCodexRateLimits, pathExists } = require('./usageLogScanService')

// 取最新额度只需近几天日志：7 天窗口 + 1 天缓冲。
// 更早的会话即便有 rate_limits 也早已被官方重置，无展示意义。
const LOOKBACK_DAYS = 8
const LOOKBACK_MS = LOOKBACK_DAYS * 24 * 60 * 60 * 1000
// 按 mtime 倒序，最新会话一定在最前；近 8 天 200 个会话文件绰绰有余。
const MAX_FILES = 200
// rate_limits 在每次 token_count 都写，尾部 5000 行必含最新值。
const MAX_LINES_PER_FILE = 5000

// 满载率趋势回看窗口：Codex 是滚动 weekly（resets_at 持续漂移，无离散周期），
// 故按「自然周」聚合 secondary.used_percent 峰值。回看 ~13 周对齐 Claude MAX_COMPLETED_CYCLES。
const TREND_LOOKBACK_DAYS = 95
const MAX_TREND_WEEKS = 13

/**
 * 把额度百分比归一化为 [0,100] 整数；无效值返回 null。
 * 注意：0 是合法值（用量为 0），不能当 falsy 漏掉。
 * @param {unknown} value - 原始 used_percent
 * @returns {number|null}
 */
function clampPercentage(value) {
  // 显式 null/undefined 当无数据（注意 Number(null)===0，不能交给 Number 判，否则 null 会变 0%）
  if (value === null || value === undefined) return null
  const num = Number(value)
  if (!Number.isFinite(num)) return null
  return Math.max(0, Math.min(100, Math.round(num)))
}

/**
 * 归一化重置时间戳。Codex 的 resets_at 本就是 unix 秒整数，直接透传；
 * 缺失 / 0 / 负 / 非数一律 null（前端会显示「距重置 --」）。
 * @param {unknown} value - 原始 resets_at（unix 秒）
 * @returns {number|null}
 */
function toResetUnixSeconds(value) {
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) return null
  return Math.floor(num)
}

/**
 * 把 Codex rate_limits 原始结构归一化成 Claude-shape snapshot。
 * 字段名与 claudeUsageStatusService 的 snapshot 完全一致，前端 UsageRow 零改动复用。
 *
 * @param {object} rateLimits - payload.rate_limits（含 primary / secondary）
 * @param {Date|null} timestamp - 行级 timestamp（写入时刻，作为 updatedAt 来源）
 * @returns {{fiveHourUsedPercentage:number|null, sevenDayUsedPercentage:number|null, resetsAt:number|null, sevenDayResetsAt:number|null, updatedAt:number|null, hasRateLimits:boolean}}
 */
function normalizeCodexSnapshot(rateLimits, timestamp) {
  const primary = rateLimits && typeof rateLimits === 'object' ? rateLimits.primary : null
  const secondary = rateLimits && typeof rateLimits === 'object' ? rateLimits.secondary : null

  const fiveHourUsedPercentage = clampPercentage(primary?.used_percent)
  const sevenDayUsedPercentage = clampPercentage(secondary?.used_percent)

  // updatedAt 来自行级 timestamp（ISO 字符串 → unix 秒）；非法时间戳 → null（不触发 stale）
  const tsMs = timestamp instanceof Date ? timestamp.getTime() : NaN
  const updatedAt = Number.isFinite(tsMs) ? Math.floor(tsMs / 1000) : null

  return {
    fiveHourUsedPercentage,
    sevenDayUsedPercentage,
    resetsAt: toResetUnixSeconds(primary?.resets_at),
    sevenDayResetsAt: toResetUnixSeconds(secondary?.resets_at),
    updatedAt,
    // 至少一个窗口有有效百分比才算真的拿到了额度
    hasRateLimits: fiveHourUsedPercentage !== null || sevenDayUsedPercentage !== null
  }
}

/**
 * 扫描近 8 天 Codex 日志，取 timestamp 最新的一条有效 rate_limits 快照。
 *
 * @param {object} [deps] - 依赖注入（测试用）
 * @param {string} [deps.homeDir] - home 目录
 * @param {(p:string)=>Promise<boolean>} [deps.pathExistsFn] - 路径存在检查
 * @param {Function} [deps.scanLogFilesInRangeFn] - 日志扫描
 * @param {number} [deps.now] - 当前毫秒（测试固定时间）
 * @returns {Promise<{sessionsExist:boolean, hadFiles:boolean, snapshot:object|null}>}
 */
async function getLatestCodexRateLimits(deps = {}) {
  const homeDir = deps.homeDir || os.homedir()
  const pathExistsFn = deps.pathExistsFn || pathExists
  const scanFn = deps.scanLogFilesInRangeFn || scanLogFilesInRange
  const nowMs = typeof deps.now === 'number' ? deps.now : Date.now()

  const sessionsDir = path.join(homeDir, '.codex', 'sessions')
  if (!(await pathExistsFn(sessionsDir))) {
    return { sessionsExist: false, hadFiles: false, snapshot: null }
  }

  const start = new Date(nowMs - LOOKBACK_MS)
  const end = new Date(nowMs)
  const scanResult = await scanFn(sessionsDir, start, end, {
    maxFiles: MAX_FILES,
    maxLinesPerFile: MAX_LINES_PER_FILE
  })

  const files = scanResult?.files || []
  const hadFiles = files.length > 0

  // 取全局 timestamp 最大的有效快照（跨文件、跨行；不能只取某文件最后一行——并行会话会乱序）
  let latestSnapshot = null
  let latestTsMs = NaN

  for (const file of files) {
    for (const line of file.lines || []) {
      const parsed = parseCodexRateLimits(line)
      if (!parsed) continue
      const snapshot = normalizeCodexSnapshot(parsed.rateLimits, parsed.timestamp)
      if (!snapshot.hasRateLimits) continue

      const tsMs = parsed.timestamp instanceof Date ? parsed.timestamp.getTime() : NaN
      if (!latestSnapshot) {
        // 首条有效快照无条件作为兜底（即便 ts 无效）
        latestSnapshot = snapshot
        latestTsMs = tsMs
        continue
      }
      // 之后仅当 ts 更新（或现任兜底 ts 无效而新条有效）才替换
      if (Number.isFinite(tsMs) && (!Number.isFinite(latestTsMs) || tsMs > latestTsMs)) {
        latestSnapshot = snapshot
        latestTsMs = tsMs
      }
    }
  }

  return { sessionsExist: true, hadFiles, snapshot: latestSnapshot }
}

/**
 * 汇总前端展示所需的 Codex 会员额度状态。
 *
 * 状态机（简化版，无接入流程）：
 * - no_data：~/.codex/sessions 不存在，或近 8 天没有日志（没用过 / 很久没用 Codex）
 * - no_rate_limits：有近期日志但扫不到 rate_limits（API key 模式 / 非订阅 / 旧版 CLI）
 * - ready：拿到最新有效 rate_limits
 * - read_error：读取过程异常（IPC 层兜底）
 *
 * @param {object} [deps] - 依赖注入（测试用）
 * @returns {Promise<{success:boolean, integrationState:string, snapshot:object|null, sessionsPath:string, message:string, error?:string}>}
 */
async function getCodexUsageStatusState(deps = {}) {
  const homeDir = deps.homeDir || os.homedir()
  const sessionsPath = path.join(homeDir, '.codex', 'sessions')

  try {
    const { sessionsExist, hadFiles, snapshot } = await getLatestCodexRateLimits(deps)

    if (!sessionsExist || !hadFiles) {
      return {
        success: true,
        integrationState: 'no_data',
        snapshot: null,
        sessionsPath,
        message: '未检测到近期 Codex 使用记录。'
      }
    }

    if (!snapshot) {
      return {
        success: true,
        integrationState: 'no_rate_limits',
        snapshot: null,
        sessionsPath,
        message: 'Codex 未返回额度数据（可能是 API key 模式或非订阅账号）。'
      }
    }

    return {
      success: true,
      integrationState: 'ready',
      snapshot,
      sessionsPath,
      message: 'Codex 会员额度已读取。'
    }
  } catch (error) {
    return {
      success: false,
      integrationState: 'read_error',
      snapshot: null,
      sessionsPath,
      message: '读取 Codex 额度时出错。',
      error: error?.message || 'CODEX_USAGE_READ_FAILED'
    }
  }
}

/**
 * 求某毫秒时刻所在「自然周」的周一 00:00（本地时区）的 unix 秒
 * @param {number} ms - 毫秒时间戳
 * @returns {number} 周一 00:00 的 unix 秒
 */
function weekStartUnix(ms) {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  const dayFromMonday = (d.getDay() + 6) % 7 // 周一=0 … 周日=6
  d.setDate(d.getDate() - dayFromMonday)
  return Math.floor(d.getTime() / 1000)
}

/**
 * 重建 Codex 满载率趋势（按自然周聚合 7 天窗口 used_percent 峰值）。
 *
 * 为什么按自然周而非周期：Codex weekly 是滚动窗口，resets_at 持续漂移（实机本机扫出
 * 数百个不同 resets_at），没有 Claude 那种固定的「已完成周期」。改用自然周聚合峰值，
 * 得到稳定、可对比的「每周满载峰值」趋势。输出形状与 Claude history 一致（{currentCycle,
 * completedCycles}），前端可走同一套 classifyHistory + 渲染。
 *
 * @param {object} [deps] - 依赖注入（测试用）
 * @returns {Promise<{success:boolean, currentCycle:object|null, completedCycles:object[], error?:string}>}
 */
async function getCodexUsageTrend(deps = {}) {
  const homeDir = deps.homeDir || os.homedir()
  const pathExistsFn = deps.pathExistsFn || pathExists
  const scanFn = deps.scanLogFilesInRangeFn || scanLogFilesInRange
  const nowMs = typeof deps.now === 'number' ? deps.now : Date.now()
  const sessionsDir = path.join(homeDir, '.codex', 'sessions')

  try {
    if (!(await pathExistsFn(sessionsDir))) {
      return { success: true, currentCycle: null, completedCycles: [] }
    }

    const start = new Date(nowMs - TREND_LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
    const end = new Date(nowMs)
    const scanResult = await scanFn(sessionsDir, start, end, {
      maxFiles: 3000,
      maxLinesPerFile: 20000
    })

    // periodStart(周一 unix) -> 该周 secondary.used_percent 峰值
    const weekPeak = new Map()
    for (const file of scanResult?.files || []) {
      for (const line of file.lines || []) {
        const parsed = parseCodexRateLimits(line)
        if (!parsed?.timestamp) continue
        const tsMs = parsed.timestamp.getTime()
        if (!Number.isFinite(tsMs)) continue
        const used = Number(parsed.rateLimits?.secondary?.used_percent)
        if (!Number.isFinite(used)) continue
        const ws = weekStartUnix(tsMs)
        const prev = weekPeak.get(ws)
        if (prev === undefined || used > prev) weekPeak.set(ws, used)
      }
    }

    const nowSec = Math.floor(nowMs / 1000)
    const cycles = [...weekPeak.entries()].map(([periodStart, used]) => ({
      periodStart,
      periodEnd: periodStart + 7 * 86400,
      peakPercentage: clampPercentage(used)
    }))

    let currentCycle = null
    const completedCycles = []
    for (const cycle of cycles) {
      if (cycle.periodStart <= nowSec && nowSec < cycle.periodEnd) {
        currentCycle = cycle
      } else if (cycle.periodEnd <= nowSec) {
        completedCycles.push(cycle)
      }
    }
    completedCycles.sort((a, b) => b.periodEnd - a.periodEnd)

    return {
      success: true,
      currentCycle,
      completedCycles: completedCycles.slice(0, MAX_TREND_WEEKS)
    }
  } catch (error) {
    return { success: false, currentCycle: null, completedCycles: [], error: error?.message || 'CODEX_TREND_FAILED' }
  }
}

/**
 * 工厂：创建 Codex 会员额度状态服务（与 claudeUsageStatusService 的依赖注入风格一致）
 * @param {object} [deps] - 依赖注入
 * @param {(p:string)=>Promise<boolean>} [deps.pathExists] - 路径存在检查
 * @returns {{getCodexUsageStatusState: () => Promise<object>}}
 */
function createCodexUsageStatusService({ pathExists: injectedPathExists } = {}) {
  const deps = injectedPathExists ? { pathExistsFn: injectedPathExists } : {}
  return {
    getCodexUsageStatusState: () => getCodexUsageStatusState(deps),
    getCodexUsageTrend: () => getCodexUsageTrend(deps)
  }
}

module.exports = {
  createCodexUsageStatusService,
  getCodexUsageStatusState,
  getCodexUsageTrend,
  getLatestCodexRateLimits,
  normalizeCodexSnapshot,
  clampPercentage,
  toResetUnixSeconds,
  weekStartUnix,
  LOOKBACK_DAYS
}
