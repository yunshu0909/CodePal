/**
 * V1.10.0 Codex 会员额度状态服务后端行为测试
 *
 * 负责：
 * - 校验 parseCodexRateLimits 只认 token_count 行、不被对话正文里的 "rate_limits" 文本误命中
 * - 校验归一化（字段名与 Claude snapshot 一致、resets_at 透传 unix、百分比 clamp、0% 不漏）
 * - 校验扫描取最新（乱序 / 多文件取全局 timestamp max）
 * - 校验状态机（no_data / no_rate_limits / ready / read_error）
 *
 * 设计：服务支持依赖注入（homeDir / pathExistsFn / scanLogFilesInRangeFn / now），
 * 直接注入伪日志，无需切 HOME 或读真实磁盘。
 *
 * @module 自动化测试/V1.10.0/tests/backend/codexUsageStatusService.behavior.test
 */

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'

const require = createRequire(import.meta.url)
const {
  normalizeCodexSnapshot,
  clampPercentage,
  toResetUnixSeconds,
  getLatestCodexRateLimits,
  getCodexUsageStatusState,
  getCodexUsageTrend,
  weekStartUnix,
} = require('../../../../electron/services/codexUsageStatusService')
const { parseCodexRateLimits } = require('../../../../electron/services/usageLogScanService')

const NOW_MS = Date.parse('2026-06-07T16:00:00.000Z')

/**
 * 造一条 Codex token_count 日志行（可带/不带 rate_limits）
 * @param {object} opts
 * @returns {string}
 */
function tokenCountLine({ ts = '2026-06-07T15:59:00.000Z', primary, secondary, withRateLimits = true } = {}) {
  const payload = { type: 'token_count', info: { total_token_usage: { total_tokens: 100 } } }
  if (withRateLimits) {
    payload.rate_limits = {}
    if (primary !== undefined) payload.rate_limits.primary = primary
    if (secondary !== undefined) payload.rate_limits.secondary = secondary
  }
  return JSON.stringify({ type: 'event_msg', timestamp: ts, payload })
}

/** 标准 primary（5h）窗口对象 */
const PRIMARY = { used_percent: 26, window_minutes: 300, resets_at: 1780834330 }
/** 标准 secondary（7d）窗口对象 */
const SECONDARY = { used_percent: 41, window_minutes: 10080, resets_at: 1781147614 }

/** 伪 scanLogFilesInRange：返回给定 files */
function fakeScan(files) {
  return async () => ({ files, totalMatched: files.length, scannedCount: files.length, truncated: false })
}

const baseDeps = {
  homeDir: '/tmp/fake-home',
  pathExistsFn: async () => true,
  now: NOW_MS,
}

describe('parseCodexRateLimits', () => {
  it('解析正常 token_count + rate_limits 行', () => {
    const r = parseCodexRateLimits(tokenCountLine({ primary: PRIMARY, secondary: SECONDARY }))
    expect(r).not.toBeNull()
    expect(r.rateLimits.primary.used_percent).toBe(26)
    expect(r.timestamp instanceof Date).toBe(true)
  })

  it('非 event_msg 行 → null', () => {
    expect(parseCodexRateLimits(JSON.stringify({ type: 'turn_context', payload: {} }))).toBeNull()
  })

  it('event_msg 但非 token_count → null', () => {
    expect(parseCodexRateLimits(JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message' } }))).toBeNull()
  })

  it('token_count 但无 rate_limits → null', () => {
    expect(parseCodexRateLimits(tokenCountLine({ withRateLimits: false }))).toBeNull()
  })

  it('rate_limits 非对象 → null', () => {
    expect(parseCodexRateLimits(JSON.stringify({ type: 'event_msg', timestamp: '2026-06-07T00:00:00Z', payload: { type: 'token_count', rate_limits: 'oops' } }))).toBeNull()
  })

  it('JSON 损坏 → null', () => {
    expect(parseCodexRateLimits('{ broken json')).toBeNull()
  })

  it('对话正文里出现 "rate_limits" 字符串但不是 token_count 事件 → null（边界⑧）', () => {
    const chatLine = JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', content: '我刚分析了 rate_limits 的结构，primary/secondary 都有 used_percent' },
    })
    expect(parseCodexRateLimits(chatLine)).toBeNull()
  })
})

describe('clampPercentage', () => {
  it('小数四舍五入', () => expect(clampPercentage(26.7)).toBe(27))
  it('0 是合法值不漏（边界⑩）', () => expect(clampPercentage(0)).toBe(0))
  it('超 100 截断（边界⑪）', () => expect(clampPercentage(105)).toBe(100))
  it('负数截到 0', () => expect(clampPercentage(-5)).toBe(0))
  it('非数 → null（边界⑫）', () => expect(clampPercentage('abc')).toBeNull())
  it('null → null', () => expect(clampPercentage(null)).toBeNull())
})

describe('toResetUnixSeconds', () => {
  it('正常 unix 秒透传（边界:resets_at 是 int）', () => expect(toResetUnixSeconds(1780834330)).toBe(1780834330))
  it('小数 floor', () => expect(toResetUnixSeconds(1780834330.9)).toBe(1780834330))
  it('0 → null（边界⑬）', () => expect(toResetUnixSeconds(0)).toBeNull())
  it('负 → null', () => expect(toResetUnixSeconds(-1)).toBeNull())
  it('非数 → null', () => expect(toResetUnixSeconds('abc')).toBeNull())
})

describe('normalizeCodexSnapshot', () => {
  it('字段名与 Claude snapshot 一致 + resets_at 透传 + updatedAt ISO→unix', () => {
    const ts = new Date('2026-06-07T15:59:00.000Z')
    const snap = normalizeCodexSnapshot({ primary: PRIMARY, secondary: SECONDARY }, ts)
    expect(snap).toEqual({
      fiveHourUsedPercentage: 26,
      sevenDayUsedPercentage: 41,
      resetsAt: 1780834330,
      sevenDayResetsAt: 1781147614,
      updatedAt: Math.floor(ts.getTime() / 1000),
      hasRateLimits: true,
    })
  })

  it('缺 primary → fiveHour null（边界⑨）', () => {
    const snap = normalizeCodexSnapshot({ secondary: SECONDARY }, new Date('2026-06-07T00:00:00Z'))
    expect(snap.fiveHourUsedPercentage).toBeNull()
    expect(snap.sevenDayUsedPercentage).toBe(41)
    expect(snap.hasRateLimits).toBe(true)
  })

  it('两窗全缺 → hasRateLimits false（边界⑨）', () => {
    const snap = normalizeCodexSnapshot({}, new Date('2026-06-07T00:00:00Z'))
    expect(snap.hasRateLimits).toBe(false)
  })

  it('used_percent=0 → hasRateLimits true（0 不漏）', () => {
    const snap = normalizeCodexSnapshot({ primary: { used_percent: 0, resets_at: 1780834330 } }, new Date('2026-06-07T00:00:00Z'))
    expect(snap.fiveHourUsedPercentage).toBe(0)
    expect(snap.hasRateLimits).toBe(true)
  })

  it('Invalid Date → updatedAt null（边界⑮）', () => {
    const snap = normalizeCodexSnapshot({ primary: PRIMARY }, new Date('not-a-date'))
    expect(snap.updatedAt).toBeNull()
  })
})

describe('getLatestCodexRateLimits 取最新', () => {
  it('sessions 不存在 → sessionsExist false', async () => {
    const r = await getLatestCodexRateLimits({ ...baseDeps, pathExistsFn: async () => false })
    expect(r.sessionsExist).toBe(false)
    expect(r.snapshot).toBeNull()
  })

  it('空 files → hadFiles false', async () => {
    const r = await getLatestCodexRateLimits({ ...baseDeps, scanLogFilesInRangeFn: fakeScan([]) })
    expect(r.hadFiles).toBe(false)
    expect(r.snapshot).toBeNull()
  })

  it('有 token_count 无 rate_limits → hadFiles true 但 snapshot null', async () => {
    const files = [{ path: 'a.jsonl', mtime: '', lines: [tokenCountLine({ withRateLimits: false })] }]
    const r = await getLatestCodexRateLimits({ ...baseDeps, scanLogFilesInRangeFn: fakeScan(files) })
    expect(r.hadFiles).toBe(true)
    expect(r.snapshot).toBeNull()
  })

  it('多行乱序 → 取 timestamp 最大（边界⑰）', async () => {
    const older = tokenCountLine({ ts: '2026-06-07T10:00:00Z', primary: { used_percent: 10, resets_at: 1 }, secondary: SECONDARY })
    const newer = tokenCountLine({ ts: '2026-06-07T15:00:00Z', primary: { used_percent: 88, resets_at: 2 }, secondary: SECONDARY })
    // 故意把更新的放前面，验证不是"取最后一行"而是"取 timestamp 最大"
    const files = [{ path: 'a.jsonl', mtime: '', lines: [newer, older] }]
    const r = await getLatestCodexRateLimits({ ...baseDeps, scanLogFilesInRangeFn: fakeScan(files) })
    expect(r.snapshot.fiveHourUsedPercentage).toBe(88)
  })

  it('多文件 → 取全局 timestamp 最大（边界⑱）', async () => {
    const fileA = { path: 'a.jsonl', mtime: '', lines: [tokenCountLine({ ts: '2026-06-07T09:00:00Z', primary: { used_percent: 12, resets_at: 1 } })] }
    const fileB = { path: 'b.jsonl', mtime: '', lines: [tokenCountLine({ ts: '2026-06-07T14:30:00Z', primary: { used_percent: 55, resets_at: 2 } })] }
    const r = await getLatestCodexRateLimits({ ...baseDeps, scanLogFilesInRangeFn: fakeScan([fileA, fileB]) })
    expect(r.snapshot.fiveHourUsedPercentage).toBe(55)
  })
})

describe('getCodexUsageStatusState 状态机', () => {
  it('sessions 不存在 → no_data（边界①）', async () => {
    const r = await getCodexUsageStatusState({ ...baseDeps, pathExistsFn: async () => false })
    expect(r.success).toBe(true)
    expect(r.integrationState).toBe('no_data')
    expect(r.snapshot).toBeNull()
  })

  it('近 8 天无日志 → no_data（边界②）', async () => {
    const r = await getCodexUsageStatusState({ ...baseDeps, scanLogFilesInRangeFn: fakeScan([]) })
    expect(r.integrationState).toBe('no_data')
  })

  it('有日志但无 rate_limits → no_rate_limits（边界③）', async () => {
    const files = [{ path: 'a.jsonl', mtime: '', lines: [tokenCountLine({ withRateLimits: false })] }]
    const r = await getCodexUsageStatusState({ ...baseDeps, scanLogFilesInRangeFn: fakeScan(files) })
    expect(r.integrationState).toBe('no_rate_limits')
  })

  it('有 rate_limits → ready + 归一化 snapshot', async () => {
    const files = [{ path: 'a.jsonl', mtime: '', lines: [tokenCountLine({ primary: PRIMARY, secondary: SECONDARY })] }]
    const r = await getCodexUsageStatusState({ ...baseDeps, scanLogFilesInRangeFn: fakeScan(files) })
    expect(r.integrationState).toBe('ready')
    expect(r.snapshot.fiveHourUsedPercentage).toBe(26)
    expect(r.snapshot.sevenDayUsedPercentage).toBe(41)
    expect(r.snapshot.resetsAt).toBe(1780834330)
  })

  it('扫描抛错 → read_error（success false，边界:IPC 兜底）', async () => {
    const throwingScan = async () => { throw new Error('EACCES') }
    const r = await getCodexUsageStatusState({ ...baseDeps, scanLogFilesInRangeFn: throwingScan })
    expect(r.success).toBe(false)
    expect(r.integrationState).toBe('read_error')
  })
})

describe('weekStartUnix', () => {
  it('返回所在周的周一 00:00（本地时区）', () => {
    const ws = weekStartUnix(Date.parse('2026-06-03T12:00:00'))
    const d = new Date(ws * 1000)
    expect(d.getDay()).toBe(1) // 周一
    expect(d.getHours()).toBe(0)
    expect(d.getMinutes()).toBe(0)
    expect(d.getSeconds()).toBe(0)
  })

  it('对周一零点幂等', () => {
    const ws = weekStartUnix(Date.parse('2026-06-03T12:00:00'))
    expect(weekStartUnix(ws * 1000)).toBe(ws)
  })
})

describe('getCodexUsageTrend 自然周聚合', () => {
  const NOW = Date.parse('2026-06-03T12:00:00') // 周中，避免跨周边界

  /** 造一条带 secondary.used_percent 的 token_count 行 */
  function trendLine(tsMs, used) {
    return JSON.stringify({
      type: 'event_msg',
      timestamp: new Date(tsMs).toISOString(),
      payload: { type: 'token_count', info: { total_token_usage: {} }, rate_limits: { secondary: { used_percent: used, window_minutes: 10080, resets_at: 1 } } },
    })
  }

  function depsWith(lines) {
    return {
      homeDir: '/tmp/fake-home',
      pathExistsFn: async () => true,
      now: NOW,
      scanLogFilesInRangeFn: async () => ({ files: [{ path: 'a.jsonl', mtime: '', lines }], totalMatched: 1, scannedCount: 1, truncated: false }),
    }
  }

  it('sessions 不存在 → 空趋势', async () => {
    const r = await getCodexUsageTrend({ homeDir: '/tmp/fake-home', pathExistsFn: async () => false, now: NOW })
    expect(r.success).toBe(true)
    expect(r.currentCycle).toBeNull()
    expect(r.completedCycles).toEqual([])
  })

  it('本周取峰值，上周入已完成', async () => {
    const lines = [trendLine(NOW, 30), trendLine(NOW, 45), trendLine(NOW - 7 * 864e5, 80)]
    const r = await getCodexUsageTrend(depsWith(lines))
    expect(r.currentCycle.peakPercentage).toBe(45) // 本周 max(30,45)
    expect(r.completedCycles.length).toBe(1)
    expect(r.completedCycles[0].peakPercentage).toBe(80)
  })

  it('已完成周期周期长度为 7 天', async () => {
    const r = await getCodexUsageTrend(depsWith([trendLine(NOW, 30)]))
    expect(r.currentCycle.periodEnd - r.currentCycle.periodStart).toBe(7 * 86400)
  })

  it('多周降序排列', async () => {
    const lines = [
      trendLine(NOW - 7 * 864e5, 80),
      trendLine(NOW - 14 * 864e5, 60),
      trendLine(NOW - 21 * 864e5, 40),
    ]
    const r = await getCodexUsageTrend(depsWith(lines))
    expect(r.completedCycles.map((c) => c.peakPercentage)).toEqual([80, 60, 40])
  })
})
