// @vitest-environment node
/**
 * 对话回顾启动预读（#102）
 *
 * 负责：
 * - 主窗口加载完后在后台读一次对话列表，同一次运行只读一次，出错不外抛
 * - 内存索引不因闲置过期：启动很久后才进页，没变的对话文件也不重读
 *
 * @module tests/sessions/sessionPrewarm.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { L, stamp, makeProjectsDir } from './fixtures'

const require = createRequire(import.meta.url)
const { registerSessionBrowserHandlers } = require('../../electron/handlers/registerSessionBrowserHandlers.js')
const svc = require('../../electron/services/sessionBrowserService')
const reader = require('../../electron/services/sessionFileReader')

const ipcMain = { handle: () => {} }

function fakeWindow() {
  return { webContents: new EventEmitter() }
}

describe('启动预读', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('主窗口加载完 0.3 秒后在后台读一次对话列表，之后的窗口不再读', async () => {
    const app = new EventEmitter()
    const service = { listRecent: vi.fn(async () => ({ projectsDirExists: true, sessions: [] })) }
    registerSessionBrowserHandlers({ ipcMain, service, app })

    const main = fakeWindow()
    app.emit('browser-window-created', {}, main)
    await vi.advanceTimersByTimeAsync(5000)
    expect(service.listRecent).not.toHaveBeenCalled() // 页面还没加载完，不抢启动

    main.webContents.emit('did-finish-load')
    await vi.advanceTimersByTimeAsync(299)
    expect(service.listRecent).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(service.listRecent).toHaveBeenCalledTimes(1)

    // 页面重载、关于窗口、关窗再开都不再读第二次
    main.webContents.emit('did-finish-load')
    const second = fakeWindow()
    app.emit('browser-window-created', {}, second)
    second.webContents.emit('did-finish-load')
    await vi.advanceTimersByTimeAsync(5000)
    expect(service.listRecent).toHaveBeenCalledTimes(1)
  })

  it('后台读取出错只留日志，不变成未处理的错误', async () => {
    const app = new EventEmitter()
    const service = { listRecent: vi.fn(async () => { throw new Error('没有权限读取 ~/.claude/projects') }) }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      registerSessionBrowserHandlers({ ipcMain, service, app })
      const main = fakeWindow()
      app.emit('browser-window-created', {}, main)
      main.webContents.emit('did-finish-load')
      await vi.advanceTimersByTimeAsync(300)
      await vi.runAllTimersAsync()
      expect(service.listRecent).toHaveBeenCalledTimes(1)
      vi.useRealTimers() // 未处理的拒绝在下一轮事件循环前上报，用真定时器等一轮
      await new Promise((resolve) => setImmediate(resolve))
      expect(unhandled).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
      warn.mockRestore()
    }
  })
})

describe('内存索引不因闲置过期', () => {
  let p
  beforeEach(() => { p = makeProjectsDir() })
  afterEach(() => { vi.restoreAllMocks(); p.cleanup() })

  it('读过一次后过了 11 分钟再要列表，没变的对话文件不重读', async () => {
    p.write('-a', 's1', stamp([L.user('first'), L.answer('ok')], { cwd: '/fixture/project' }))
    p.write('-a', 's2', stamp([L.user('second'), L.answer('ok')], { cwd: '/fixture/project' }))
    const options = { projectsDir: p.dir }
    const first = await svc.listRecent(options)
    const realNow = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(realNow + 11 * 60_000)
    reader.resetReaderStats()
    expect(await svc.listRecent(options)).toEqual(first)
    expect(reader.getReaderStats().bytesRead).toBe(0)
  })

  it('过了很久，变了的对话照样重读、删掉的照样消失', async () => {
    const changed = p.write('-a', 's1', stamp([L.user('before')], { cwd: '/fixture/project' }))
    const removed = p.write('-a', 's2', stamp([L.user('gone')], { cwd: '/fixture/project' }))
    const options = { projectsDir: p.dir }
    await svc.listRecent(options)
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60 * 60_000)
    fs.appendFileSync(changed, JSON.stringify(L.aiTitle('after')) + '\n')
    fs.unlinkSync(removed)
    const { sessions } = await svc.listRecent(options)
    expect(sessions.map((s) => s.title)).toEqual(['after'])
  })

  it('删掉的对话文件，下一次列表后从内存索引里清掉', async () => {
    p.write('-a', 's1', stamp([L.user('keep')], { cwd: '/fixture/project' }))
    const removed = p.write('-a', 's2', stamp([L.user('gone')], { cwd: '/fixture/project' }))
    const options = { projectsDir: p.dir }
    const base = svc.metadataIndexSizeForTests()
    await svc.listRecent(options)
    expect(svc.metadataIndexSizeForTests()).toBe(base + 2)
    fs.unlinkSync(removed)
    await svc.listRecent(options)
    expect(svc.metadataIndexSizeForTests()).toBe(base + 1)
  })
})
