/**
 * 应用退出统一清理（架构优化 B2-5，roadmap 路线 3 第二步）
 *
 * 负责：
 * - 退出清理登记处：所有停止动作都执行，单项出错不影响其他；整体有最长等待，卡住的不阻塞退出
 * - DSH 子进程可释放；网络监控默认实例可停；排队中的 Codex 配置写入可等完
 * - 主进程退出前先做统一清理再真正退出，且只做一次
 *
 * @module tests/lifecycle/appShutdown.test
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createShutdownRegistry } = require('../../electron/services/appLifecycle')
const { createDshWorkerRunner } = require('../../electron/services/dshUsageWorkerClient')
const network = require('../../electron/services/networkDiagnosticsService')
const owner = require('../../electron/services/codexConfigOwner')

describe('B2-5 退出清理登记处', () => {
  it('X-1 所有停止动作都执行；某项抛错不影响其他，并在报告里标出', async () => {
    const calls = []
    const registry = createShutdownRegistry({ timeoutMs: 1000 })
    registry.register('a', () => { calls.push('a') })
    registry.register('b', async () => { calls.push('b'); throw new Error('boom') })
    registry.register('c', async () => { calls.push('c') })
    const report = await registry.shutdown()
    expect(calls.sort()).toEqual(['a', 'b', 'c'])
    expect(report).toEqual(expect.arrayContaining([{ name: 'b', status: 'failed' }, { name: 'a', status: 'done' }, { name: 'c', status: 'done' }]))
  })

  it('X-2 卡住的停止动作不会阻塞退出（超时后照常结束）', async () => {
    const registry = createShutdownRegistry({ timeoutMs: 50 })
    registry.register('hang', () => new Promise(() => {}))
    registry.register('ok', () => {})
    const started = Date.now()
    const report = await registry.shutdown()
    expect(Date.now() - started).toBeLessThan(1000)
    expect(report).toEqual(expect.arrayContaining([{ name: 'hang', status: 'timeout' }, { name: 'ok', status: 'done' }]))
  })

  it('X-3 只执行一次：重复调用 shutdown 返回同一个结果', async () => {
    const stop = vi.fn()
    const registry = createShutdownRegistry({ timeoutMs: 100 })
    registry.register('x', stop)
    const [r1, r2] = await Promise.all([registry.shutdown(), registry.shutdown()])
    expect(stop).toHaveBeenCalledTimes(1)
    expect(r1).toBe(r2)
  })
})

describe('B2-5 各模块可停', () => {
  it('X-4 DSH 子进程可释放：结束子进程，等待中的请求降级返回', async () => {
    const child = Object.assign(new EventEmitter(), { postMessage: vi.fn(), kill: vi.fn() })
    const runner = createDshWorkerRunner({ homeDir: '/h', forkFn: () => child, logger: { warn() {} } })
    const pending = runner(new Date(), new Date())
    await runner.dispose()
    expect(child.kill).toHaveBeenCalled()
    await expect(pending).resolves.toEqual([])
  })

  it('X-5 网络监控默认实例可停；Codex 配置写入队列可等完', async () => {
    expect(typeof network.stopIpMonitor).toBe('function')
    network.stopIpMonitor()
    expect(typeof owner.drainConfigQueue).toBe('function')
    let finished = false
    owner.withConfigLock(async () => { await new Promise((r) => setTimeout(r, 30)); finished = true })
    await owner.drainConfigQueue()
    expect(finished).toBe(true)
  })

  it('X-6 主进程退出前统一清理再退出，登记了全部后台任务', () => {
    const main = readFileSync(path.resolve(__dirname, '..', '..', 'electron', 'main.js'), 'utf-8')
    const quit = main.slice(main.indexOf("app.on('before-quit'"), main.indexOf("app.on('before-quit'") + 600)
    expect(quit).toMatch(/preventDefault\(\)/)
    expect(quit).toMatch(/shutdown\(\)/)
    for (const name of ['usage-scheduler', 'session-status', 'network-monitor', 'dsh-worker', 'repo-watcher', 'codex-config-writes']) {
      expect(main).toMatch(new RegExp(`register\\('${name}'`))
    }
  })
})
