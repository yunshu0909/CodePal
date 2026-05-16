/**
 * V1.4.4 usageHistoryUtils 单元测试
 *
 * 负责：
 * - classifyHistory 分类与均值计算
 * - 30 天异常展示窗口过滤
 * - cycleDurationDays 边界行为
 *
 * @module 自动化测试/V1.4.4/usageHistoryUtils.test
 */

import { describe, it, expect } from 'vitest'
import { classifyHistory, cycleDurationDays } from '@/pages/usage/usageHistoryUtils.js'

const DAY = 86400
const NOW = 1776500000 // 固定 "now" 参考时间（2026-04-18 附近）

/**
 * 构造正常条目
 */
function normalCycle({ periodEnd, peak }) {
  return {
    periodStart: periodEnd - 7 * DAY,
    periodEnd,
    peakPercentage: peak,
  }
}

/**
 * 构造异常条目
 */
function anomalyCycle({ periodEnd, peak, durationDays = 2 }) {
  return {
    periodStart: periodEnd - durationDays * DAY,
    periodEnd,
    peakPercentage: peak,
    anomaly: true,
    anomalyReason: 'provider_reset',
  }
}

describe('classifyHistory - 空/非法输入', () => {
  it('empty array → 全空 + avgPeak=null', () => {
    const r = classifyHistory([], NOW)
    expect(r.normalCycles).toEqual([])
    expect(r.normalCyclesTotal).toBe(0)
    expect(r.recentAnomalies).toEqual([])
    expect(r.avgPeak).toBeNull()
  })

  it('undefined → 当作空数组处理', () => {
    const r = classifyHistory(undefined, NOW)
    expect(r.avgPeak).toBeNull()
  })

  it('null → 当作空数组处理', () => {
    const r = classifyHistory(null, NOW)
    expect(r.avgPeak).toBeNull()
  })

  it('非数组 → 当作空数组处理', () => {
    const r = classifyHistory({ foo: 'bar' }, NOW)
    expect(r.avgPeak).toBeNull()
  })

  it('数组里混非对象条目 → 跳过', () => {
    const r = classifyHistory(
      [null, 'str', normalCycle({ periodEnd: NOW - DAY, peak: 50 }), 42],
      NOW
    )
    expect(r.normalCycles.length).toBe(1)
    expect(r.avgPeak).toBe(50)
  })
})

describe('classifyHistory - 正常条目', () => {
  it('1 条正常 → avgPeak = 该条峰值', () => {
    const r = classifyHistory([normalCycle({ periodEnd: NOW - DAY, peak: 66 })], NOW)
    expect(r.normalCyclesTotal).toBe(1)
    expect(r.avgPeak).toBe(66)
  })

  it('4 条正常 [78, 92, 46, 85] → avgPeak = 75 (75.25 四舍五入)', () => {
    const cycles = [78, 92, 46, 85].map((p, i) =>
      normalCycle({ periodEnd: NOW - i * 7 * DAY, peak: p })
    )
    const r = classifyHistory(cycles, NOW)
    expect(r.avgPeak).toBe(75)
    expect(r.normalCycles.length).toBe(4)
    expect(r.normalCyclesTotal).toBe(4)
  })

  it('5 条正常 → 只取最近 4 个算均值，但 total 反映全部', () => {
    const cycles = [10, 20, 30, 40, 50].map((p, i) =>
      normalCycle({ periodEnd: NOW - i * 7 * DAY, peak: p })
    )
    const r = classifyHistory(cycles, NOW)
    expect(r.avgPeak).toBe(25) // (10+20+30+40)/4
    expect(r.normalCycles.length).toBe(4)
    expect(r.normalCyclesTotal).toBe(5)
  })

  it('老数据无 anomaly 字段 → 按正常处理', () => {
    const r = classifyHistory([{ periodStart: 0, periodEnd: NOW, peakPercentage: 33 }], NOW)
    expect(r.normalCyclesTotal).toBe(1)
    expect(r.avgPeak).toBe(33)
  })

  it('anomaly: false 显式值 → 按正常处理', () => {
    const r = classifyHistory(
      [{ periodStart: 0, periodEnd: NOW, peakPercentage: 44, anomaly: false }],
      NOW
    )
    expect(r.normalCyclesTotal).toBe(1)
    expect(r.avgPeak).toBe(44)
  })

  it('peakPercentage 非数 → 计入 0', () => {
    const r = classifyHistory(
      [
        normalCycle({ periodEnd: NOW, peak: 'NaN' }),
        normalCycle({ periodEnd: NOW - 7 * DAY, peak: 80 }),
      ],
      NOW
    )
    expect(r.avgPeak).toBe(40) // (0 + 80) / 2
  })
})

describe('classifyHistory - 异常条目 30 天窗口', () => {
  it('异常 periodEnd 距今 1 天 → 展示', () => {
    const r = classifyHistory(
      [anomalyCycle({ periodEnd: NOW - DAY, peak: 25 })],
      NOW
    )
    expect(r.recentAnomalies.length).toBe(1)
    expect(r.recentAnomalies[0].peakPercentage).toBe(25)
  })

  it('异常 periodEnd 距今 29 天 → 展示', () => {
    const r = classifyHistory(
      [anomalyCycle({ periodEnd: NOW - 29 * DAY, peak: 30 })],
      NOW
    )
    expect(r.recentAnomalies.length).toBe(1)
  })

  it('异常 periodEnd 距今 30 天整 → 展示（边界 inclusive）', () => {
    const r = classifyHistory(
      [anomalyCycle({ periodEnd: NOW - 30 * DAY, peak: 40 })],
      NOW
    )
    expect(r.recentAnomalies.length).toBe(1)
  })

  it('异常 periodEnd 距今 31 天 → 不展示', () => {
    const r = classifyHistory(
      [anomalyCycle({ periodEnd: NOW - 31 * DAY, peak: 50 })],
      NOW
    )
    expect(r.recentAnomalies.length).toBe(0)
  })

  it('异常不参与 avgPeak 计算', () => {
    const r = classifyHistory(
      [
        anomalyCycle({ periodEnd: NOW - DAY, peak: 100 }), // 异常
        normalCycle({ periodEnd: NOW - 8 * DAY, peak: 50 }), // 正常
      ],
      NOW
    )
    expect(r.avgPeak).toBe(50) // 只算正常
    expect(r.recentAnomalies.length).toBe(1)
  })

  it('全是异常 → avgPeak=null（样本不足）', () => {
    const r = classifyHistory(
      [
        anomalyCycle({ periodEnd: NOW - DAY, peak: 60 }),
        anomalyCycle({ periodEnd: NOW - 8 * DAY, peak: 70 }),
      ],
      NOW
    )
    expect(r.avgPeak).toBeNull()
    expect(r.recentAnomalies.length).toBe(2)
  })

  it('异常 periodEnd 缺失 → 当作超期，不展示', () => {
    const r = classifyHistory(
      [{ anomaly: true, anomalyReason: 'provider_reset', peakPercentage: 20 }],
      NOW
    )
    expect(r.recentAnomalies.length).toBe(0)
  })
})

describe('classifyHistory - 混合场景', () => {
  it('4 正常 + 1 近 30 天异常 + 1 超 30 天异常', () => {
    const cycles = [
      normalCycle({ periodEnd: NOW - DAY, peak: 78 }),
      anomalyCycle({ periodEnd: NOW - 5 * DAY, peak: 25 }),
      normalCycle({ periodEnd: NOW - 10 * DAY, peak: 92 }),
      normalCycle({ periodEnd: NOW - 20 * DAY, peak: 46 }),
      normalCycle({ periodEnd: NOW - 27 * DAY, peak: 85 }),
      anomalyCycle({ periodEnd: NOW - 60 * DAY, peak: 99 }), // 超期
    ]
    const r = classifyHistory(cycles, NOW)
    expect(r.normalCyclesTotal).toBe(4)
    expect(r.avgPeak).toBe(75) // (78+92+46+85)/4
    expect(r.recentAnomalies.length).toBe(1)
    expect(r.recentAnomalies[0].peakPercentage).toBe(25)
  })

  it('5 正常 + 2 近 30 天异常：normal slice 4，anomaly 全部保留', () => {
    const cycles = [
      normalCycle({ periodEnd: NOW - DAY, peak: 10 }),
      normalCycle({ periodEnd: NOW - 8 * DAY, peak: 20 }),
      anomalyCycle({ periodEnd: NOW - 10 * DAY, peak: 25 }),
      normalCycle({ periodEnd: NOW - 15 * DAY, peak: 30 }),
      normalCycle({ periodEnd: NOW - 22 * DAY, peak: 40 }),
      anomalyCycle({ periodEnd: NOW - 25 * DAY, peak: 33 }),
      normalCycle({ periodEnd: NOW - 29 * DAY, peak: 50 }),
    ]
    const r = classifyHistory(cycles, NOW)
    expect(r.normalCyclesTotal).toBe(5)
    expect(r.normalCycles.length).toBe(4) // 只用于 avg
    expect(r.avgPeak).toBe(25) // (10+20+30+40)/4
    expect(r.recentAnomalies.length).toBe(2)
  })
})

describe('classifyHistory - 历史脏数据清洗', () => {
  it('同一正常周期重复 → 保留峰值最大的那条', () => {
    const periodEnd = NOW - DAY
    const duplicated = [
      normalCycle({ periodEnd, peak: 6 }),
      normalCycle({ periodEnd, peak: 53 }),
      normalCycle({ periodEnd, peak: 21 }),
    ]
    const r = classifyHistory(duplicated, NOW)
    expect(r.normalCyclesTotal).toBe(1)
    expect(r.normalCycles[0].peakPercentage).toBe(53)
    expect(r.avgPeak).toBe(53)
  })

  it('过滤未来周期和当前窗口重叠周期', () => {
    const currentStart = NOW - DAY
    const currentEnd = currentStart + 7 * DAY
    const currentCycle = {
      periodStart: currentStart,
      sevenDayResetsAt: currentEnd,
    }
    const cycles = [
      { periodStart: currentStart, periodEnd: currentEnd, peakPercentage: 0 },
      { periodStart: currentStart - 7 * DAY, periodEnd: NOW, peakPercentage: 6 },
      { periodStart: currentStart - 7 * DAY, periodEnd: currentStart, peakPercentage: 53 },
    ]
    const r = classifyHistory(cycles, NOW, currentCycle)
    expect(r.normalCyclesTotal).toBe(1)
    expect(r.normalCycles[0].peakPercentage).toBe(53)
  })
})

describe('cycleDurationDays', () => {
  it('2 天', () => {
    const start = 1776000000
    expect(cycleDurationDays(start, start + 2 * DAY)).toBe(2)
  })

  it('7 天', () => {
    const start = 1776000000
    expect(cycleDurationDays(start, start + 7 * DAY)).toBe(7)
  })

  it('不足 1 天的也算 1 天（向下取整后 max 1）', () => {
    const start = 1776000000
    expect(cycleDurationDays(start, start + 3600)).toBe(1)
  })

  it('end ≤ start → 0', () => {
    expect(cycleDurationDays(1000, 1000)).toBe(0)
    expect(cycleDurationDays(2000, 1000)).toBe(0)
  })

  it('非法输入 → 0', () => {
    expect(cycleDurationDays(null, 1000)).toBe(0)
    expect(cycleDurationDays('foo', 1000)).toBe(0)
    expect(cycleDurationDays(1000, undefined)).toBe(0)
  })
})
