/**
 * 系统通知与「点通知切到本页」测试
 *
 * 负责：
 * - egressNotifier：发通知、保持引用防回收、点击回调后释放
 * - appNavigation：有窗口时恢复聚焦并推送、无窗口时新建并留待领取
 * - IPC 注册：不再有 API 连通性 channel
 *
 * @module tests/network/egressNotifyAndNavigate.test
 */

import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createEgressNotifier } = require('../../electron/services/egressNotifier.js')
const { createNavigationBridge } = require('../../electron/services/appNavigation.js')
const { registerNetworkDiagnosticsHandlers } = require('../../electron/handlers/registerNetworkDiagnosticsHandlers.js')

/** 假的 Electron Notification 类：记录实例，手动触发事件 */
function makeNotificationClass() {
  const instances = []
  class FakeNotification {
    constructor(options) {
      this.options = options
      this.handlers = {}
      this.show = vi.fn()
      instances.push(this)
    }
    on(event, handler) { this.handlers[event] = handler }
    emit(event) { this.handlers[event]?.() }
    static isSupported() { return true }
  }
  return { FakeNotification, instances }
}

describe('egressNotifier', () => {
  it('TC-11 发通知并保持引用；点击调用 onClick 后释放', () => {
    const { FakeNotification, instances } = makeNotificationClass()
    const onClick = vi.fn()
    const notifier = createEgressNotifier({ NotificationClass: FakeNotification, onClick })
    notifier.notify({ kind: 'changed', title: '出口 IP 变了', body: 'a → b' })

    expect(instances).toHaveLength(1)
    expect(instances[0].options).toMatchObject({ title: '出口 IP 变了', body: 'a → b' })
    expect(instances[0].show).toHaveBeenCalled()
    expect(notifier.pendingCount()).toBe(1)

    instances[0].emit('click')
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(notifier.pendingCount()).toBe(0)
  })

  it('TC-11 关闭也释放引用；系统不支持时静默', () => {
    const { FakeNotification, instances } = makeNotificationClass()
    const notifier = createEgressNotifier({ NotificationClass: FakeNotification, onClick: vi.fn() })
    notifier.notify({ kind: 'unreachable', title: 't', body: 'b' })
    instances[0].emit('close')
    expect(notifier.pendingCount()).toBe(0)

    class Unsupported extends FakeNotification { static isSupported() { return false } }
    const quiet = createEgressNotifier({ NotificationClass: Unsupported, onClick: vi.fn() })
    expect(() => quiet.notify({ title: 't', body: 'b' })).not.toThrow()
    expect(quiet.pendingCount()).toBe(0)
  })
})

/** 假窗口 */
function makeWindow({ minimized = false, loading = false } = {}) {
  return {
    isDestroyed: () => false,
    isMinimized: vi.fn(() => minimized),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    webContents: { isLoading: () => loading, send: vi.fn() },
  }
}

describe('appNavigation', () => {
  it('TC-12 有窗口：恢复、显示、聚焦并推送 app:navigate，不留待领取', () => {
    const win = makeWindow({ minimized: true })
    const app = { focus: vi.fn() }
    const nav = createNavigationBridge({ getWindow: () => win, createWindow: vi.fn(), app })
    nav.requestNavigate('network')
    expect(win.restore).toHaveBeenCalled()
    expect(win.show).toHaveBeenCalled()
    expect(win.focus).toHaveBeenCalled()
    expect(app.focus).toHaveBeenCalledWith({ steal: true })
    expect(win.webContents.send).toHaveBeenCalledWith('app:navigate', 'network')
    expect(nav.consumePending()).toBeNull()
  })

  it('TC-12 无窗口：新建窗口，页面挂载时领取一次后清空', () => {
    const createWindow = vi.fn()
    const nav = createNavigationBridge({ getWindow: () => null, createWindow, app: { focus: vi.fn() } })
    nav.requestNavigate('network')
    expect(createWindow).toHaveBeenCalledTimes(1)
    expect(nav.consumePending()).toBe('network')
    expect(nav.consumePending()).toBeNull()
  })

  it('TC-12 窗口还在加载：不推送，留待领取', () => {
    const win = makeWindow({ loading: true })
    const nav = createNavigationBridge({ getWindow: () => win, createWindow: vi.fn(), app: { focus: vi.fn() } })
    nav.requestNavigate('network')
    expect(win.webContents.send).not.toHaveBeenCalled()
    expect(nav.consumePending()).toBe('network')
  })
})

describe('IPC 注册', () => {
  it('TC-10 不再注册 network:probeEndpoints', () => {
    const channels = []
    registerNetworkDiagnosticsHandlers({ ipcMain: { handle: (ch) => channels.push(ch) } })
    expect(channels).toEqual(expect.arrayContaining(['network:getIpMonitorState', 'network:probeIpOnce', 'network:setIpMonitorFastMode', 'network:toggleIpMonitor']))
    expect(channels).not.toContain('network:probeEndpoints')
  })
})
