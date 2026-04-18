/**
 * V1.4.4 ClaudeUsageTrendCard 增量测试
 *
 * 负责：
 * - 异常小节：无异常时完全不渲染；有异常时标题/提示/行三件套渲染
 * - 样本不足：正常 0 条时 header 显示"样本不足"
 * - footer 汇总：随正常/异常数量变化
 * - 异常 30 天窗口过滤（超期异常不进视图）
 *
 * @module 自动化测试/V1.4.4/ClaudeUsageTrendCard.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import ClaudeUsageTrendCard from '@/pages/usage/components/ClaudeUsageTrendCard.jsx'

const DAY = 86400
const NOW_MS = 1776500000 * 1000 // 固定 now

function normalCycle({ ageDays, peak }) {
  const periodEnd = NOW_MS / 1000 - ageDays * DAY
  return {
    periodStart: periodEnd - 7 * DAY,
    periodEnd,
    peakPercentage: peak,
  }
}

function anomalyCycle({ ageDays, peak, durationDays = 2 }) {
  const periodEnd = NOW_MS / 1000 - ageDays * DAY
  return {
    periodStart: periodEnd - durationDays * DAY,
    periodEnd,
    peakPercentage: peak,
    anomaly: true,
    anomalyReason: 'provider_reset',
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(NOW_MS))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ClaudeUsageTrendCard - 异常小节渲染规则', () => {
  it('无异常条目 → 异常小节完全不渲染（视觉 = v1.4.1）', () => {
    const cycles = [
      normalCycle({ ageDays: 1, peak: 78 }),
      normalCycle({ ageDays: 8, peak: 92 }),
    ]
    const { container } = render(
      <ClaudeUsageTrendCard snapshot={null} completedCycles={cycles} />
    )
    expect(screen.queryByText(/异常周期/)).toBeNull()
    expect(container.querySelector('.trend-card__section-label--anomaly')).toBeNull()
    expect(container.querySelector('.trend-history-row--anomaly')).toBeNull()
    expect(container.querySelector('.trend-card__anomaly-hint')).toBeNull()
  })

  it('仅有超 30 天的老异常 → 异常小节完全不渲染', () => {
    const cycles = [
      normalCycle({ ageDays: 1, peak: 66 }),
      anomalyCycle({ ageDays: 45, peak: 99 }),
    ]
    const { container } = render(
      <ClaudeUsageTrendCard snapshot={null} completedCycles={cycles} />
    )
    expect(screen.queryByText(/异常周期/)).toBeNull()
    expect(container.querySelector('.trend-history-row--anomaly')).toBeNull()
  })

  it('有 1 条近 30 天异常 → 标题 + 提示 + 1 行异常条目', () => {
    const cycles = [
      normalCycle({ ageDays: 10, peak: 66 }),
      anomalyCycle({ ageDays: 2, peak: 25, durationDays: 2 }),
    ]
    const { container } = render(
      <ClaudeUsageTrendCard snapshot={null} completedCycles={cycles} />
    )
    expect(screen.getByText(/异常周期 · 近 30 天/)).toBeTruthy()
    expect(screen.getByText(/不计入满载率平均/)).toBeTruthy()
    const anomalyRows = container.querySelectorAll('.trend-history-row--anomaly')
    expect(anomalyRows.length).toBe(1)
    // 异常 tag 包含"Anthropic 重置"和周期天数
    expect(screen.getByText(/Anthropic 重置/)).toBeTruthy()
    expect(screen.getByText(/2 天/)).toBeTruthy()
  })

  it('多条近 30 天异常 → 全部渲染（按输入顺序）', () => {
    const cycles = [
      normalCycle({ ageDays: 20, peak: 70 }),
      anomalyCycle({ ageDays: 2, peak: 25, durationDays: 2 }),
      anomalyCycle({ ageDays: 10, peak: 42, durationDays: 2 }),
      anomalyCycle({ ageDays: 15, peak: 60, durationDays: 5 }),
    ]
    const { container } = render(
      <ClaudeUsageTrendCard snapshot={null} completedCycles={cycles} />
    )
    expect(container.querySelectorAll('.trend-history-row--anomaly').length).toBe(3)
  })

  it('混合：近 30 天内 2 条 + 超 30 天 1 条 → 只渲染近 30 天内的', () => {
    const cycles = [
      normalCycle({ ageDays: 1, peak: 78 }),
      anomalyCycle({ ageDays: 3, peak: 25 }),
      anomalyCycle({ ageDays: 60, peak: 99 }), // 超期
      anomalyCycle({ ageDays: 10, peak: 42 }),
    ]
    const { container } = render(
      <ClaudeUsageTrendCard snapshot={null} completedCycles={cycles} />
    )
    expect(container.querySelectorAll('.trend-history-row--anomaly').length).toBe(2)
  })
})

describe('ClaudeUsageTrendCard - 样本不足态', () => {
  it('0 正常 + 0 异常 → header 样本不足 + 空提示', () => {
    const { container } = render(
      <ClaudeUsageTrendCard snapshot={null} completedCycles={[]} />
    )
    expect(screen.getByText('样本不足')).toBeTruthy()
    expect(container.querySelector('.trend-card__value--insufficient')).not.toBeNull()
    expect(screen.getByText(/完整用完 1 个 7 天周期/)).toBeTruthy()
  })

  it('0 正常 + 1 近 30 天异常 → header 样本不足，但异常小节正常渲染', () => {
    const cycles = [anomalyCycle({ ageDays: 2, peak: 25 })]
    const { container } = render(
      <ClaudeUsageTrendCard snapshot={null} completedCycles={cycles} />
    )
    expect(screen.getByText('样本不足')).toBeTruthy()
    expect(container.querySelectorAll('.trend-history-row--anomaly').length).toBe(1)
    // 没有"已完成周期"section
    const normalLabels = Array.from(
      container.querySelectorAll('.trend-card__section-label')
    ).filter((el) => !el.classList.contains('trend-card__section-label--anomaly'))
    expect(normalLabels.length).toBe(0)
  })

  it('1 正常 → header 显示数字不显示"样本不足"', () => {
    const cycles = [normalCycle({ ageDays: 1, peak: 66 })]
    const { container } = render(
      <ClaudeUsageTrendCard snapshot={null} completedCycles={cycles} />
    )
    expect(screen.queryByText('样本不足')).toBeNull()
    expect(container.querySelector('.trend-card__value-num').textContent).toBe('66')
  })
})

describe('ClaudeUsageTrendCard - footer 文案', () => {
  it('0 正常 → "暂无正常完成周期"', () => {
    render(<ClaudeUsageTrendCard snapshot={null} completedCycles={[]} />)
    expect(screen.getByText(/暂无正常完成周期/)).toBeTruthy()
  })

  it('1-3 正常 → "共 N 个正常完成周期 · 数据积累中"', () => {
    const cycles = [
      normalCycle({ ageDays: 1, peak: 50 }),
      normalCycle({ ageDays: 8, peak: 60 }),
    ]
    render(<ClaudeUsageTrendCard snapshot={null} completedCycles={cycles} />)
    expect(screen.getByText(/共 2 个正常完成周期 · 数据积累中/)).toBeTruthy()
  })

  it('≥4 正常 → "共 N 个正常完成周期（展示最近 4 个）"', () => {
    const cycles = [10, 20, 30, 40, 50].map((p, i) =>
      normalCycle({ ageDays: i + 1, peak: p })
    )
    render(<ClaudeUsageTrendCard snapshot={null} completedCycles={cycles} />)
    expect(screen.getByText(/共 5 个正常完成周期（展示最近 4 个）/)).toBeTruthy()
    expect(screen.getByText(/满载率 = 正常周期峰值平均/)).toBeTruthy()
  })

  it('正常 + 近 30 天异常 → footer 加上异常数', () => {
    const cycles = [
      normalCycle({ ageDays: 1, peak: 66 }),
      anomalyCycle({ ageDays: 3, peak: 25 }),
      anomalyCycle({ ageDays: 10, peak: 42 }),
    ]
    render(<ClaudeUsageTrendCard snapshot={null} completedCycles={cycles} />)
    expect(screen.getByText(/2 个近 30 天内异常/)).toBeTruthy()
  })
})

describe('ClaudeUsageTrendCard - 副标题', () => {
  it('0 正常 → 引导文案', () => {
    render(<ClaudeUsageTrendCard snapshot={null} completedCycles={[]} />)
    expect(screen.getByText(/完整用完 1 个正常 7 天周期后出现趋势/)).toBeTruthy()
  })

  it('1-3 正常 → 基于 N 个', () => {
    const cycles = [normalCycle({ ageDays: 1, peak: 50 })]
    render(<ClaudeUsageTrendCard snapshot={null} completedCycles={cycles} />)
    expect(screen.getByText(/基于 1 个已完成的 7 天周期/)).toBeTruthy()
  })

  it('≥4 正常 → 基于最近 4 个', () => {
    const cycles = [10, 20, 30, 40].map((p, i) =>
      normalCycle({ ageDays: i + 1, peak: p })
    )
    render(<ClaudeUsageTrendCard snapshot={null} completedCycles={cycles} />)
    expect(screen.getByText('基于最近 4 个已完成的 7 天周期')).toBeTruthy()
  })
})

describe('ClaudeUsageTrendCard - 对 v1.4.1 的兼容', () => {
  it('老数据（无 anomaly 字段） → 照常按正常处理', () => {
    const cycles = [
      { periodStart: 1775000000, periodEnd: 1775700000, peakPercentage: 66 },
      { periodStart: 1774400000, periodEnd: 1775000000, peakPercentage: 78 },
    ]
    const { container } = render(
      <ClaudeUsageTrendCard snapshot={null} completedCycles={cycles} />
    )
    expect(container.querySelector('.trend-card__value--insufficient')).toBeNull()
    expect(container.querySelectorAll('.trend-history-row').length).toBe(2)
    expect(container.querySelector('.trend-history-row--anomaly')).toBeNull()
  })
})
