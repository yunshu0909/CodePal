/**
 * v2.2 Harness IPC 注册器测试
 *
 * 关注契约而非实现：恒返回 {success, data, error}、错误只走白名单码、
 * 写操作后必须带上重读的快照。
 *
 * @module tests/v22/harnessHandlers
 */

import { describe, expect, it, vi } from 'vitest'

const modulePath = '../../electron/handlers/registerHarnessHandlers.js'

/** 造一个只记录 handler 的假 ipcMain。 */
function makeIpcMain() {
  const handlers = new Map()
  return {
    handlers,
    handle: vi.fn((channel, handler) => { handlers.set(channel, handler) }),
  }
}

async function loadRegister() {
  const module = await import(/* @vite-ignore */ modulePath)
  return (module.default || module).registerHarnessHandlers
}

const SNAPSHOT = { install: { kind: 'managed', version: '0.1.5-rc.2' }, runtime: { running: false } }

describe('v2.2 Harness IPC handlers', () => {
  it('SC-401 registers one channel per lifecycle operation', async () => {
    const registerHarnessHandlers = await loadRegister()
    const ipcMain = makeIpcMain()
    registerHarnessHandlers({ ipcMain, homeDir: '/tmp/home' }, {})
    expect([...ipcMain.handlers.keys()].sort()).toEqual([
      'harness:get-snapshot',
      'harness:install',
      'harness:list-versions',
      'harness:restart',
      'harness:set-keepalive',
      'harness:set-stop-on-quit',
      'harness:start',
      'harness:stop',
      'harness:uninstall',
      'harness:update',
    ])
  })

  it('SC-402 returns the snapshot on the happy path', async () => {
    const registerHarnessHandlers = await loadRegister()
    const ipcMain = makeIpcMain()
    registerHarnessHandlers({ ipcMain, homeDir: '/tmp/home' }, {
      getHarnessSnapshotFn: vi.fn(async () => SNAPSHOT),
    })
    const result = await ipcMain.handlers.get('harness:get-snapshot')({})
    expect(result).toEqual({ success: true, data: SNAPSHOT, error: null })
  })

  it('SC-403 maps a thrown coded error to its whitelisted code', async () => {
    const registerHarnessHandlers = await loadRegister()
    const ipcMain = makeIpcMain()
    const failure = new Error('HARNESS_NODE_UNSUPPORTED')
    failure.code = 'HARNESS_NODE_UNSUPPORTED'
    registerHarnessHandlers({ ipcMain, homeDir: '/tmp/home' }, {
      getHarnessSnapshotFn: vi.fn(async () => { throw failure }),
    })
    const result = await ipcMain.handlers.get('harness:get-snapshot')({})
    expect(result).toEqual({ success: false, data: null, error: 'HARNESS_NODE_UNSUPPORTED' })
  })

  it('SC-404 never leaks raw stderr or an absolute path through the error channel', async () => {
    const registerHarnessHandlers = await loadRegister()
    const ipcMain = makeIpcMain()
    const failure = new Error('npm ERR! /Users/secret/.npm/_logs/debug.log: EACCES token=abc123')
    failure.stderr = 'npm ERR! /Users/secret/.npm/_logs/debug.log'
    registerHarnessHandlers({ ipcMain, homeDir: '/tmp/home' }, {
      installHarnessFn: vi.fn(async () => { throw failure }),
    })
    const result = await ipcMain.handlers.get('harness:install')({}, { channel: 'latest' })
    expect(result.success).toBe(false)
    expect(result.error).toBe('HARNESS_NPM_FAILED')
    expect(JSON.stringify(result)).not.toContain('/Users/secret')
    expect(JSON.stringify(result)).not.toContain('token=')
  })

  it('SC-405 returns a fresh snapshot after a write operation', async () => {
    const registerHarnessHandlers = await loadRegister()
    const ipcMain = makeIpcMain()
    const snapshot = vi.fn(async () => SNAPSHOT)
    registerHarnessHandlers({ ipcMain, homeDir: '/tmp/home' }, {
      getHarnessSnapshotFn: snapshot,
      startHarnessFn: vi.fn(async () => ({ pid: 4242, port: 51423, url: 'http://127.0.0.1:51423/' })),
    })
    const result = await ipcMain.handlers.get('harness:start')({})
    expect(result.success).toBe(true)
    expect(result.data.pid).toBe(4242)
    expect(result.data.snapshot).toEqual(SNAPSHOT)
    expect(snapshot).toHaveBeenCalled()
  })

  it('SC-406 passes the channel through and reports a failed uninstall readably', async () => {
    const registerHarnessHandlers = await loadRegister()
    const ipcMain = makeIpcMain()
    const install = vi.fn(async () => ({ version: '0.1.5-rc.4', channel: 'next', changed: true }))
    const update = vi.fn(async () => ({ kind: 'managed', adopted: true, version: '0.1.5-rc.2' }))
    const failure = new Error('HARNESS_NOT_INSTALLED')
    failure.code = 'HARNESS_NOT_INSTALLED'
    registerHarnessHandlers({ ipcMain, homeDir: '/tmp/home' }, {
      getHarnessSnapshotFn: vi.fn(async () => SNAPSHOT),
      installHarnessFn: install,
      updateHarnessFn: update,
      uninstallHarnessFn: vi.fn(async () => { throw failure }),
    })
    await ipcMain.handlers.get('harness:install')({}, { channel: 'next' })
    expect(install).toHaveBeenCalledWith(expect.objectContaining({ channel: 'next', homeDir: '/tmp/home' }), expect.anything())
    await ipcMain.handlers.get('harness:update')({}, { takeover: true })
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ takeover: true, homeDir: '/tmp/home' }), expect.anything())
    const result = await ipcMain.handlers.get('harness:uninstall')({}, {})
    expect(result).toEqual({ success: false, data: null, error: 'HARNESS_NOT_INSTALLED' })
  })

  it('SC-407 forwards the purge opt-in and the stop-on-quit preference', async () => {
    const registerHarnessHandlers = await loadRegister()
    const ipcMain = makeIpcMain()
    const uninstall = vi.fn(async () => ({ removed: true, purgedData: true }))
    const setStopOnQuit = vi.fn((value) => value !== false)
    registerHarnessHandlers({ ipcMain, homeDir: '/tmp/home' }, {
      getHarnessSnapshotFn: vi.fn(async () => SNAPSHOT),
      uninstallHarnessFn: uninstall,
      setStopOnQuit,
    })
    await ipcMain.handlers.get('harness:uninstall')({}, { purgeData: true })
    expect(uninstall).toHaveBeenCalledWith(expect.objectContaining({ purgeData: true }), expect.anything())
    // 缺省必须是不清除
    await ipcMain.handlers.get('harness:uninstall')({}, {})
    expect(uninstall).toHaveBeenLastCalledWith(expect.objectContaining({ purgeData: false }), expect.anything())

    const result = await ipcMain.handlers.get('harness:set-stop-on-quit')({}, { enabled: false })
    expect(result).toEqual({ success: true, data: { stopOnQuit: false }, error: null })
    expect(setStopOnQuit).toHaveBeenCalledWith(false)
  })

  it('SC-408 preserves the configured source checkout in every lifecycle call', async () => {
    const registerHarnessHandlers = await loadRegister()
    const ipcMain = makeIpcMain()
    const getSnapshot = vi.fn(async () => SNAPSHOT)
    registerHarnessHandlers({
      ipcMain,
      homeDir: '/tmp/home',
      sourceDir: '/tmp/deepseek-harness',
    }, {
      getHarnessSnapshotFn: getSnapshot,
    })

    await ipcMain.handlers.get('harness:get-snapshot')({})
    expect(getSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ homeDir: '/tmp/home', sourceDir: '/tmp/deepseek-harness' }),
      expect.anything(),
    )
  })
})
