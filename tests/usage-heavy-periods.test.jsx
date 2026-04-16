/**
 * 用量重任务互斥回归测试
 *
 * 负责：
 * - 验证重任务运行中不会启动第二个 heavy task
 * - 验证首个任务完成后仍能正常回填缓存
 *
 * @module tests/usage-heavy-periods.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import useUsageHeavyPeriods from '../src/pages/usage/useUsageHeavyPeriods'

const EMPTY_USAGE_RESULT = {
  total: 100,
  input: 20,
  output: 30,
  cacheRead: 40,
  cacheCreate: 10,
  models: [],
  distribution: [],
  projectDistribution: [],
  isExtremeScenario: false,
  modelCount: 0
}

describe('useUsageHeavyPeriods', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    delete window.electronAPI
  })

  it('blocks a second heavy task while the first request is still running', async () => {
    let resolveFirstRequest
    const aggregateUsagePeriod = vi.fn(() => new Promise((resolve) => {
      resolveFirstRequest = () => resolve({
        success: true,
        data: EMPTY_USAGE_RESULT
      })
    }))

    window.electronAPI = {
      onUsageAggregationProgress: vi.fn(() => () => {}),
      aggregateUsagePeriod,
      aggregateUsageRange: vi.fn()
    }

    const updatePeriodCache = vi.fn()
    const setCustomData = vi.fn()
    const setError = vi.fn()

    const { result } = renderHook(() => useUsageHeavyPeriods({
      periodCache: {
        today: null,
        week: null,
        month: null,
        allTime: null
      },
      customData: null,
      updatePeriodCache,
      setCustomData,
      setError
    }))

    let firstPromise

    await act(async () => {
      firstPromise = result.current.runHeavyPeriodTask('allTime', undefined, {
        hasFallbackData: false
      })
    })

    expect(result.current.heavyTask.status).toBe('running')
    expect(aggregateUsagePeriod).toHaveBeenCalledTimes(1)

    let secondResult
    await act(async () => {
      secondResult = await result.current.runHeavyPeriodTask('week', {
        startDate: '2026-04-09',
        endDate: '2026-04-15'
      }, {
        hasFallbackData: false
      })
    })

    expect(secondResult).toMatchObject({
      success: false,
      busy: true,
      error: 'HEAVY_TASK_RUNNING'
    })
    expect(aggregateUsagePeriod).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveFirstRequest()
      await firstPromise
    })

    expect(updatePeriodCache).toHaveBeenCalledTimes(1)
    expect(result.current.heavyTask.status).toBe('idle')
  })
})
