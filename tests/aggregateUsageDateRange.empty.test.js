/* @vitest-environment node */

/**
 * aggregateUsageDateRange 空数据早退分支测试
 *
 * 负责：
 * - startDate=null 时不进按天循环，返回 success+空 viewData
 * - 不撞 AGGREGATE_FAILED 路径
 * - meta.empty=true，UI 可据此区分"无数据"vs"扫描出错"
 *
 * @module tests/aggregateUsageDateRange.empty.test
 */

import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  aggregateUsageDateRange,
} = require('../electron/services/usageDateRangeAggregationService.js')
const {
  buildUsageViewData,
} = require('../electron/services/usageViewDataService.js')

describe('aggregateUsageDateRange 空数据早退', () => {
  it('startDate=null → success+空 viewData，meta.empty=true', async () => {
    const readDailySummaryFn = vi.fn()
    const recomputeDailySummaryFn = vi.fn()
    const onProgress = vi.fn()

    const result = await aggregateUsageDateRange(
      { period: 'allTime', startDate: null, endDate: null },
      { readDailySummaryFn, recomputeDailySummaryFn, onProgress }
    )

    expect(result.success).toBe(true)
    expect(result.meta.empty).toBe(true)
    expect(result.meta.totalDays).toBe(0)

    // 关键：不进按天循环
    expect(readDailySummaryFn).not.toHaveBeenCalled()
    expect(recomputeDailySummaryFn).not.toHaveBeenCalled()

    // 仍然发一次终态进度，让 UI 把任务关掉
    expect(onProgress).toHaveBeenCalled()
    const lastCall = onProgress.mock.calls[onProgress.mock.calls.length - 1][0]
    expect(lastCall.status).toBe('completed')
    expect(lastCall.totalDays).toBe(0)
  })

  it('startDate > endDate → 同样早退', async () => {
    const readDailySummaryFn = vi.fn()

    const result = await aggregateUsageDateRange(
      { period: 'custom', startDate: '2026-05-10', endDate: '2026-05-01' },
      { readDailySummaryFn }
    )

    expect(result.success).toBe(true)
    expect(result.meta.empty).toBe(true)
    expect(readDailySummaryFn).not.toHaveBeenCalled()
  })

  it('startDate=undefined（兜底容错）也早退', async () => {
    const result = await aggregateUsageDateRange(
      { period: 'allTime' },
      {}
    )
    expect(result.success).toBe(true)
    expect(result.meta.empty).toBe(true)
  })

  it('早退分支 data 形态与 buildUsageViewData(空) 一致（保证 UI 不会读到 undefined）', async () => {
    const result = await aggregateUsageDateRange(
      { period: 'allTime', startDate: null, endDate: null },
      {}
    )
    const expectedShape = buildUsageViewData(new Map(), new Map())

    // 早退 data 必须包含 buildUsageViewData 的所有 key（前端可能消费任意字段）
    for (const key of Object.keys(expectedShape)) {
      expect(result.data, `早退 data 缺少 key ${key}`).toHaveProperty(key)
    }
    // 同时还要带 period/startDate/endDate（与正常路径对齐）
    expect(result.data).toHaveProperty('period', 'allTime')
    expect(result.data).toHaveProperty('startDate', null)
    expect(result.data).toHaveProperty('endDate', null)
  })

  it('早退分支 meta 字段齐全（与正常路径同 key 集 + 额外 empty 标记）', async () => {
    const result = await aggregateUsageDateRange(
      { period: 'allTime', startDate: null, endDate: null },
      {}
    )
    // 正常路径 meta key 集
    for (const key of ['fromDailySummaryDays', 'cachedDays', 'recomputedDays', 'totalDays', 'failedDays']) {
      expect(result.meta, `早退 meta 缺少 key ${key}`).toHaveProperty(key)
    }
    expect(result.meta.empty).toBe(true)
  })
})
