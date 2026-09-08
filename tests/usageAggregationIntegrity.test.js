/* @vitest-environment node */

/**
 * 用量聚合完整性测试
 *
 * 负责：
 * - 累计起点忽略旧空缓存，同时保留有效历史账本
 * - 累计起点取日志与历史账本中更早的一天
 * - 任一日期失败时不发布残缺区间总数
 *
 * @module tests/usageAggregationIntegrity.test
 */

import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { findEarliestDailySummaryDate, DAILY_SUMMARY_SCHEMA_VERSION } = require('../electron/services/dailySummaryService.js')
const { handleAggregateUsagePeriod } = require('../electron/aggregateUsagePeriodHandler.js')
const { aggregateUsageDateRange } = require('../electron/services/usageDateRangeAggregationService.js')

function makeSummary(date, total = 10) {
  return {
    version: DAILY_SUMMARY_SCHEMA_VERSION,
    date,
    generatedAt: '2026-07-11T00:00:00.000Z',
    models: total > 0
      ? {
          codex: {
            input: total,
            output: 0,
            cacheRead: 0,
            cacheCreate: 0,
            total,
          },
        }
      : {},
    projects: {},
    summary: { total, input: total, output: 0, cache: 0 },
  }
}

describe('累计起点完整性', () => {
  it('忽略 2020 空缓存与旧 schema，返回第一份当前口径的正用量汇总', async () => {
    const files = {
      '2020-01-01.json': makeSummary('2020-01-01', 0),
      '2025-01-01.json': { ...makeSummary('2025-01-01', 99), version: 3 },
      '2026-03-24.json': makeSummary('2026-03-24', 42),
    }

    const result = await findEarliestDailySummaryDate({
      homeDir: '/fake/home',
      readdirFn: vi.fn(async () => Object.keys(files)),
      readFileFn: vi.fn(async (filePath) => JSON.stringify(files[filePath.split('/').pop()])),
    })

    expect(result).toBe('2026-03-24')
  })

  it('累计范围取有效历史账本与现存日志中更早的一天', async () => {
    const result = await handleAggregateUsagePeriod(
      { period: 'allTime', timezone: 'Asia/Shanghai' },
      {
        nowFn: () => new Date('2026-07-11T04:00:00.000Z'),
        findEarliestLogDateFn: vi.fn(async () => '2026-07-10'),
        findEarliestDailySummaryDateFn: vi.fn(async () => '2026-07-08'),
        readDailySummaryFn: vi.fn(async (dateKey) => makeSummary(dateKey)),
      }
    )

    expect(result.success).toBe(true)
    expect(result.data.startDate).toBe('2026-07-08')
    expect(result.data.endDate).toBe('2026-07-10')
    expect(result.meta.totalDays).toBe(3)
  })
})

describe('区间结果完整性', () => {
  it('两天中一天失败时返回失败，不发布部分成功数据', async () => {
    const onProgress = vi.fn()
    const recomputeDailySummaryFn = vi.fn(async (dateKey) => {
      if (dateKey === '2026-07-09') return makeSummary(dateKey)
      throw new Error('disk read failed')
    })

    const result = await aggregateUsageDateRange(
      {
        period: 'custom',
        startDate: '2026-07-09',
        endDate: '2026-07-10',
      },
      {
        readDailySummaryFn: vi.fn(async () => null),
        recomputeDailySummaryFn,
        writeDailySummaryFn: vi.fn(async () => {}),
        onProgress,
      }
    )

    expect(result.success).toBe(false)
    expect(result.data).toBeUndefined()
    expect(result.error).toBe('AGGREGATE_FAILED')
    expect(result.meta).toMatchObject({
      totalDays: 2,
      recomputedDays: 1,
      failedDays: 1,
      partial: true,
    })
    expect(onProgress.mock.calls.at(-1)[0].status).toBe('failed')
  })
})
