/* @vitest-environment node */

/**
 * V0.8 自定义日期区间聚合处理器测试
 *
 * 负责：
 * - 校验日期参数与时间边界
 * - 校验“日汇总命中 + 缺失补算”混合链路
 * - 校验聚合结果与 meta 统计字段
 *
 * @module 自动化测试/V0.8/tests/unit/electron/aggregateUsageRangeHandler.v08.behavior.test
 */

import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { handleAggregateUsageRange } = require('../../../../../electron/aggregateUsageRangeHandler.js')

/**
 * 构造测试用日汇总对象
 * @param {string} date - 日期
 * @param {Record<string, {input:number,output:number,cacheRead:number,cacheCreate?:number,total:number}>} models - 模型汇总
 * @returns {object}
 */
function createDailySummary(date, models) {
  const summary = Object.values(models).reduce((acc, model) => {
    acc.total += model.total
    acc.input += model.input
    acc.output += model.output
    acc.cache += (model.cacheRead || 0) + (model.cacheCreate || 0)
    return acc
  }, { total: 0, input: 0, output: 0, cache: 0 })

  return {
    date,
    generatedAt: '2026-02-16T00:05:00.000Z',
    models,
    summary
  }
}

describe('aggregateUsageRangeHandler V0.8 Behavior (Node Unit)', () => {
  it('UT-BE-RANGE-01: 非法日期格式应返回 INVALID_DATE_RANGE', async () => {
    const result = await handleAggregateUsageRange({
      startDate: '2026/02/10',
      endDate: '2026-02-12',
      timezone: 'Asia/Shanghai'
    })

    expect(result).toEqual({
      success: false,
      error: 'INVALID_DATE_RANGE'
    })
  })

  it('UT-BE-RANGE-02: 结束日期为今天或未来应返回 DATE_OUT_OF_RANGE', async () => {
    const now = new Date('2026-02-16T10:00:00.000Z')

    const result = await handleAggregateUsageRange(
      {
        startDate: '2026-02-15',
        endDate: '2026-02-16',
        timezone: 'Asia/Shanghai'
      },
      {
        nowFn: vi.fn(() => now)
      }
    )

    expect(result).toEqual({
      success: false,
      error: 'DATE_OUT_OF_RANGE'
    })
  })

  it('UT-BE-RANGE-03: 命中日汇总并补算缺失日期后应返回完整聚合结果', async () => {
    const cachedDay = createDailySummary('2026-02-13', {
      'kimi-for-coding': {
        input: 100,
        output: 10,
        cacheRead: 20,
        cacheCreate: 0,
        total: 130
      }
    })

    const recomputedDay = createDailySummary('2026-02-14', {
      'codex-latest': {
        input: 200,
        output: 30,
        cacheRead: 50,
        cacheCreate: 0,
        total: 280
      }
    })

    const readDailySummaryFn = vi.fn(async (dateKey) => {
      if (dateKey === '2026-02-13') {
        return cachedDay
      }
      return null
    })

    const recomputeDailySummaryFn = vi.fn(async (dateKey) => {
      if (dateKey === '2026-02-14') {
        return recomputedDay
      }
      throw new Error(`unexpected recompute date: ${dateKey}`)
    })

    const writeDailySummaryFn = vi.fn(async () => {})

    const result = await handleAggregateUsageRange(
      {
        startDate: '2026-02-13',
        endDate: '2026-02-14',
        timezone: 'Asia/Shanghai'
      },
      {
        nowFn: vi.fn(() => new Date('2026-02-16T10:00:00.000Z')),
        readDailySummaryFn,
        recomputeDailySummaryFn,
        writeDailySummaryFn
      }
    )

    expect(result.success).toBe(true)
    expect(result.meta).toEqual({
      fromDailySummaryDays: 1,
      recomputedDays: 1,
      totalDays: 2,
      failedDays: 0
    })

    expect(result.data.period).toBe('custom')
    expect(result.data.startDate).toBe('2026-02-13')
    expect(result.data.endDate).toBe('2026-02-14')

    // 聚合总量 = 130 + 280
    expect(result.data.total).toBe(410)
    expect(result.data.input).toBe(300)
    expect(result.data.output).toBe(40)
    expect(result.data.cache).toBe(70)

    expect(readDailySummaryFn).toHaveBeenCalledTimes(2)
    expect(recomputeDailySummaryFn).toHaveBeenCalledTimes(1)
    expect(writeDailySummaryFn).toHaveBeenCalledTimes(1)
  })
})
