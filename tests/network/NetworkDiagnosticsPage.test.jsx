/**
 * 网络诊断页组件测试
 *
 * 负责：
 * - 按 specs/v2.3-网络诊断重做 AC-20..AC-28 断言页面可观察结果
 * - 从未检测 / 有结果 / 刚变化 / 检测中 / 失败 / 记录与空态 / 开关 Toast
 * - 确认 API 连通性、时间线等旧内容不再出现，检测不弹 Toast
 *
 * @module tests/network/NetworkDiagnosticsPage.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import NetworkDiagnosticsPage from '../../src/pages/NetworkDiagnosticsPage'

const TOKYO = { country: '日本', city: 'Tokyo' }
const base = { isEnabled: false, status: 'idle', current: null, changeLog: [], hasCompared: false, failReason: null, consecutiveFailCount: 0 }
const withIp = (extra = {}) => ({ ...base, status: 'stable', current: { ip: '203.0.113.24', location: TOKYO, checkedAt: Date.now() - 60_000 }, ...extra })

/** 构造桌面端接口；listeners 收集推送订阅 */
function makeApi(state, overrides = {}) {
  const listeners = []
  return {
    listeners,
    getIpMonitorState: vi.fn(async () => ({ success: true, data: state })),
    probeIpOnce: vi.fn(async () => ({ success: true, data: withIp({ hasCompared: true }) })),
    setIpMonitorFastMode: vi.fn(async () => ({ success: true })),
    toggleIpMonitor: vi.fn(async (enabled) => ({ success: true, data: { ...state, isEnabled: enabled } })),
    onIpStateUpdate: vi.fn((cb) => { listeners.push(cb); return () => {} }),
    ...overrides,
  }
}

async function renderPage(state, overrides) {
  const api = makeApi(state, overrides)
  window.electronAPI = api
  const utils = render(<NetworkDiagnosticsPage />)
  await waitFor(() => expect(api.getIpMonitorState).toHaveBeenCalled())
  await screen.findByText('出口 IP')
  return { api, ...utils }
}

const checkButton = () => screen.getByTestId('nd-check')

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  delete window.electronAPI
})

describe('出口 IP 卡', () => {
  it('TC-20 从未检测：状态话 + 说明 + 蓝色主按钮；记录空态', async () => {
    await renderPage(base)
    expect(screen.getByText('还没检测过')).toBeInTheDocument()
    expect(screen.getByText('检测后显示出口 IP、归属地和检测时间')).toBeInTheDocument()
    expect(checkButton()).toHaveTextContent('检测一次')
    expect(checkButton().className).toContain('btn--primary')
    expect(screen.getByText('还没有 IP 变化记录')).toBeInTheDocument()
  })

  it('TC-21 有结果 + 监控开：IP、归属地副行、稳定标签、白按钮', async () => {
    await renderPage(withIp({ isEnabled: true }))
    expect(screen.getByText('203.0.113.24')).toBeInTheDocument()
    expect(screen.getByTestId('nd-sub')).toHaveTextContent('日本 · Tokyo')
    expect(screen.getByTestId('nd-sub')).toHaveTextContent('上次检测')
    expect(screen.getByText('稳定')).toBeInTheDocument()
    expect(checkButton().className).not.toContain('btn--primary')
  })

  it('TC-21 刚变化：橙标签 + 变化行', async () => {
    const log = [{ at: Date.now() - 60_000, fromIp: '198.51.100.24', toIp: '203.0.113.24', fromLocation: null, toLocation: TOKYO, foundByManual: false }]
    await renderPage(withIp({ isEnabled: true, changeLog: log, hasCompared: true }))
    expect(screen.getByText('刚变化')).toBeInTheDocument()
    expect(screen.getByTestId('nd-change')).toHaveTextContent('从 198.51.100.24 变为当前 IP')
  })

  it('TC-22 点检测：按钮禁用「检测中…」，完成后原地更新，不弹 Toast', async () => {
    let resolve
    const { api } = await renderPage(base, { probeIpOnce: vi.fn(() => new Promise((r) => { resolve = r })) })
    fireEvent.click(checkButton())
    expect(checkButton()).toHaveTextContent('检测中…')
    expect(checkButton()).toBeDisabled()
    expect(screen.getByTestId('nd-hero-skeleton')).toBeInTheDocument()
    await act(async () => resolve({ success: true, data: withIp() }))
    expect(await screen.findByText('203.0.113.24')).toBeInTheDocument()
    expect(api.probeIpOnce).toHaveBeenCalledTimes(1)
    expect(document.querySelector('.toast')).toBeNull()
  })

  it('TC-23 失败：「—」+ 原因 + 重试 + 上次成功', async () => {
    await renderPage(withIp({ status: 'failed', failReason: 'timeout' }))
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.getByText('连接检测服务超时，检查网络或代理后重试')).toBeInTheDocument()
    expect(checkButton()).toHaveTextContent('重试')
    expect(screen.getByTestId('nd-last-success')).toHaveTextContent('上次成功 203.0.113.24 · 日本 · Tokyo')
  })

  it('TC-23 后台推送失败不弹 Toast', async () => {
    const { api } = await renderPage(withIp({ isEnabled: true }))
    await act(async () => api.listeners[0]({ ...withIp({ isEnabled: true }), status: 'failed', failReason: 'other', consecutiveFailCount: 3 }))
    expect(screen.getByText('公网 IP 检测失败，请检查网络连接')).toBeInTheDocument()
    expect(document.querySelector('.toast')).toBeNull()
  })
})

describe('变化记录', () => {
  it('TC-24 计数、行、检测时发现', async () => {
    const log = [
      { at: Date.now() - 60_000, fromIp: '203.0.113.24', toIp: '203.0.113.87', fromLocation: null, toLocation: null, foundByManual: true },
      { at: Date.now() - 2 * 60 * 60_000, fromIp: '198.51.100.9', toIp: '203.0.113.24', fromLocation: null, toLocation: null, foundByManual: false },
    ]
    await renderPage(withIp({ changeLog: log, hasCompared: true }))
    expect(screen.getByText('近 7 天 2 次')).toBeInTheDocument()
    expect(screen.getAllByTestId('nd-log-row')).toHaveLength(2)
    expect(screen.getAllByText('检测时发现')).toHaveLength(1)
  })

  it('TC-24 比过但没变：近 7 天没有 IP 变化', async () => {
    await renderPage(withIp({ hasCompared: true }))
    expect(screen.getByText('近 7 天没有 IP 变化')).toBeInTheDocument()
  })
})

describe('持续监控开关', () => {
  it('TC-25 开启成功 Toast；关闭成功 Toast', async () => {
    const { api } = await renderPage(withIp())
    fireEvent.click(screen.getByRole('switch'))
    expect(await screen.findByText('已开启持续监控')).toBeInTheDocument()
    expect(api.toggleIpMonitor).toHaveBeenCalledWith(true)
    fireEvent.click(screen.getByRole('switch'))
    expect(await screen.findByText('已关闭持续监控')).toBeInTheDocument()
  })

  it('TC-25 保存中禁用；失败红 Toast 原文，开关不变', async () => {
    let resolve
    await renderPage(withIp(), { toggleIpMonitor: vi.fn(() => new Promise((r) => { resolve = r })) })
    fireEvent.click(screen.getByRole('switch'))
    expect(screen.getByRole('switch')).toHaveAttribute('aria-disabled', 'true')
    await act(async () => resolve({ success: false, data: withIp(), error: 'PREFERENCE_WRITE_FAILED' }))
    expect(await screen.findByText('无法保存持续监控设置，请重试')).toBeInTheDocument()
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
  })
})

describe('外壳与撤掉的内容', () => {
  it('TC-26 新样式外壳；没有 API 连通性、时间线、轮次', async () => {
    const { container, api } = await renderPage(withIp())
    expect(container.querySelector('.page-shell--native')).not.toBeNull()
    expect(screen.queryByText(/API 连通性|OpenAI|Anthropic|时间线|本轮|检测网络环境是否稳定/)).toBeNull()
    expect(api.setIpMonitorFastMode).toHaveBeenCalledWith(true)
  })
})
