/**
 * 导航防护 — 行为测试
 *
 * 负责：
 * - isSafeExternalUrl 协议白名单判定
 * - attachNavigationGuard：外链拦截转系统浏览器、危险协议拦截不打开、dev server 同源放行
 * - setWindowOpenHandler 恒 deny
 *
 * @module tests/safety/navigationGuard.behavior.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  isSafeExternalUrl,
  attachNavigationGuard,
} = require('../../electron/services/navigationGuardService')

/** 构造可手动触发事件的 webContents stub */
function createWebContentsStub() {
  const listeners = new Map()
  let windowOpenHandler = null
  return {
    on: (event, fn) => listeners.set(event, fn),
    setWindowOpenHandler: (fn) => { windowOpenHandler = fn },
    emitWillNavigate(url) {
      const event = { preventDefault: vi.fn() }
      listeners.get('will-navigate')(event, url)
      return event
    },
    invokeWindowOpen(url) {
      return windowOpenHandler({ url })
    },
  }
}

describe('V1.9.8 导航防护', () => {
  let webContents
  let shell

  beforeEach(() => {
    webContents = createWebContentsStub()
    shell = { openExternal: vi.fn().mockResolvedValue(undefined) }
  })

  it('NG-1: isSafeExternalUrl 白名单——https/http/mailto 过，file/javascript/畸形拒', () => {
    expect(isSafeExternalUrl('https://example.com')).toBe(true)
    expect(isSafeExternalUrl('http://example.com/a?b=1')).toBe(true)
    expect(isSafeExternalUrl('mailto:a@b.com')).toBe(true)
    expect(isSafeExternalUrl('file:///etc/passwd')).toBe(false)
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeExternalUrl('not-a-url')).toBe(false)
    expect(isSafeExternalUrl('')).toBe(false)
    expect(isSafeExternalUrl(null)).toBe(false)
  })

  it('NG-2: will-navigate 到外部 https → preventDefault + 转系统浏览器', () => {
    attachNavigationGuard(webContents, { shell })
    const event = webContents.emitWillNavigate('https://evil.example.com/page')
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(shell.openExternal).toHaveBeenCalledWith('https://evil.example.com/page')
  })

  it('NG-3: will-navigate 到 javascript:/畸形 URL → 拦截且不打开任何东西', () => {
    attachNavigationGuard(webContents, { shell })
    for (const url of ['javascript:alert(1)', 'not-a-url']) {
      const event = webContents.emitWillNavigate(url)
      expect(event.preventDefault).toHaveBeenCalledTimes(1)
    }
    expect(shell.openExternal).not.toHaveBeenCalled()
  })

  it('NG-4: dev server 同源导航放行（HMR 不被杀）', () => {
    attachNavigationGuard(webContents, { shell, devServerUrl: 'http://localhost:5173/' })
    const event = webContents.emitWillNavigate('http://localhost:5173/index.html')
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(shell.openExternal).not.toHaveBeenCalled()
  })

  it('NG-5: dev 模式下非同源一律拦截（含 file:）', () => {
    attachNavigationGuard(webContents, { shell, devServerUrl: 'http://localhost:5173/' })
    for (const url of ['http://localhost:9999/x', 'file:///etc/passwd', 'https://example.com']) {
      const event = webContents.emitWillNavigate(url)
      expect(event.preventDefault).toHaveBeenCalledTimes(1)
    }
    // 窗口一律不跳；其中 http/https 属白名单转交系统浏览器，file: 静默拒
    expect(shell.openExternal).toHaveBeenCalledTimes(2)
    expect(shell.openExternal).toHaveBeenCalledWith('http://localhost:9999/x')
    expect(shell.openExternal).toHaveBeenCalledWith('https://example.com')
  })

  it('NG-6: 打包模式（无 devServerUrl）file: 视为自身页面放行', () => {
    attachNavigationGuard(webContents, { shell })
    const event = webContents.emitWillNavigate('file:///Applications/CodePal.app/dist/index.html')
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('NG-7: window.open 恒 deny——安全外链转系统浏览器，危险链接静默拒', () => {
    attachNavigationGuard(webContents, { shell })
    expect(webContents.invokeWindowOpen('https://example.com')).toEqual({ action: 'deny' })
    expect(shell.openExternal).toHaveBeenCalledWith('https://example.com')
    expect(webContents.invokeWindowOpen('javascript:alert(1)')).toEqual({ action: 'deny' })
    expect(shell.openExternal).toHaveBeenCalledTimes(1)
  })
})
