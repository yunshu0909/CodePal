import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createRequire } from 'node:module'
import ClaudeEnvironmentPage from '../../src/features/claudeEnvironment/ClaudeEnvironmentPage'
const require = createRequire(import.meta.url)
const { present, cleanNetwork } = require('../../electron/modules/claudeEnvironment/state')
function fixture(patch = {}) {
  return present({ metadata: { supported: true, available: true, entryManaged: true, expectedIp: '203.0.113.24', proxyPort: 17897, fingerprint: 'same' }, sample: { checkedAt: Date.now(), fingerprint: 'same', network: cleanNetwork({ proxyReady: true, isolationActive: true, egress: { ok: true, ip: '203.0.113.24', country: 'US' }, dns: { complete: true, resolvers: [{ ip: '198.51.100.53', country: 'US' }] } }) }, monitoring: true, busy: false, history: [], lastSuccess: null, revision: 10, ...patch })
}
function apiFor(state) {
  const listeners = new Set()
  return {
    listeners,
    claudeEnvironmentRead: vi.fn(async () => ({ success: true, data: state })),
    claudeEnvironmentProbe: vi.fn(async () => ({ success: true, data: state })),
    claudeEnvironmentForeground: vi.fn(async () => ({ success: true })),
    claudeEnvironmentSetMonitoring: vi.fn(async value => ({ success: true, data: { ...state, monitoring: value, revision: 20 } })),
    onClaudeEnvironmentState: vi.fn(callback => { listeners.add(callback); return () => listeners.delete(callback) }),
  }
}
afterEach(() => { cleanup(); delete window.electronAPI; vi.restoreAllMocks() })

describe('B 方案：五项环境检查', () => {
  it('显示真实接口五项状态，每行可以打开原因并用 Escape 关闭', async () => {
    window.electronAPI = apiFor(fixture())
    render(<ClaudeEnvironmentPage />)
    expect(await screen.findByText('203.0.113.24', { selector: '.ce-ip' })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /^(出口网络|DNS 解析器|专用代理|启动器固定 IP|启动入口)：/ })).toHaveLength(5)
    fireEvent.click(screen.getByRole('button', { name: 'DNS 解析器：美国' }))
    expect(screen.getByRole('dialog', { name: 'DNS 解析器详情' })).toHaveTextContent('不回退系统 DNS')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('过期时不出现绿色分项；历史 IP 仍明确标明历史结果', async () => {
    const state = fixture()
    state.stale = true
    state.code = 'stale'
    state.tone = 'orange'
    state.label = '结果已过期'
    state.checks = state.checks.map(check => ({ ...check, kind: 'unknown', label: `上次：${check.label}` }))
    window.electronAPI = apiFor(state)
    render(<ClaudeEnvironmentPage />)
    await screen.findByText('结果已过期')
    expect(document.querySelectorAll('.ce-check .np-st.off')).toHaveLength(5)
    expect(document.querySelector('.ce-ip')).toHaveClass('na')
    expect(screen.getByText(/历史结果/)).toBeInTheDocument()
  })

  it('晚到的读取不能覆盖已经推送的新一轮结果，卸载后取消订阅', async () => {
    let finish
    const api = apiFor(fixture())
    api.claudeEnvironmentRead.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    window.electronAPI = api
    const component = render(<ClaudeEnvironmentPage />)
    const newest = { ...fixture(), revision: 30, egress: { ip: '203.0.113.68', country: 'US' } }
    act(() => api.listeners.forEach(callback => callback(newest)))
    await act(async () => { finish({ success: true, data: fixture() }) })
    expect(screen.getByText('203.0.113.68', { selector: '.ce-ip' })).toBeInTheDocument()
    component.unmount()
    expect(api.listeners.size).toBe(0)
    expect(api.claudeEnvironmentForeground).toHaveBeenLastCalledWith(false)
  })

  it('开关保存失败时保留原值，并通过全局 Toast 给出失败原因', async () => {
    const api = apiFor(fixture())
    api.claudeEnvironmentSetMonitoring.mockResolvedValue({ success: false, error: { message: '设置未保存' } })
    window.electronAPI = api
    render(<ClaudeEnvironmentPage />)
    const control = await screen.findByRole('switch', { name: '持续监测' })
    await waitFor(() => expect(control).toHaveAttribute('aria-checked', 'true'))
    await act(async () => { fireEvent.click(control) })
    await waitFor(() => expect(api.claudeEnvironmentSetMonitoring).toHaveBeenCalledWith(false))
    expect(control).toHaveAttribute('aria-checked', 'true')
    expect(await screen.findByText('设置未保存')).toBeInTheDocument()
  })
})
