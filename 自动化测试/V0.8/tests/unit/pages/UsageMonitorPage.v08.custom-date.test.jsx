/**
 * V0.8 用量页自定义日期交互测试
 *
 * 负责：
 * - 校验自定义日期 dropdown 打开/关闭行为
 * - 校验默认日期为昨天且今天不可选
 * - 校验日期校验失败时不触发后端请求
 * - 校验合法区间调用后端并更新自定义按钮文案
 *
 * @module 自动化测试/V0.8/tests/unit/pages/UsageMonitorPage.v08.custom-date.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import UsageMonitorPage from '@/pages/UsageMonitorPage.jsx'
import { aggregateUsage } from '@/store/usageAggregator.js'

vi.mock('@/store/usageAggregator.js', () => ({
  aggregateUsage: vi.fn(),
  formatNumber: (num) => String(num),
  formatPercent: (percent) => `${percent}%`
}))

/**
 * 刷新微任务队列，确保组件异步状态落地
 * @returns {Promise<void>}
 */
async function flushMicrotasks() {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve()
    }
  })
}

/**
 * 获取北京时间日期 key
 * @param {Date} date - 参考时间
 * @returns {string}
 */
function getBeijingDayKey(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  })

  const parts = formatter.formatToParts(date)
  const map = {}
  for (const part of parts) {
    if (part.type === 'year' || part.type === 'month' || part.type === 'day') {
      map[part.type] = part.value
    }
  }

  return `${map.year}-${map.month}-${map.day}`
}

/**
 * 构造聚合成功返回
 * @param {'today'|'week'|'month'|'custom'} period - 周期
 * @param {object} overrides - 覆盖字段
 * @returns {{success: boolean, data: object}}
 */
function successResult(period, overrides = {}) {
  return {
    success: true,
    data: {
      period,
      total: 100,
      input: 60,
      output: 20,
      cache: 20,
      models: [
        { name: 'codex', total: 100, input: 60, output: 20, cacheRead: 20, cacheCreate: 0, color: '#3b82f6' }
      ],
      distribution: [
        { name: 'codex', percent: 100, color: '#3b82f6', key: 'codex' }
      ],
      isExtremeScenario: false,
      modelCount: 1,
      startTime: '2026-02-15T00:00:00.000Z',
      endTime: '2026-02-15T01:00:00.000Z',
      recordCount: 1,
      ...overrides
    }
  }
}

describe('UsageMonitorPage V0.8 Custom Date (Unit)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // 固定当前时间，确保“昨天”默认值可预测
    vi.setSystemTime(new Date('2026-02-16T03:00:00.000Z'))

    window.localStorage.clear()
    aggregateUsage.mockReset()
    aggregateUsage.mockImplementation(async (period) => successResult(period))

    window.electronAPI = {
      scanLogFiles: vi.fn(),
      aggregateUsageRange: vi.fn(async ({ startDate, endDate }) => ({
        success: true,
        data: {
          ...successResult('custom').data,
          period: 'custom',
          startDate,
          endDate
        },
        meta: {
          fromDailySummaryDays: 0,
          recomputedDays: 2,
          totalDays: 2,
          failedDays: 0
        }
      }))
    }
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('UT-FE-V08-01: 打开自定义 dropdown 后日期默认值应为昨天，且点击外部关闭', async () => {
    const { container } = render(<UsageMonitorPage />)
    await flushMicrotasks()

    const customButton = screen.getByRole('button', { name: /自定义/ })
    fireEvent.click(customButton)

    const dateInputs = container.querySelectorAll('.date-picker-dropdown .date-input')
    expect(dateInputs).toHaveLength(2)

    const yesterday = new Date('2026-02-16T03:00:00.000Z')
    yesterday.setUTCDate(yesterday.getUTCDate() - 1)
    const yesterdayKey = getBeijingDayKey(yesterday)

    expect(dateInputs[0].value).toBe(yesterdayKey)
    expect(dateInputs[1].value).toBe(yesterdayKey)
    expect(dateInputs[0].getAttribute('max')).toBe(yesterdayKey)
    expect(dateInputs[1].getAttribute('max')).toBe(yesterdayKey)

    // 点击外部应关闭 dropdown 且不应用本次选择
    fireEvent.mouseDown(document.body)
    expect(container.querySelector('.date-picker-dropdown')).toBeNull()
    expect(screen.getByRole('button', { name: /自定义/ }).textContent).toContain('自定义')
  })

  it('UT-FE-V08-02: 结束日期为今天时应提示错误且不触发请求', async () => {
    const { container } = render(<UsageMonitorPage />)
    await flushMicrotasks()

    const customButton = screen.getByRole('button', { name: /自定义/ })
    fireEvent.click(customButton)

    const dateInputs = container.querySelectorAll('.date-picker-dropdown .date-input')
    expect(dateInputs).toHaveLength(2)

    fireEvent.change(dateInputs[0], { target: { value: '2026-02-15' } })
    fireEvent.change(dateInputs[1], { target: { value: '2026-02-16' } })

    fireEvent.click(screen.getByRole('button', { name: '确定' }))

    expect(screen.getByText(/结束日期不能为今天或未来日期/)).toBeTruthy()
    expect(window.electronAPI.aggregateUsageRange).toHaveBeenCalledTimes(0)
  })

  it('UT-FE-V08-03: 合法日期确认后应调用后端并更新按钮文案，切回预设重置文案', async () => {
    const { container } = render(<UsageMonitorPage />)
    await flushMicrotasks()

    fireEvent.click(screen.getByRole('button', { name: /自定义/ }))

    const dateInputs = container.querySelectorAll('.date-picker-dropdown .date-input')
    fireEvent.change(dateInputs[0], { target: { value: '2026-02-10' } })
    fireEvent.change(dateInputs[1], { target: { value: '2026-02-15' } })

    fireEvent.click(screen.getByRole('button', { name: '确定' }))
    await flushMicrotasks()

    expect(window.electronAPI.aggregateUsageRange).toHaveBeenCalledTimes(1)
    expect(window.electronAPI.aggregateUsageRange).toHaveBeenCalledWith({
      startDate: '2026-02-10',
      endDate: '2026-02-15',
      timezone: 'Asia/Shanghai'
    })

    const customAppliedButton = screen.getByRole('button', { name: /2\/10 - 2\/15/ })
    expect(customAppliedButton).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '近7天' }))

    // 切回预设后，自定义文案应恢复默认
    expect(screen.getByRole('button', { name: /自定义/ }).textContent).toContain('自定义')
    expect(container.querySelector('.date-picker-dropdown')).toBeNull()
  })

  it('UT-FE-V08-04: 后端错误码应映射为可读文案', async () => {
    window.electronAPI.aggregateUsageRange = vi.fn(async () => ({
      success: false,
      error: 'DATE_OUT_OF_RANGE'
    }))

    const { container } = render(<UsageMonitorPage />)
    await flushMicrotasks()

    fireEvent.click(screen.getByRole('button', { name: /自定义/ }))

    const dateInputs = container.querySelectorAll('.date-picker-dropdown .date-input')
    fireEvent.change(dateInputs[0], { target: { value: '2026-02-10' } })
    fireEvent.change(dateInputs[1], { target: { value: '2026-02-15' } })

    fireEvent.click(screen.getByRole('button', { name: '确定' }))
    await flushMicrotasks()

    expect(screen.getByText(/结束日期不能为今天或未来日期/)).toBeTruthy()
  })
})
