/* @vitest-environment node */
/**
 * DSH 聚合层测试（TC-01 / TC-08 / TC-09 / TC-10）
 *
 * 覆盖：
 * - 今日（主进程 today 分支）与按天汇总两条路径的 DSH 口径一致（一致性组 CG-001）
 * - 日汇总 schema 版本提升后旧缓存被判为未命中
 * - 「累计至今」起点纳入 DSH 最早日；DSH 缺失或异常时不回归
 * - DSH 无数据时结果与关闭该来源完全一致
 *
 * 全部通过 deps 注入，不读真实用户目录。
 *
 * @module tests/dshUsageAggregation
 */

import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { handleAggregateUsagePeriod } = require('../electron/aggregateUsagePeriodHandler')
const {
  DAILY_SUMMARY_SCHEMA_VERSION,
  normalizeDailySummary,
  recomputeDailySummary,
} = require('../electron/services/dailySummaryService')
const { findEarliestLogDate } = require('../electron/services/usageLogScanService')

const DAY = '2026-08-13'
const NOW = new Date('2026-08-13T10:30:00+08:00')

/** 一条真实形状的 DSH 用量记录 */
function makeDshRecord() {
  return {
    timestamp: new Date('2026-08-13T10:00:00+08:00'),
    model: 'deepseek-v4-flash',
    project: 'proj-a',
    input: 100,
    output: 10,
    cacheRead: 500,
    cacheCreate: 0,
  }
}

/** 三源依赖：Claude/Codex 返回空，DSH 由 collectRecordsFn 提供 */
function makeDeps({ dshRecords = [makeDshRecord()], dshExists = true } = {}) {
  return {
    nowFn: () => NOW,
    pathExistsFn: vi.fn(async (target) => (String(target).includes('.dsh') ? dshExists : true)),
    scanLogFilesInRangeFn: vi.fn(async () => ({ files: [], totalMatched: 0, scannedCount: 0, truncated: false })),
    listDshSessionLogsFn: vi.fn(async () => [
      { path: '/home/u/.dsh/sessions/proj/s1/session.v3.jsonl.zstd', mtime: new Date('2026-08-13T02:00:00Z') },
    ]),
    // 生产路径为同步读取 + 逐帧解压流式消费
    readFileFn: vi.fn(() => Buffer.from('raw')),
    iterateFramesFn: vi.fn(() => [Buffer.from('{"type":"session","id":"s"}\n')]),
    collectRecordsFn: vi.fn(() => dshRecords),
  }
}

describe('TC-01 今日与按天汇总的 DSH 口径一致（CG-001）', () => {
  it('两条路径得到相同的 DSH 模型用量', async () => {
    const deps = makeDeps()

    const today = await handleAggregateUsagePeriod({ period: 'today', timezone: 'Asia/Shanghai' }, deps)
    const summary = await recomputeDailySummary(DAY, deps)

    expect(today.success).toBe(true)
    const todayModel = today.data.models.find(model => model.name === 'deepseek-v4-flash')
    const summaryModel = summary.models['deepseek-v4-flash']

    expect(todayModel).toBeTruthy()
    expect(summaryModel).toBeTruthy()
    // 四个分桶必须逐字段一致，否则同一区间会出现两个数字
    for (const field of ['input', 'output', 'cacheRead', 'cacheCreate', 'total']) {
      expect(todayModel[field]).toBe(summaryModel[field])
    }
    expect(todayModel.total).toBe(610)
    expect(today.data.recordCount).toBe(1)
  })

  it('DSH 用量计入总 Token 与项目分布', async () => {
    const result = await handleAggregateUsagePeriod({ period: 'today', timezone: 'Asia/Shanghai' }, makeDeps())

    expect(result.data.total).toBe(610)
    expect(result.data.projectDistribution.some(project => project.name === 'proj-a' && project.value === 610)).toBe(true)
  })
})

describe('TC-08 日汇总 schema 版本门', () => {
  it('版本号已提升到 6', () => {
    expect(DAILY_SUMMARY_SCHEMA_VERSION).toBe(6)
  })

  it('旧版本汇总被判为未命中，当前版本可通过', () => {
    const base = { date: DAY, generatedAt: new Date().toISOString(), models: {}, projects: {}, summary: {} }

    expect(normalizeDailySummary({ ...base, version: 5 }, DAY)).toBeNull()
    expect(normalizeDailySummary({ ...base, version: 6 }, DAY)).not.toBeNull()
  })
})

describe('TC-09 累计至今起点纳入 DSH', () => {
  it('DSH 最早日早于另外两源时成为起点', async () => {
    const result = await findEarliestLogDate({
      homeDir: '/home/u',
      pathExistsFn: async () => true,
      findEarliestClaudeDateFn: async () => '2026-08-20',
      findEarliestCodexDateFn: async () => '2026-08-25',
      findEarliestDshDateFn: async () => '2026-08-13',
    })

    expect(result).toBe('2026-08-13')
  })

  it('DSH 缺失时退回两源较早者（不回归）', async () => {
    const result = await findEarliestLogDate({
      homeDir: '/home/u',
      pathExistsFn: async (target) => !String(target).includes('.dsh'),
      findEarliestClaudeDateFn: async () => '2026-08-20',
      findEarliestCodexDateFn: async () => '2026-08-25',
      findEarliestDshDateFn: vi.fn(async () => '2026-08-13'),
    })

    expect(result).toBe('2026-08-20')
  })

  it('DSH 起点探测抛错时不影响另外两源', async () => {
    const result = await findEarliestLogDate({
      homeDir: '/home/u',
      pathExistsFn: async () => true,
      findEarliestClaudeDateFn: async () => '2026-08-20',
      findEarliestCodexDateFn: async () => null,
      findEarliestDshDateFn: async () => { throw new Error('boom') },
    })

    expect(result).toBe('2026-08-20')
  })
})

describe('TC-10 DSH 无数据时不回归', () => {
  it('DSH 来源为空与 DSH 目录不存在的结果完全一致', async () => {
    const withEmptyDsh = await handleAggregateUsagePeriod(
      { period: 'today', timezone: 'Asia/Shanghai' },
      makeDeps({ dshRecords: [] }),
    )
    const withoutDsh = await handleAggregateUsagePeriod(
      { period: 'today', timezone: 'Asia/Shanghai' },
      makeDeps({ dshExists: false }),
    )

    expect(withEmptyDsh.success).toBe(true)
    expect(withoutDsh.success).toBe(true)
    expect(withEmptyDsh.data.models).toEqual(withoutDsh.data.models)
    expect(withEmptyDsh.data.total).toBe(withoutDsh.data.total)
  })
})
