/**
 * 自定义区间切回交互回归测试
 *
 * 负责：
 * - 验证自定义区间切走后仍保留上次文案
 * - 验证再次点击自定义会回到上一次已生效区间
 *
 * @module tests/usage-custom-range-switch.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import useUsageData from '../src/pages/usage/useUsageData'
import { aggregateUsage } from '../src/store/usageAggregator'

const EMPTY_USAGE_RESULT = {
  total: 120,
  input: 40,
  output: 30,
  cacheRead: 50,
  cacheCreate: 0,
  models: [],
  distribution: [],
  projectDistribution: [],
  isExtremeScenario: false,
  modelCount: 0
}

vi.mock('../src/store/usageAggregator', () => ({
  aggregateUsage: vi.fn(async () => ({
    success: true,
    data: EMPTY_USAGE_RESULT
  }))
}))

describe('useUsageData custom range switch', () => {
  beforeEach(() => {
    window.localStorage.clear()
    window.electronAPI = {
      scanLogFiles: vi.fn(async () => ({ success: true, files: [] })),
      aggregateUsageRange: vi.fn(async () => ({
        success: true,
        data: {
          ...EMPTY_USAGE_RESULT,
          total: 360
        }
      })),
      aggregateUsagePeriod: vi.fn(),
      onUsageAggregationProgress: vi.fn(() => () => {})
    }
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    delete window.electronAPI
  })

  it('returns to the last applied custom range after switching away', async () => {
    const { result } = renderHook(() => useUsageData())

    await waitFor(() => {
      expect(aggregateUsage).toHaveBeenCalled()
    })

    await act(async () => {
      result.current.setCustomDateRange({
        startDate: '2024-04-10',
        endDate: '2024-04-15'
      })
    })

    await act(async () => {
      await result.current.handleCustomDateConfirm()
    })

    expect(result.current.currentPeriod).toBe('custom')
    expect(result.current.getCustomButtonLabel()).toBe('4/10 - 4/15')
    expect(window.electronAPI.aggregateUsageRange).toHaveBeenCalledTimes(1)

    await act(async () => {
      result.current.handlePeriodChange('today')
    })

    expect(result.current.currentPeriod).toBe('today')
    expect(result.current.getCustomButtonLabel()).toBe('4/10 - 4/15')

    await act(async () => {
      result.current.handlePeriodChange('custom')
    })

    expect(result.current.currentPeriod).toBe('custom')
    expect(result.current.showCustomDateModal).toBe(false)
    expect(result.current.appliedCustomRange).toEqual({
      startDate: '2024-04-10',
      endDate: '2024-04-15'
    })
    expect(window.electronAPI.aggregateUsageRange).toHaveBeenCalledTimes(1)
  })
})
