/**
 * 会话状态页测试（#41）
 *
 * 负责：对照 specs/状态提醒重做/状态清单-会话状态-草案.md 与 _review/04 交互流程
 * - 进入页面：骨架 → 开着有会话（排序、标签、时间、说明行）
 * - 开局：关着 / 没检测到工具 / 没有会话 / 读取失败 / 一边没装上 + 重试
 * - 打开 / 关掉：成功 Toast；失败红点 Toast、开关退回
 * - 实时更新；告诉主进程本页在前台
 *
 * @module tests/sessionStatusPage
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'
import SessionStatusPage from '../src/pages/SessionStatusPage'
import { formatSessionTime, describeSession, describeTools } from '../src/pages/sessionStatus/sessionStatusView'

const now = Math.floor(Date.now() / 1000)
const SESS = [
  { key: 'a', state: 'attention', epoch: now - 10, name: 'skills', source: 'Codex', task: '整理 ISSUES', ask: '要不要删掉旧分支？' },
  { key: 'b', state: 'busy', epoch: now - 180, name: 'skill-manager', source: 'Claude', task: '修复语音播报' },
  { key: 'c', state: 'done', epoch: now - 720, name: 'codepal-site', source: 'Claude', task: '首页改成新品牌' },
]
const DATA = { enabled: true, tools: { claude: true, codex: true }, hooks: { claude: true, codex: true }, failures: [], sessions: SESS, total: 3, error: null }

let changed
function mockApi(overrides = {}) {
  changed = null
  window.electronAPI = {
    getSessionStatus: vi.fn(async () => ({ success: true, data: DATA })),
    setSessionStatusEnabled: vi.fn(async (on) => ({ success: true, data: { ...DATA, enabled: on, sessions: on ? SESS : [], total: on ? 3 : 0 } })),
    retrySessionStatus: vi.fn(async () => ({ success: true, data: DATA })),
    setSessionStatusPageVisible: vi.fn(async () => ({ success: true })),
    onSessionStatusChanged: vi.fn((cb) => { changed = cb; return () => {} }),
    ...overrides,
  }
}

beforeEach(() => mockApi())
afterEach(() => cleanup())

describe('会话状态页', () => {
  it('骨架 → 开着有会话：等你确认排最前，标签、时间、说明行正确；上报本页在前台', async () => {
    const view = render(<SessionStatusPage />)
    expect(screen.getByTestId('ss-skeleton')).toBeInTheDocument()
    const list = await screen.findByTestId('ss-list')
    const rows = list.querySelectorAll('.np-row')
    expect([...rows].map((r) => r.querySelector('.lb').textContent)).toEqual(['skills', 'skill-manager', 'codepal-site'])
    expect(rows[0].textContent).toContain('Codex · 要不要删掉旧分支？')
    expect(rows[0].querySelector('.np-tag--orange').textContent).toBe('等你确认')
    expect(rows[1].querySelector('.np-tag--blue').textContent).toBe('进行中')
    expect(rows[1].textContent).toContain('3 分钟')
    expect(rows[2].querySelector('.np-tag--green').textContent).toBe('完成了')
    expect(rows[2].textContent).toContain('12 分钟前')
    expect(screen.getByText('3 个')).toBeInTheDocument()
    expect(screen.getByText('Claude Code · Codex')).toBeInTheDocument()
    expect(screen.getByText('会话做完、或停下来等你确认时，会弹系统通知')).toBeInTheDocument()
    expect(window.electronAPI.setSessionStatusPageVisible).toHaveBeenCalledWith(true)
    view.unmount()
    expect(window.electronAPI.setSessionStatusPageVisible).toHaveBeenLastCalledWith(false)
  })

  it('已停止：灰标「已停止」，时间写多久以前', async () => {
    mockApi({ getSessionStatus: vi.fn(async () => ({ success: true, data: { ...DATA, sessions: [{ key: 's', state: 'stopped', epoch: now - 300, name: 'skills', source: 'Codex', task: '整理 ISSUES' }], total: 1 } })) })
    render(<SessionStatusPage />)
    const tag = await screen.findByText('已停止')
    expect(tag).toHaveClass('np-tag--gray')
    expect(screen.getByText('5 分钟前')).toBeInTheDocument()
  })

  it('状态文件一变，列表实时更新', async () => {
    render(<SessionStatusPage />)
    await screen.findByTestId('ss-list')
    act(() => changed({ sessions: [{ ...SESS[1], state: 'done', epoch: now }], total: 1, error: null }))
    expect(screen.getByText('完成了')).toBeInTheDocument()
    expect(screen.queryByText('skills')).toBeNull()
  })

  it('关掉：成功 Toast，列表换成打开提示', async () => {
    render(<SessionStatusPage />)
    await screen.findByTestId('ss-list')
    fireEvent.click(screen.getByRole('switch'))
    expect(await screen.findByText('已关闭会话状态')).toBeInTheDocument()
    expect(window.electronAPI.setSessionStatusEnabled).toHaveBeenCalledWith(false)
    expect(screen.getByText('打开「会话状态」后，这里会实时显示每个会话在干嘛。')).toBeInTheDocument()
  })

  it('打开失败：红点 Toast，开关仍是关', async () => {
    mockApi({
      getSessionStatus: vi.fn(async () => ({ success: true, data: { ...DATA, enabled: false, sessions: [], total: 0 } })),
      setSessionStatusEnabled: vi.fn(async () => ({ success: false, error: '没有权限写入 settings.json' })),
    })
    render(<SessionStatusPage />)
    await screen.findByText('打开「会话状态」后，这里会实时显示每个会话在干嘛。')
    fireEvent.click(screen.getByRole('switch'))
    expect(await screen.findByText('打开失败：没有权限写入 settings.json')).toBeInTheDocument()
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
  })

  it('一边没装上：红字写原因 + 重试', async () => {
    mockApi({ getSessionStatus: vi.fn(async () => ({ success: true, data: { ...DATA, failures: [{ tool: 'codex', label: 'Codex', error: '没有权限写入 config.toml' }] } })) })
    render(<SessionStatusPage />)
    expect(await screen.findByText('没能写入 Codex 的配置：没有权限写入 config.toml')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(window.electronAPI.retrySessionStatus).toHaveBeenCalled())
    expect(await screen.findByText('Claude Code · Codex')).toBeInTheDocument()
  })

  it('开局：没检测到工具 / 没有会话 / 会话读取失败', async () => {
    mockApi({ getSessionStatus: vi.fn(async () => ({ success: true, data: { ...DATA, tools: { claude: false, codex: false }, sessions: [], total: 0 } })) })
    const v1 = render(<SessionStatusPage />)
    expect(await screen.findByText('没检测到 Claude Code 和 Codex。装好其中一个后会自动开始。')).toBeInTheDocument()
    v1.unmount()

    mockApi({ getSessionStatus: vi.fn(async () => ({ success: true, data: { ...DATA, sessions: [], total: 0 } })) })
    const v2 = render(<SessionStatusPage />)
    expect(await screen.findByText('现在没有进行中的会话。在 Claude Code 或 Codex 里开始干活，这里会实时显示。')).toBeInTheDocument()
    v2.unmount()

    mockApi({ getSessionStatus: vi.fn(async () => ({ success: true, data: { ...DATA, sessions: [], total: 0, error: '没有权限读取状态目录' } })) })
    render(<SessionStatusPage />)
    expect(await screen.findByText('读取会话状态失败：没有权限读取状态目录')).toBeInTheDocument()
  })
})

describe('显示规则', () => {
  const nowMs = Date.UTC(2026, 8, 19, 12)
  const ago = (m) => Math.floor(nowMs / 1000) - m * 60
  it('时间写法', () => {
    expect(formatSessionTime(ago(0), 'busy', nowMs)).toBe('刚刚')
    expect(formatSessionTime(ago(3), 'busy', nowMs)).toBe('3 分钟')
    expect(formatSessionTime(ago(12), 'done', nowMs)).toBe('12 分钟前')
    expect(formatSessionTime(ago(130), 'attention', nowMs)).toBe('2 小时前')
  })
  it('说明行与工具', () => {
    expect(describeSession({ state: 'done', source: 'Claude', task: '' })).toBe('Claude')
    expect(describeSession({ state: 'attention', source: 'Codex', task: 'A', ask: '' })).toBe('Codex · A')
    expect(describeTools({ claude: true, codex: false })).toBe('Claude Code')
    expect(describeTools({ claude: false, codex: false })).toBe('—')
  })
})
