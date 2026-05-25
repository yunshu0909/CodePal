/* @vitest-environment node */

/**
 * getPresetPeriodDateRange 周期日期区间生成
 *
 * 重点：
 * - allTime 必须由调用方注入 earliestDate；不传 → 返回 null 区间标记
 * - week/month 保持原相对偏移行为
 * - 时区强制北京
 *
 * @module tests/getPresetPeriodDateRange.test
 */

import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  getPresetPeriodDateRange,
} = require('../electron/services/usageDateRangeAggregationService.js')

// 北京时间 2026-05-25 10:00
const FIXED_NOW = new Date('2026-05-25T02:00:00.000Z')

describe('getPresetPeriodDateRange', () => {
  it('week → 今天 -7 到 -1（共 7 天）', () => {
    const result = getPresetPeriodDateRange('week', FIXED_NOW)
    expect(result.startDate).toBe('2026-05-18')
    expect(result.endDate).toBe('2026-05-24')
  })

  it('month → 今天 -30 到 -1（共 30 天）', () => {
    const result = getPresetPeriodDateRange('month', FIXED_NOW)
    expect(result.startDate).toBe('2026-04-25')
    expect(result.endDate).toBe('2026-05-24')
  })

  it('allTime + 传入 earliestDate → 用 earliestDate 当起点', () => {
    const result = getPresetPeriodDateRange('allTime', FIXED_NOW, { earliestDate: '2024-09-15' })
    expect(result.startDate).toBe('2024-09-15')
    expect(result.endDate).toBe('2026-05-24')
  })

  it('allTime 未传 earliestDate → {null, null} 让上游短路', () => {
    const result = getPresetPeriodDateRange('allTime', FIXED_NOW)
    expect(result.startDate).toBeNull()
    expect(result.endDate).toBeNull()
  })

  it('allTime + earliestDate=null（显式 null）→ {null, null}', () => {
    const result = getPresetPeriodDateRange('allTime', FIXED_NOW, { earliestDate: null })
    expect(result.startDate).toBeNull()
    expect(result.endDate).toBeNull()
  })

  it('未知 period → 默认昨天单天', () => {
    const result = getPresetPeriodDateRange('unknown', FIXED_NOW)
    expect(result.startDate).toBe('2026-05-24')
    expect(result.endDate).toBe('2026-05-24')
  })

  it('北京时间 23:59 → 仍归属当天，week endDate 是真"昨天"', () => {
    // 2026-05-25T15:59:00Z = 北京 2026-05-25 23:59
    const lateNight = new Date('2026-05-25T15:59:00.000Z')
    const result = getPresetPeriodDateRange('week', lateNight)
    expect(result.endDate).toBe('2026-05-24')
    expect(result.startDate).toBe('2026-05-18')
  })

  it('北京时间 00:00（UTC 16:00）→ 已是次日，endDate 跨日界', () => {
    // 2026-05-25T16:00:00Z = 北京 2026-05-26 00:00
    const justAfterMidnight = new Date('2026-05-25T16:00:00.000Z')
    const result = getPresetPeriodDateRange('week', justAfterMidnight)
    expect(result.endDate).toBe('2026-05-25')
    expect(result.startDate).toBe('2026-05-19')
  })
})
