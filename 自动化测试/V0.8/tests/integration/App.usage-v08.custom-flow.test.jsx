/**
 * V0.8 用量监测自定义日期集成测试
 *
 * 负责：
 * - 校验从工作台进入用量监测后可见自定义入口
 * - 校验自定义日期提交后触发后端接口并更新文案
 *
 * @module 自动化测试/V0.8/tests/integration/App.usage-v08.custom-flow.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { fireEvent } from '@testing-library/react'
import App from '@/App.jsx'
import { dataStore } from '@/store/data.js'
import { aggregateUsage } from '@/store/usageAggregator.js'

vi.mock('@/store/data.js', () => ({
  dataStore: {
    hasCentralSkills: vi.fn(),
    isFirstEntryAfterImport: vi.fn(),
    getLastImportedToolIds: vi.fn(),
    initPushTargetsAfterImport: vi.fn(),
    setFirstEntryAfterImport: vi.fn(),
    autoIncrementalRefresh: vi.fn()
  }
}))

vi.mock('@/components/SkillManagerModule.jsx', () => ({
  default: () => <div data-testid="skills-module">技能管理模块</div>
}))

vi.mock('@/pages/ImportPage.jsx', () => ({
  default: () => <div data-testid="import-page">导入页</div>
}))

vi.mock('@/store/usageAggregator.js', () => ({
  aggregateUsage: vi.fn(),
  formatNumber: (num) => String(num),
  formatPercent: (percent) => `${percent}%`
}))

/**
 * 等待断言成立
 * @param {() => void} assertion - 断言函数
 * @param {number} timeoutMs - 超时时间
 * @returns {Promise<void>}
 */
async function waitUntil(assertion, timeoutMs = 1500) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      assertion()
      return
    } catch {
      // 轮询等待渲染稳定
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  assertion()
}

/**
 * 构造聚合成功返回
 * @param {'today'|'week'|'month'|'custom'} period - 周期
 * @returns {{success: boolean, data: object}}
 */
function createAggregateResult(period) {
  return {
    success: true,
    data: {
      period,
      total: 100,
      input: 60,
      output: 20,
      cache: 20,
      models: [{ name: 'codex', total: 100, input: 60, output: 20, cacheRead: 20, cacheCreate: 0, color: '#3b82f6' }],
      distribution: [{ name: 'codex', percent: 100, color: '#3b82f6', key: 'codex' }],
      isExtremeScenario: false,
      modelCount: 1,
      startTime: '2026-02-15T00:00:00.000Z',
      endTime: '2026-02-15T01:00:00.000Z',
      recordCount: 1
    }
  }
}

describe('App V0.8 Custom Date Flow (Integration)', () => {
  let container
  let root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    vi.clearAllMocks()

    dataStore.hasCentralSkills.mockResolvedValue(true)
    dataStore.isFirstEntryAfterImport.mockResolvedValue(false)
    dataStore.getLastImportedToolIds.mockReturnValue(['claude-code'])
    dataStore.initPushTargetsAfterImport.mockResolvedValue({ success: true })
    dataStore.setFirstEntryAfterImport.mockResolvedValue({ success: true })
    dataStore.autoIncrementalRefresh.mockResolvedValue({ added: 0 })

    aggregateUsage.mockImplementation(async (period) => createAggregateResult(period))

    window.localStorage.clear()
    window.electronAPI = {
      scanLogFiles: vi.fn(),
      aggregateUsageRange: vi.fn(async ({ startDate, endDate }) => ({
        success: true,
        data: {
          ...createAggregateResult('custom').data,
          startDate,
          endDate,
          period: 'custom'
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
    act(() => {
      root.unmount()
    })
    container.remove()
  })

  it('IT-V08-01: 自定义日期流程应触发接口并更新按钮文案', async () => {
    await act(async () => {
      root.render(<App />)
    })

    await waitUntil(() => {
      expect(container.textContent).toContain('技能管理模块')
    })

    const usageButton = [...container.querySelectorAll('.nav-item')].find((button) =>
      button.textContent.includes('用量监测')
    )

    await act(async () => {
      usageButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    await waitUntil(() => {
      expect(container.textContent).toContain('自定义')
    })

    const customSegment = [...container.querySelectorAll('.segment-item')].find((button) =>
      button.textContent.includes('自定义')
    )

    await act(async () => {
      customSegment.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const dateInputs = container.querySelectorAll('.date-picker-dropdown .date-input')
    expect(dateInputs).toHaveLength(2)

    fireEvent.change(dateInputs[0], { target: { value: '2026-02-10' } })
    fireEvent.change(dateInputs[1], { target: { value: '2026-02-15' } })

    const confirmButton = [...container.querySelectorAll('.date-picker-actions .btn')].find((button) =>
      button.textContent.includes('确定')
    )

    await act(async () => {
      confirmButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    await waitUntil(() => {
      expect(window.electronAPI.aggregateUsageRange).toHaveBeenCalledWith({
        startDate: '2026-02-10',
        endDate: '2026-02-15',
        timezone: 'Asia/Shanghai'
      })
    })

    await waitUntil(() => {
      expect(container.textContent).toContain('2/10 - 2/15')
    })
  })
})
