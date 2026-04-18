/**
 * V1.4.1 ClaudeUsageTrendCard 单元测试
 *
 * 负责：
 * - 验证满载率计算（四舍五入、只取最近 4 个、降级态）
 * - 验证头部渲染（标题/副标题三档/值徽章 placeholder 态）
 * - 验证主体渲染（当前周、历史条、空提示、section 标签）
 * - 验证历史行日期范围格式与边界百分比
 * - 验证 stale prop、completedCycles 非数组/缺字段降级
 *
 * @module 自动化测试/V1.4.1/ClaudeUsageTrendCard.test
 */

import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import ClaudeUsageTrendCard from '@/pages/usage/components/ClaudeUsageTrendCard.jsx'

/**
 * 构造已完成周期数据
 * @param {number} peakPercentage
 * @param {number} [index=0] - 索引，用于生成不同的日期范围
 * @returns {{periodStart: number, periodEnd: number, peakPercentage: number}}
 */
function makeCycle(peakPercentage, index = 0) {
  // 2026-01-01 UTC 基准，方便断言日期范围
  const baseStart = 1767225600 // 2026-01-01
  const weekSec = 7 * 86400
  const periodStart = baseStart + index * weekSec
  const periodEnd = periodStart + weekSec
  return { periodStart, periodEnd, peakPercentage }
}

/**
 * 从满载率徽章区域取出显示的数字文本
 * @returns {string}
 */
function getValueBadgeText(container) {
  const num = container.querySelector('.trend-card__value-num')
  return num ? num.textContent : ''
}

describe('ClaudeUsageTrendCard - computeUtilization (via render)', () => {
  it('4 cycles [78, 92, 46, 85] → 满载率 75 (75.25 四舍五入)', () => {
    const cycles = [78, 92, 46, 85].map((p, i) => makeCycle(p, i))
    const { container } = render(
      <ClaudeUsageTrendCard snapshot={null} completedCycles={cycles} />
    )
    expect(getValueBadgeText(container)).toBe('75')
    // 副标题：4 个及以上固定文案
    expect(screen.getByText('基于最近 4 个已完成的 7 天周期')).toBeTruthy()
  })

  it('5 cycles [10, 20, 30, 40, 50] → 只取最近 4 个 = 25', () => {
    const cycles = [10, 20, 30, 40, 50].map((p, i) => makeCycle(p, i))
    const { container } = render(
      <ClaudeUsageTrendCard snapshot={null} completedCycles={cycles} />
    )
    // slice(0,4) = [10, 20, 30, 40]，平均 25
    expect(getValueBadgeText(container)).toBe('25')
  })

  it('3 cycles [60, 70, 80] → 70，副标题 "基于 3 个已完成的 7 天周期"', () => {
    const cycles = [60, 70, 80].map((p, i) => makeCycle(p, i))
    const { container } = render(
      <ClaudeUsageTrendCard snapshot={null} completedCycles={cycles} />
    )
    expect(getValueBadgeText(container)).toBe('70')
    expect(screen.getByText('基于 3 个已完成的 7 天周期')).toBeTruthy()
  })

  it('1 cycle [50] → 50，副标题 "基于 1 个已完成的 7 天周期"', () => {
    const cycles = [makeCycle(50)]
    const { container } = render(
      <ClaudeUsageTrendCard snapshot={null} completedCycles={cycles} />
    )
    expect(getValueBadgeText(container)).toBe('50')
    expect(screen.getByText('基于 1 个已完成的 7 天周期')).toBeTruthy()
  })

  it('0 cycles → 值显示 "样本不足"（v1.4.4），footer 显示 "暂无正常完成周期"', () => {
    const { container } = render(
      <ClaudeUsageTrendCard snapshot={null} completedCycles={[]} />
    )
    // v1.4.4：0 条正常 → 样本不足态（替代原 "--"）
    expect(getValueBadgeText(container)).toBe('样本不足')
    expect(screen.getByText('暂无正常完成周期')).toBeTruthy()
  })
})

describe('ClaudeUsageTrendCard - Header rendering', () => {
  it('标题 "满载率趋势" 始终存在', () => {
    render(<ClaudeUsageTrendCard snapshot={null} completedCycles={[]} />)
    expect(screen.getByRole('heading', { name: '满载率趋势' })).toBeTruthy()
  })

  it('副标题在 0 个周期时显示引导文案（v1.4.4 文案加"正常"限定）', () => {
    render(<ClaudeUsageTrendCard snapshot={null} completedCycles={[]} />)
    expect(screen.getByText('完整用完 1 个正常 7 天周期后出现趋势')).toBeTruthy()
  })

  it('副标题在 1-3 个周期时显示 "基于 N 个已完成的 7 天周期"', () => {
    const cycles = [makeCycle(50), makeCycle(60, 1)]
    render(<ClaudeUsageTrendCard snapshot={null} completedCycles={cycles} />)
    expect(screen.getByText('基于 2 个已完成的 7 天周期')).toBeTruthy()
  })

  it('副标题在 4+ 个周期时显示 "基于最近 4 个已完成的 7 天周期"', () => {
    const cycles = [50, 60, 70, 80, 90].map((p, i) => makeCycle(p, i))
    render(<ClaudeUsageTrendCard snapshot={null} completedCycles={cycles} />)
    expect(screen.getByText('基于最近 4 个已完成的 7 天周期')).toBeTruthy()
  })

  it('值徽章显示正确数字并带 "%" 单位', () => {
    const cycles = [makeCycle(42)]
    const { container } = render(
      <ClaudeUsageTrendCard snapshot={null} completedCycles={cycles} />
    )
    expect(getValueBadgeText(container)).toBe('42')
    const unit = container.querySelector('.trend-card__value-unit')
    expect(unit).not.toBeNull()
    expect(unit.textContent).toBe('%')
  })

  it('0 个周期时值徽章带 --insufficient 样式类（v1.4.4 替代 --placeholder）', () => {
    const { container } = render(
      <ClaudeUsageTrendCard snapshot={null} completedCycles={[]} />
    )
    const badge = container.querySelector('.trend-card__value')
    expect(badge).not.toBeNull()
    expect(badge.className).toContain('trend-card__value--insufficient')
    // 有周期时不应带 insufficient
    const { container: c2 } = render(
      <ClaudeUsageTrendCard snapshot={null} completedCycles={[makeCycle(10)]} />
    )
    const badge2 = c2.querySelector('.trend-card__value')
    expect(badge2.className).not.toContain('trend-card__value--insufficient')
  })
})

describe('ClaudeUsageTrendCard - Body rendering', () => {
  it('CurrentWeekBar 在 snapshot=null 时仍渲染（显示 "--"）', () => {
    const { container } = render(
      <ClaudeUsageTrendCard snapshot={null} completedCycles={[]} />
    )
    const currentWeek = container.querySelector('.trend-current-week')
    expect(currentWeek).not.toBeNull()
    // 百分比区域显示 "--"
    const pct = container.querySelector('.trend-current-week__pct')
    expect(pct.textContent).toBe('--')
  })

  it('snapshot 提供 sevenDayUsedPercentage 时，当前周百分比正确显示', () => {
    const snapshot = { sevenDayUsedPercentage: 37 }
    const { container } = render(
      <ClaudeUsageTrendCard snapshot={snapshot} completedCycles={[]} />
    )
    const pct = container.querySelector('.trend-current-week__pct')
    expect(pct.textContent).toBe('37%')
  })

  it('section label "已完成周期" 仅在有 cycles 时显示', () => {
    // 无 cycles
    const { container: c1 } = render(
      <ClaudeUsageTrendCard snapshot={null} completedCycles={[]} />
    )
    expect(c1.querySelector('.trend-card__section-label')).toBeNull()

    // 有 cycles
    const { container: c2 } = render(
      <ClaudeUsageTrendCard snapshot={null} completedCycles={[makeCycle(10)]} />
    )
    const label = c2.querySelector('.trend-card__section-label')
    expect(label).not.toBeNull()
    expect(label.textContent).toBe('已完成周期')
  })

  it('空提示 "完整用完 1 个 7 天周期后..." 仅在 0 cycles 时显示', () => {
    const { container: c1 } = render(
      <ClaudeUsageTrendCard snapshot={null} completedCycles={[]} />
    )
    const hint = c1.querySelector('.trend-card__empty-hint')
    expect(hint).not.toBeNull()
    expect(hint.textContent).toContain('完整用完 1 个 7 天周期后')

    // 有 cycles 时不出现
    const { container: c2 } = render(
      <ClaudeUsageTrendCard snapshot={null} completedCycles={[makeCycle(10)]} />
    )
    expect(c2.querySelector('.trend-card__empty-hint')).toBeNull()
  })
})

describe('ClaudeUsageTrendCard - History rows', () => {
  it('最多渲染 4 条历史行（slice(0, 4)）', () => {
    const cycles = [10, 20, 30, 40, 50, 60].map((p, i) => makeCycle(p, i))
    const { container } = render(
      <ClaudeUsageTrendCard snapshot={null} completedCycles={cycles} />
    )
    const rows = container.querySelectorAll('.trend-history-row')
    expect(rows.length).toBe(4)
  })

  it('历史行日期按 "M/D → M/D" 格式显示', () => {
    // 使用确定的日期：2026-01-01 开始的一周 → 1/1 → 1/8
    const cycle = makeCycle(50, 0)
    const { container } = render(
      <ClaudeUsageTrendCard snapshot={null} completedCycles={[cycle]} />
    )
    const dateSpan = container.querySelector('.trend-history-row__date')
    expect(dateSpan).not.toBeNull()
    // 使用本地时区解析 periodStart/periodEnd，因此只断言 "M/D → M/D" 格式
    expect(dateSpan.textContent).toMatch(/^\d{1,2}\/\d{1,2} → \d{1,2}\/\d{1,2}$/)
  })

  it('历史行显示百分比', () => {
    const cycle = makeCycle(73, 0)
    const { container } = render(
      <ClaudeUsageTrendCard snapshot={null} completedCycles={[cycle]} />
    )
    const pct = container.querySelector('.trend-history-row__pct')
    expect(pct.textContent).toBe('73%')
  })

  it('边界值 0% 渲染正确', () => {
    const cycle = makeCycle(0, 0)
    const { container } = render(
      <ClaudeUsageTrendCard snapshot={null} completedCycles={[cycle]} />
    )
    const pct = container.querySelector('.trend-history-row__pct')
    expect(pct.textContent).toBe('0%')
    const fill = container.querySelector('.trend-history-row__fill')
    expect(fill.style.width).toBe('0%')
  })

  it('边界值 100% 渲染正确', () => {
    const cycle = makeCycle(100, 0)
    const { container } = render(
      <ClaudeUsageTrendCard snapshot={null} completedCycles={[cycle]} />
    )
    const pct = container.querySelector('.trend-history-row__pct')
    expect(pct.textContent).toBe('100%')
    const fill = container.querySelector('.trend-history-row__fill')
    expect(fill.style.width).toBe('100%')
  })
})

describe('ClaudeUsageTrendCard - stale prop', () => {
  it('stale=true 时 section 带 trend-card--stale 样式类', () => {
    const { container } = render(
      <ClaudeUsageTrendCard snapshot={null} completedCycles={[]} stale />
    )
    const section = container.querySelector('section.trend-card')
    expect(section).not.toBeNull()
    expect(section.className).toContain('trend-card--stale')
  })

  it('stale=false（默认）时 section 不带 trend-card--stale', () => {
    const { container } = render(
      <ClaudeUsageTrendCard snapshot={null} completedCycles={[]} />
    )
    const section = container.querySelector('section.trend-card')
    expect(section.className).not.toContain('trend-card--stale')
  })
})

describe('ClaudeUsageTrendCard - Edge cases', () => {
  it('completedCycles 为 undefined 时按空数组处理', () => {
    const { container } = render(
      <ClaudeUsageTrendCard snapshot={null} completedCycles={undefined} />
    )
    // v1.4.4：视为 0 条正常 → 样本不足态
    expect(getValueBadgeText(container)).toBe('样本不足')
    expect(container.querySelector('.trend-card__empty-hint')).not.toBeNull()
    expect(screen.getByText('暂无正常完成周期')).toBeTruthy()
  })

  it('completedCycles 不是数组时按空数组处理', () => {
    const { container } = render(
      <ClaudeUsageTrendCard snapshot={null} completedCycles={'not-an-array'} />
    )
    expect(getValueBadgeText(container)).toBe('样本不足')
    expect(container.querySelector('.trend-card__empty-hint')).not.toBeNull()
  })

  it('周期缺少 peakPercentage 时计算按 0 兜底', () => {
    // 两个有效值 + 一个缺失 → (80 + 40 + 0) / 3 = 40
    const cycles = [
      { periodStart: 1767225600, periodEnd: 1767830400, peakPercentage: 80 },
      { periodStart: 1767830400, periodEnd: 1768435200, peakPercentage: 40 },
      { periodStart: 1768435200, periodEnd: 1769040000 }, // 缺 peakPercentage
    ]
    const { container } = render(
      <ClaudeUsageTrendCard snapshot={null} completedCycles={cycles} />
    )
    expect(getValueBadgeText(container)).toBe('40')
  })
})
