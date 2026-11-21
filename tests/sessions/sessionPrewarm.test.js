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
import fsp from 'node:fs/promises'
import path from 'node:path'
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

  it('主窗口加载完 0.1 秒后在后台读一次对话列表，之后的窗口不再读', async () => {
    const app = new EventEmitter()
    const service = { listRecent: vi.fn(async () => ({ projectsDirExists: true, sessions: [] })) }
    registerSessionBrowserHandlers({ ipcMain, service, app })

    const main = fakeWindow()
    app.emit('browser-window-created', {}, main)
    await vi.advanceTimersByTimeAsync(5000)
    expect(service.listRecent).not.toHaveBeenCalled() // 页面还没加载完，不抢启动

    main.webContents.emit('did-finish-load')
    await vi.advanceTimersByTimeAsync(99)
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
      await vi.advanceTimersByTimeAsync(100)
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

describe('启动预读和页面不重复扫描', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  function setup() {
    const app = new EventEmitter()
    const handlers = {}
    const service = { listRecent: vi.fn(async () => ({ projectsDirExists: true, sessions: [] })) }
    registerSessionBrowserHandlers({ ipcMain: { handle: (ch, fn) => { handlers[ch] = fn } }, service, app })
    return { app, handlers, service }
  }

  it('页面在预读开始前就要了列表，预读不再跑', async () => {
    const { app, handlers, service } = setup()
    const main = fakeWindow()
    app.emit('browser-window-created', {}, main)
    main.webContents.emit('did-finish-load')
    await handlers['session:listRecent']()
    await vi.advanceTimersByTimeAsync(5000)
    expect(service.listRecent).toHaveBeenCalledTimes(1)
  })

  it('第一个窗口没加载完就关了，下一个窗口加载完照样预读', async () => {
    const { app, service } = setup()
    app.emit('browser-window-created', {}, fakeWindow()) // 没加载完就关了
    const reopened = fakeWindow()
    app.emit('browser-window-created', {}, reopened)
    reopened.webContents.emit('did-finish-load')
    await vi.advanceTimersByTimeAsync(100)
    expect(service.listRecent).toHaveBeenCalledTimes(1)
  })
})

// 让一次扫描停在「目录已枚举、正在核对某个文件」那一刻
function pauseAtFile(suffix) {
  const real = fsp.realpath.bind(fsp)
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const state = { paused: false, release: () => release() }
  const spy = vi.spyOn(fsp, 'realpath').mockImplementation(async (target) => {
    if (!state.paused && String(target).endsWith(suffix)) { state.paused = true; await gate }
    return real(target)
  })
  state.waitPaused = async () => { while (!state.paused) await new Promise((resolve) => setTimeout(resolve, 1)) }
  state.restore = () => spy.mockRestore()
  return state
}

describe('预读途中进页', () => {
  let p
  beforeEach(() => { p = makeProjectsDir(); process.env.CODEPAL_CLAUDE_PROJECTS_DIR = p.dir })
  afterEach(() => { delete process.env.CODEPAL_CLAUDE_PROJECTS_DIR; vi.restoreAllMocks(); p.cleanup() })

  it('没变的文件接上在途读取不重读，各拿一份互不影响的结果', async () => {
    const lines = stamp([L.user('shared')], { cwd: '/fixture/project' })
    p.write('-a', 's1', lines)
    // 同样内容单独列一次，作为「读一遍」的字节数
    const solo = makeProjectsDir()
    solo.write('-a', 's1', lines)
    reader.resetReaderStats()
    await svc.listRecent({ projectsDir: solo.dir })
    const single = reader.getReaderStats().bytesRead
    solo.cleanup()
    reader.resetReaderStats()
    const [a, b] = await Promise.all([svc.listRecent(), svc.listRecent()])
    expect(reader.getReaderStats().bytesRead).toBe(single)
    expect(a).toEqual(b)
    a.sessions[0].title = 'changed'
    expect(b.sessions[0].title).toBe('shared')
  })

  it('预读已经枚举过目录后新增、删除的对话，进页这一次就看得到', async () => {
    p.write('-a', 's1', stamp([L.user('one')], { cwd: '/fixture/project' }))
    const doomed = p.write('-a', 's3', stamp([L.user('doomed')], { cwd: '/fixture/project' }))
    const pause = pauseAtFile('s1.jsonl')
    const prewarm = svc.listRecent()
    await pause.waitPaused()
    p.write('-a', 's2', stamp([L.user('two')], { cwd: '/fixture/project' }))
    fs.unlinkSync(doomed)
    const page = svc.listRecent()
    pause.release()
    const { sessions } = await page
    await prewarm
    pause.restore()
    expect(sessions.map((s) => s.title).sort()).toEqual(['one', 'two'])
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

  it('整个来源目录被删掉，索引里的条目也清掉', async () => {
    p.write('-a', 's1', stamp([L.user('one')], { cwd: '/fixture/project' }))
    p.write('-b', 's2', stamp([L.user('two')], { cwd: '/fixture/project' }))
    const options = { projectsDir: p.dir }
    const base = svc.metadataIndexSizeForTests()
    await svc.listRecent(options)
    expect(svc.metadataIndexSizeForTests()).toBe(base + 2)
    fs.rmSync(p.dir, { recursive: true, force: true })
    expect((await svc.listRecent(options)).sessions).toEqual([])
    expect(svc.metadataIndexSizeForTests()).toBe(base)
  })

  it('子目录一时读不了，不把它的条目当成删掉', async () => {
    p.write('-a', 's1', stamp([L.user('one')], { cwd: '/fixture/project' }))
    const options = { projectsDir: p.dir }
    const base = svc.metadataIndexSizeForTests()
    await svc.listRecent(options)
    const real = fsp.readdir.bind(fsp)
    const spy = vi.spyOn(fsp, 'readdir').mockImplementation((dir, ...rest) => (
      String(dir).endsWith(`${path.sep}-a`) ? Promise.reject(Object.assign(new Error('busy'), { code: 'EMFILE' })) : real(dir, ...rest)))
    await svc.listRecent(options)
    expect(svc.metadataIndexSizeForTests()).toBe(base + 1)
    spy.mockRestore()
    reader.resetReaderStats()
    expect((await svc.listRecent(options)).sessions).toHaveLength(1)
    expect(reader.getReaderStats().bytesRead).toBe(0)
  })

  it('先开始的扫描后结束，不清掉后开始的扫描新建的条目', async () => {
    p.write('-a', 's1', stamp([L.user('old')], { cwd: '/fixture/project' }))
    const options = { projectsDir: p.dir }
    await svc.listRecent(options)
    const pause = pauseAtFile('s1.jsonl')
    const stale = svc.listRecent(options)
    await pause.waitPaused()
    p.write('-a', 's2', stamp([L.user('new')], { cwd: '/fixture/project' }))
    await svc.listRecent(options)
    pause.release()
    await stale
    pause.restore()
    reader.resetReaderStats()
    expect((await svc.listRecent(options)).sessions).toHaveLength(2)
    expect(reader.getReaderStats().bytesRead).toBe(0)
  })

  it('项目目录暂时移走又移回：旧扫描没看见它，后开始的扫描复用了它，旧扫描结束也不清', async () => {
    p.write('-a', 's1', stamp([L.user('one')], { cwd: '/fixture/project' }))
    p.write('-b', 's2', stamp([L.user('two')], { cwd: '/fixture/project' }))
    const options = { projectsDir: p.dir }
    await svc.listRecent(options)
    fs.renameSync(path.join(p.dir, '-b'), path.join(p.dir, '.moved'))
    const pause = pauseAtFile('s1.jsonl')
    const stale = svc.listRecent(options)
    await pause.waitPaused()
    fs.renameSync(path.join(p.dir, '.moved'), path.join(p.dir, '-b'))
    await svc.listRecent(options)
    pause.release()
    await stale
    pause.restore()
    reader.resetReaderStats()
    expect((await svc.listRecent(options)).sessions).toHaveLength(2)
    expect(reader.getReaderStats().bytesRead).toBe(0)
  })

  it('扫描途中项目目录被删掉，这一次就把它的条目清掉', async () => {
    p.write('-a', 's1', stamp([L.user('one')], { cwd: '/fixture/project' }))
    p.write('-b', 's2', stamp([L.user('two')], { cwd: '/fixture/project' }))
    const options = { projectsDir: p.dir }
    const base = svc.metadataIndexSizeForTests()
    await svc.listRecent(options)
    expect(svc.metadataIndexSizeForTests()).toBe(base + 2)
    const real = fsp.readdir.bind(fsp)
    vi.spyOn(fsp, 'readdir').mockImplementation(async (dir, ...rest) => {
      const result = await real(dir, ...rest)
      // 根目录刚枚举完，项目 -b 就被删了
      if (String(dir) === fs.realpathSync(p.dir)) fs.rmSync(path.join(p.dir, '-b'), { recursive: true, force: true })
      return result
    })
    expect((await svc.listRecent(options)).sessions).toHaveLength(1)
    expect(svc.metadataIndexSizeForTests()).toBe(base + 1)
  })

  it('来源目录的链接换了目标，旧目标的条目清掉', async () => {
    const other = makeProjectsDir()
    const linkParent = fs.mkdtempSync(path.join(fs.realpathSync(p.dir), '..', 'codepal-link-'))
    try {
      p.write('-a', 's1', stamp([L.user('one')], { cwd: '/fixture/project' }))
      p.write('-a', 's2', stamp([L.user('two')], { cwd: '/fixture/project' }))
      other.write('-c', 's3', stamp([L.user('three')], { cwd: '/fixture/project' }))
      const link = path.join(linkParent, 'projects')
      fs.symlinkSync(p.dir, link)
      const options = { projectsDir: link }
      const base = svc.metadataIndexSizeForTests()
      await svc.listRecent(options)
      expect(svc.metadataIndexSizeForTests()).toBe(base + 2)
      fs.unlinkSync(link)
      fs.symlinkSync(other.dir, link)
      expect((await svc.listRecent(options)).sessions.map((s) => s.title)).toEqual(['three'])
      expect(svc.metadataIndexSizeForTests()).toBe(base + 1)
    } finally {
      other.cleanup()
      fs.rmSync(linkParent, { recursive: true, force: true })
    }
  })
})
