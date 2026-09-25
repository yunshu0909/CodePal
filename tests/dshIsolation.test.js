/* @vitest-environment node */
/**
 * DSH 隔离进程测试
 *
 * 目的：原生 zstd 解压在本机会因内存状态触发 SIGTRAP（JS 无法捕获）。
 * 隔离后必须保证：**子进程崩溃/超时/报错都不影响主进程**，只是本次窗口降级为无 DSH 数据。
 *
 * @module tests/dshIsolation
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createDshWorkerRunner } = require('../electron/services/dshUsageWorkerClient')
const { scanDshLogs, setDshIsolatedRunner } = require('../electron/services/usageLogScanService')
const { handleDshScanRequest } = require('../electron/services/dshUsageWorker')

const START = new Date('2026-08-13T00:00:00+08:00')
const END = new Date('2026-08-14T00:00:00+08:00')

/** 最小可用的子进程替身 */
function makeFakeChild() {
  const handlers = new Map()
  const child = {
    on: (event, callback) => {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(callback)
    },
    emit: (event, payload) => (handlers.get(event) || []).forEach((callback) => callback(payload)),
    postMessage: vi.fn(),
    kill: vi.fn(),
  }
  return child
}

afterEach(() => {
  setDshIsolatedRunner(null)
})

describe('worker 客户端', () => {
  it('收到 worker 结果时还原时间戳为 Date 并返回记录', async () => {
    const child = makeFakeChild()
    child.postMessage.mockImplementation((message) => {
      child.emit('message', {
        id: message.id,
        ok: true,
        records: [{ timestamp: '2026-08-13T10:00:00.000+08:00', model: 'deepseek-v4-flash', input: 1, output: 1, cacheRead: 1, cacheCreate: 0, project: 'p' }],
      })
    })
    const run = createDshWorkerRunner({ homeDir: '/home/u', forkFn: () => child })

    const records = await run(START, END)

    expect(records).toHaveLength(1)
    expect(records[0].timestamp).toBeInstanceOf(Date)
    expect(records[0].timestamp.getTime()).toBe(Date.parse('2026-08-13T10:00:00.000+08:00'))
  })

  it('子进程崩溃退出时降级为空数组，不抛错', async () => {
    const child = makeFakeChild()
    child.postMessage.mockImplementation(() => child.emit('exit', 1))
    const logger = { warn: vi.fn() }
    const run = createDshWorkerRunner({ homeDir: '/home/u', forkFn: () => child, logger })

    await expect(run(START, END)).resolves.toEqual([])
    expect(logger.warn).toHaveBeenCalled()
  })

  it('没有进行中的扫描时 worker 退出（如应用正常退出）不告警', async () => {
    const child = makeFakeChild()
    child.postMessage.mockImplementation((message) => child.emit('message', { id: message.id, ok: true, records: [] }))
    const logger = { warn: vi.fn() }
    const run = createDshWorkerRunner({ homeDir: '/home/u', forkFn: () => child, logger })
    await run(START, END)
    child.emit('exit', 0)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('worker 返回错误时降级为空数组并留痕', async () => {
    const child = makeFakeChild()
    child.postMessage.mockImplementation((message) => {
      child.emit('message', { id: message.id, ok: false, error: 'BOOM' })
    })
    const logger = { warn: vi.fn() }
    const run = createDshWorkerRunner({ homeDir: '/home/u', forkFn: () => child, logger })

    await expect(run(START, END)).resolves.toEqual([])
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('BOOM'))
  })

  it('超时后杀掉 worker 并降级为空数组', async () => {
    const child = makeFakeChild() // 永不回消息
    const logger = { warn: vi.fn() }
    const run = createDshWorkerRunner({ homeDir: '/home/u', forkFn: () => child, logger, timeoutMs: 5 })

    await expect(run(START, END)).resolves.toEqual([])
    expect(child.kill).toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('timed out'))
  })

  it('启动子进程自身抛错时降级为空数组', async () => {
    const logger = { warn: vi.fn() }
    const run = createDshWorkerRunner({
      homeDir: '/home/u',
      forkFn: () => { throw new Error('spawn failed') },
      logger,
    })

    await expect(run(START, END)).resolves.toEqual([])
    expect(logger.warn).toHaveBeenCalled()
  })
})

describe('scanDshLogs 的隔离注入', () => {
  it('注入执行器后走隔离路径，且不触碰进程内实现', async () => {
    const runner = vi.fn(async () => [{ model: 'deepseek-v4-flash', input: 7 }])
    setDshIsolatedRunner(runner)

    const records = await scanDshLogs(START, END, { homeDir: '/nonexistent' })

    expect(runner).toHaveBeenCalledTimes(1)
    expect(records).toEqual([{ model: 'deepseek-v4-flash', input: 7 }])
  })

  it('隔离执行器抛错时 fail-soft 返回空数组（主进程不受影响）', async () => {
    setDshIsolatedRunner(async () => { throw new Error('worker died') })

    await expect(scanDshLogs(START, END, {})).resolves.toEqual([])
  })

  it('未注入执行器时回落到进程内实现（单测路径）', async () => {
    setDshIsolatedRunner(null)

    // 不存在的 homeDir → 进程内实现直接返回空，不抛
    await expect(scanDshLogs(START, END, { homeDir: '/nonexistent-home' })).resolves.toEqual([])
  })
})

describe('worker 入口协议', () => {
  it('请求参数非法时返回 ok:false 而不是抛出', async () => {
    const response = await handleDshScanRequest({ id: 3, start: 'not-a-date', end: 'not-a-date', homeDir: '/nonexistent-home' })

    expect(response.id).toBe(3)
    expect(response.ok).toBe(true) // 无效时间窗在进程内实现里表现为空结果
    expect(response.records).toEqual([])
  })
})
