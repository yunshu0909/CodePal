/**
 * DSH 前端路径与缓存键测试（TC-08 renderer 侧 + 今日口径）
 *
 * 覆盖：
 * - 今日（renderer 自扫）路径通过 scanDshUsage 通道纳入 DSH 用量
 * - 既有 electronAPI mock 不含新通道时不抛错（可选链守卫）
 * - 本地缓存键已换代，旧键不会继续命中
 *
 * @module tests/dshUsageRenderer
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { aggregateUsage } from '../src/store/usageAggregator'
import { USAGE_CACHE_STORAGE_KEY } from '../src/pages/usage/useUsageCache'

const NOW = new Date('2026-08-13T10:30:00+08:00')

/** 一条 DSH 记录（timestamp 以 IPC 序列化后的 ISO 字符串形式跨进程） */
const DSH_RECORD = {
  timestamp: '2026-08-13T10:00:00.000+08:00',
  model: 'deepseek-v4-flash',
  project: 'proj-a',
  input: 100,
  output: 10,
  cacheRead: 500,
  cacheCreate: 0,
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
  delete window.electronAPI
})

describe('今日路径纳入 DSH 用量', () => {
  it('scanDshUsage 返回的记录进入模型分布与总 Token', async () => {
    window.electronAPI = {
      scanLogFiles: vi.fn(async () => ({ success: true, files: [] })),
      scanDshUsage: vi.fn(async () => ({ success: true, records: [DSH_RECORD] }))
    }

    const result = await aggregateUsage('today')

    expect(result.success).toBe(true)
    const model = result.data.models.find(item => item.name === 'deepseek-v4-flash')
    expect(model).toBeTruthy()
    expect(model.total).toBe(610)
    expect(result.data.total).toBe(610)
    expect(result.data.recordCount).toBe(1)
    expect(result.data.projectDistribution.some(item => item.name === 'proj-a')).toBe(true)
  })

  it('DSH 通道失败时不影响另外两源，也不抛错', async () => {
    window.electronAPI = {
      scanLogFiles: vi.fn(async () => ({ success: true, files: [] })),
      scanDshUsage: vi.fn(async () => { throw new Error('IPC down') })
    }

    const result = await aggregateUsage('today')

    expect(result.success).toBe(true)
    expect(result.data.total).toBe(0)
  })

  it('electronAPI 缺少 scanDshUsage（既有 mock 形态）时不抛错', async () => {
    window.electronAPI = {
      scanLogFiles: vi.fn(async () => ({ success: true, files: [] }))
    }

    const result = await aggregateUsage('today')

    expect(result.success).toBe(true)
    expect(result.data.models).toEqual([])
  })

  it('跨 IPC 的 ISO 字符串时间戳记录被接受并计入（不因时间戳形态而丢数）', async () => {
    window.electronAPI = {
      scanLogFiles: vi.fn(async () => ({ success: true, files: [] })),
      scanDshUsage: vi.fn(async () => ({ success: true, records: [DSH_RECORD] }))
    }
    const scanSpy = window.electronAPI.scanDshUsage

    const result = await aggregateUsage('today')

    // 传下去的参数是 ISO 字符串窗口
    expect(scanSpy).toHaveBeenCalledTimes(1)
    const [params] = scanSpy.mock.calls[0]
    expect(typeof params.start).toBe('string')
    expect(typeof params.end).toBe('string')
    // 字符串时间戳的记录照常计入总量（若归一化被破坏，这里会因 total 为 0/NaN 而失败）
    expect(result.data.total).toBe(610)
    expect(result.data.recordCount).toBe(1)
  })
})

describe('TC-08 renderer 本地缓存键换代', () => {
  it('缓存键不再是含旧口径的 v4 键', () => {
    expect(USAGE_CACHE_STORAGE_KEY).not.toBe('usage-monitor-cache-v4-model-attribution')
    expect(USAGE_CACHE_STORAGE_KEY).toContain('v5')
  })
})
