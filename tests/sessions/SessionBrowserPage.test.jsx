/**
 * 对话回顾页组件测试
 *
 * 负责：
 * - 按 specs/v2.4-对话回顾重做 AC-30..AC-45 断言页面可观察结果
 * - 列表页（分组、行、空态、失败、筛选、搜索）与对话页（顶部块、消息流、分页、复制、启动、快捷键）
 * - electronAPI 全部是假的，不读真实对话
 *
 * @module tests/sessions/SessionBrowserPage.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import SessionBrowserPage from '../../src/pages/SessionBrowserPage'
import { resetSessionCacheForTests } from '../../src/hooks/useSessionBrowser'

const HOUR = 3600_000
const MIN = 60_000
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString()
const pad = (n) => String(n).padStart(2, '0')
const hm = (msAgo) => { const d = new Date(Date.now() - msAgo); return `${pad(d.getHours())}:${pad(d.getMinutes())}` }

const ID1 = '11111111-1111-4111-8111-111111111111'
const ID2 = '22222222-2222-4222-8222-222222222222'
const ID3 = '33333333-3333-4333-8333-333333333333'
const IDA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const session = (o) => ({
  projectId: '-p-skills', projectPath: '/Users/x/Documents/skills', projectName: 'skills', parentDir: '~/Documents',
  branch: 'master', preview: null, auto: false, ...o,
})
const SESSIONS = [
  session({ sessionId: ID1, title: '网络诊断页重做', preview: 'OK 启动新版本我看看', modifiedAt: iso(5 * MIN) }),
  session({ sessionId: IDA, title: '审核 packet', preview: '只回复 OK', auto: true, projectId: '-tmp-evidence', projectPath: '/tmp/evidence', projectName: 'evidence', parentDir: '/tmp', modifiedAt: iso(6 * MIN) }),
  session({ sessionId: ID2, title: null, preview: null, projectId: '-p-sm', projectPath: '/Users/x/Documents/trae_projects/skill-manager', projectName: 'skill-manager', parentDir: '~/Documents/trae_projects', branch: 'feat/x', modifiedAt: iso(10 * MIN) }),
  session({ sessionId: ID3, title: '调度器接入飞书通知', preview: '通知没收到', projectId: '-p-diaodu', projectPath: '/Users/x/diaodu', projectName: 'diaodu', parentDir: '~', modifiedAt: iso(10 * 24 * HOUR) }),
]

const msg = (offset, kind, text, toolUses = []) => ({ offset, kind, text, toolUses, timestamp: iso(HOUR) })
const PAGE = { messages: [msg(10, 'ask', '侧边栏换了 你合并进去?'), msg(20, 'answer', '', [{ name: 'Read', target: 'a.js' }, { name: 'Bash', target: 'npm test' }, { name: 'Edit', target: 'b.js' }]), msg(30, 'answer', '合并好了'), { offset: 40, kind: 'compact' }, msg(50, 'ask', 'OK 启动新版本我看看'), msg(60, 'answer', '新版本已经启动了')], hasMore: false, cursor: 0 }

function makeApi(overrides = {}) {
  return {
    listRecentSessions: vi.fn(async () => ({ success: true, data: { projectsDirExists: true, sessions: SESSIONS }, error: null })),
    readSession: vi.fn(async () => ({ success: true, data: PAGE, error: null })),
    searchSessions: vi.fn(async () => ({ success: true, data: [], error: null })),
    readSessionCwd: vi.fn(async () => ({ success: true, cwd: '/Users/x/Documents/skills', cwdExists: true })),
    launchSessionInTerminal: vi.fn(async () => ({ success: true })),
    ...overrides,
  }
}

let api
let clipboard
async function renderPage(overrides) {
  api = makeApi(overrides)
  window.electronAPI = api
  const utils = render(<SessionBrowserPage />)
  await waitFor(() => expect(api.listRecentSessions).toHaveBeenCalled())
  return utils
}
const rows = () => Array.from(document.querySelectorAll('.np-row--rec'))
const rowByTitle = (t) => rows().find((r) => r.textContent.includes(t))
const toastText = () => Array.from(document.querySelectorAll('.toast')).map((t) => t.textContent).join('|')

async function openFirst() {
  await waitFor(() => expect(rowByTitle('网络诊断页重做')).toBeTruthy())
  fireEvent.click(rowByTitle('网络诊断页重做'))
  await screen.findByText('新版本已经启动了')
}

beforeEach(() => {
  resetSessionCacheForTests()
  localStorage.clear()
  clipboard = { writeText: vi.fn(async () => {}) }
  Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  delete window.electronAPI
})

describe('列表页', () => {
  it('TC-30 外壳、筛选行、分组、行的各部分；默认不含自动调用；没有删除 / 树 / 分隔条', async () => {
    const { container } = await renderPage()
    await waitFor(() => expect(rows()).toHaveLength(3))
    expect(container.querySelector('.page-shell--native')).not.toBeNull()
    expect(container.querySelector('.page-shell__title')).toHaveTextContent('对话回顾')
    expect(screen.getByPlaceholderText('搜索对话')).toBeInTheDocument()
    expect(container.querySelector('.np-popbtn')).toHaveTextContent('全部项目')
    const labels = Array.from(container.querySelectorAll('.np-glabel')).map((g) => g.textContent)
    expect(labels).toEqual(['今天2', '更早1'])
    const r = rowByTitle('网络诊断页重做')
    expect(r.querySelector('.np-ic')).not.toBeNull()
    expect(r.querySelector('.ds')).toHaveTextContent('OK 启动新版本我看看')
    expect(r.querySelector('.np-rec-end')).toHaveTextContent(`skills${hm(5 * MIN)}`)
    expect(r.querySelector('.np-rec-end svg')).not.toBeNull()
    const untitled = rowByTitle('（无标题）')
    expect(untitled.querySelector('.ds')).toBeNull()
    expect(rowByTitle('审核 packet')).toBeUndefined()
    expect(screen.queryByText(/删除/)).toBeNull()
    expect(container.querySelector('.sb-project-list, .sb-resizer, [class*="resizer"]')).toBeNull()
  })

  it('TC-31 第一次出骨架；再次进页面直接出上次列表不出骨架；窗口回到前台静默刷新', async () => {
    let resolve
    api = makeApi({ listRecentSessions: vi.fn(() => new Promise((r) => { resolve = r })) })
    window.electronAPI = api
    const first = render(<SessionBrowserPage />)
    expect(document.querySelector('.np-sk')).not.toBeNull()
    // 列表骨架两条灰线间距 4（定稿 B1 vstack g4；对话页骨架才是 8）（code 门 F-04）
    expect(document.querySelector('.np-row--rec .sr-sk-lines--list')).not.toBeNull()
    await act(async () => resolve({ success: true, data: { projectsDirExists: true, sessions: SESSIONS } }))
    await waitFor(() => expect(rows()).toHaveLength(3))
    first.unmount()

    api.listRecentSessions = vi.fn(() => new Promise(() => {}))
    render(<SessionBrowserPage />)
    expect(rows()).toHaveLength(3)
    expect(document.querySelector('.np-sk')).toBeNull()
    expect(api.listRecentSessions).toHaveBeenCalledTimes(1)
    act(() => { window.dispatchEvent(new Event('focus')) })
    expect(api.listRecentSessions).toHaveBeenCalledTimes(2)
  })

  it('TC-32 三种空态', async () => {
    await renderPage({ listRecentSessions: vi.fn(async () => ({ success: true, data: { projectsDirExists: true, sessions: [] } })) })
    expect(await screen.findByText('还没有对话')).toBeInTheDocument()
    expect(screen.getByText('在终端里用 Claude Code 聊过之后，会出现在这里')).toBeInTheDocument()
    // 空态图标：StateView 把 emptyIcon 包进 <svg viewBox="0 0 16 16">（code 门 F-02）
    expect(document.querySelector('.state-view__icon svg path')).not.toBeNull()
    cleanup(); resetSessionCacheForTests()

    await renderPage({ listRecentSessions: vi.fn(async () => ({ success: true, data: { projectsDirExists: false, sessions: [] } })) })
    expect(await screen.findByText('没有找到 Claude Code 的对话记录')).toBeInTheDocument()
    cleanup(); resetSessionCacheForTests()

    await renderPage({ listRecentSessions: vi.fn(async () => ({ success: true, data: { projectsDirExists: true, sessions: [SESSIONS[1]] } })) })
    expect(await screen.findByText('只有插件、脚本自动调用产生的对话')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '显示自动调用的对话' }))
    await waitFor(() => expect(rowByTitle('审核 packet')).toBeTruthy())
    const auto = rowByTitle('审核 packet')
    expect(within(auto).getByText('自动')).toHaveClass('np-tag--gray')
    expect(auto.querySelector('.np-ic').style.getPropertyValue('--c')).toBe('var(--ic-gray)')
  })

  it('TC-33 读取失败 + 重试', async () => {
    await renderPage({ listRecentSessions: vi.fn(async () => ({ success: false, data: null, error: 'EACCES: permission denied' })) })
    expect(await screen.findByText('读取失败')).toBeInTheDocument()
    expect(screen.getByText('EACCES: permission denied')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(api.listRecentSessions).toHaveBeenCalledTimes(2))
  })

  it('TC-34 项目菜单：内容、选项目、勾自动、记住选择', async () => {
    const { container } = await renderPage()
    await waitFor(() => expect(rows()).toHaveLength(3))
    fireEvent.click(container.querySelector('.np-popbtn'))
    const menu = container.querySelector('.np-menu')
    expect(menu).not.toBeNull()
    expect(within(menu).getByText('全部项目').closest('.np-mitem')).toHaveTextContent('✓')
    const item = (name) => within(menu).getByText(name).closest('.np-mitem')
    expect(item('skills')).toHaveTextContent('~/Documents · 1 个对话')
    expect(item('skill-manager')).toHaveTextContent('~/Documents/trae_projects · 1 个对话')
    expect(item('diaodu')).toHaveTextContent('~ · 1 个对话')
    expect(within(menu).queryByText('evidence')).toBeNull()
    expect(within(menu).getByText('显示自动调用的对话')).toBeInTheDocument()
    expect(within(menu).getByText('插件、脚本在后台调用 Claude Code 产生的')).toBeInTheDocument()

    fireEvent.click(within(menu).getByText('skill-manager'))
    expect(container.querySelector('.np-menu')).toBeNull()
    expect(container.querySelector('.np-popbtn')).toHaveTextContent('skill-manager')
    expect(rows()).toHaveLength(1)
    expect(JSON.parse(localStorage.getItem('codepal.sessions.filter'))).toEqual({ projectPath: '/Users/x/Documents/trae_projects/skill-manager', includeAuto: false })

    fireEvent.click(container.querySelector('.np-popbtn'))
    fireEvent.click(within(container.querySelector('.np-menu')).getByText('全部项目'))
    fireEvent.click(container.querySelector('.np-popbtn'))
    fireEvent.click(within(container.querySelector('.np-menu')).getByText('显示自动调用的对话'))
    await waitFor(() => expect(rows()).toHaveLength(4))

    cleanup()
    render(<SessionBrowserPage />)
    await waitFor(() => expect(rows()).toHaveLength(4))
  })

  it('TC-34 localStorage 读写抛错时用默认值', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
    const { container } = await renderPage()
    await waitFor(() => expect(rows()).toHaveLength(3))
    fireEvent.click(container.querySelector('.np-popbtn'))
    fireEvent.click(within(container.querySelector('.np-menu')).getByText('diaodu'))
    expect(rows()).toHaveLength(1)
  })
})

describe('搜索', () => {
  const hits = (n) => Array.from({ length: n }, (_, i) => ({ projectId: '-p-skills', sessionId: i === 0 ? ID1 : `h${i}`, snippet: `前面 通知 后面 ${i}`, offset: 50 }))

  it('TC-35 防抖、搜索中、结果组与命中高亮、范围参数', async () => {
    let resolve
    const { container } = await renderPage({ searchSessions: vi.fn(() => new Promise((r) => { resolve = r })) })
    await waitFor(() => expect(rows()).toHaveLength(3))
    const input = screen.getByPlaceholderText('搜索对话')
    fireEvent.change(input, { target: { value: '通知' } })
    expect(api.searchSessions).not.toHaveBeenCalled()
    await waitFor(() => expect(api.searchSessions).toHaveBeenCalledWith('通知', { projectPath: null, includeAuto: false }), { timeout: 1000 })
    expect(screen.getByText('搜索中...')).toBeInTheDocument()
    await act(async () => resolve({ success: true, data: [hits(1)[0], { projectId: '-p-diaodu', sessionId: ID3, snippet: '通知没收到', offset: 5 }] }))
    await waitFor(() => expect(rows()).toHaveLength(2))
    expect(container.querySelector('.np-glabel')).toHaveTextContent('搜索结果2')
    expect(rowByTitle('网络诊断页重做').querySelector('.ds mark.np-hit')).toHaveTextContent('通知')
  })

  it('TC-35 只有空格不搜；50 条上限提示；无结果 + 清除搜索；Esc 清空', async () => {
    await renderPage({ searchSessions: vi.fn(async (kw) => ({ success: true, data: kw === '通知' ? hits(50) : [] })) })
    await waitFor(() => expect(rows()).toHaveLength(3))
    const input = screen.getByPlaceholderText('搜索对话')
    fireEvent.change(input, { target: { value: '   ' } })
    await new Promise((r) => setTimeout(r, 400))
    expect(api.searchSessions).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: '通知' } })
    expect(await screen.findByText('只显示前 50 条，换个更具体的词试试', {}, { timeout: 1000 })).toBeInTheDocument()

    fireEvent.change(input, { target: { value: '飞书机器人' } })
    expect(await screen.findByText('无匹配结果', {}, { timeout: 1000 })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '清除搜索' }))
    await waitFor(() => expect(rows()).toHaveLength(3))
    expect(input).toHaveValue('')

    fireEvent.change(input, { target: { value: '通知' } })
    await screen.findByText('搜索结果', { exact: false }, { timeout: 1000 })
    fireEvent.keyDown(input, { key: 'Escape' })
    await waitFor(() => expect(rows()).toHaveLength(3))
    expect(input).toHaveValue('')
  })
  it('TC-35 搜索范围跟随当前筛选；× 清除钮', async () => {
    const { container } = await renderPage()
    await waitFor(() => expect(rows()).toHaveLength(3))
    fireEvent.click(container.querySelector('.np-popbtn'))
    fireEvent.click(within(container.querySelector('.np-menu')).getByText('diaodu'))
    fireEvent.click(container.querySelector('.np-popbtn'))
    fireEvent.click(within(container.querySelector('.np-menu')).getByText('显示自动调用的对话'))
    const input = screen.getByPlaceholderText('搜索对话')
    fireEvent.change(input, { target: { value: '通知' } })
    await waitFor(() => expect(api.searchSessions).toHaveBeenCalledWith('通知', { projectPath: '/Users/x/diaodu', includeAuto: true }), { timeout: 1000 })
    await screen.findByText('无匹配结果')
    fireEvent.click(container.querySelector('.np-sf .np-sf-clear'))
    expect(input).toHaveValue('')
    await waitFor(() => expect(rows()).toHaveLength(1))
  })
})

describe('对话页', () => {
  it('TC-36 点行：顶部块立刻出、正文骨架、读完出消息；返回保留搜索与滚动位置；Esc 返回', async () => {
    let resolve
    const { container } = await renderPage({ readSession: vi.fn(() => new Promise((r) => { resolve = r })) })
    await waitFor(() => expect(rows()).toHaveLength(3))
    container.querySelector('.np-scroll').scrollTop = 120
    fireEvent.click(rowByTitle('网络诊断页重做'))

    const hd = container.querySelector('.np-detail-hd')
    expect(within(hd).getByRole('button', { name: '‹ 对话回顾' })).toBeInTheDocument()
    expect(hd).toHaveTextContent('网络诊断页重做')
    expect(hd).toHaveTextContent(`skills · master · 今天 ${hm(5 * MIN)}`)
    expect(within(hd).getByRole('button', { name: '复制 resume 参数' })).toHaveClass('btn--primary')
    expect(within(hd).getByRole('button', { name: '新终端启动' })).toBeInTheDocument()
    expect(container.querySelector('.np-detail-body .np-sk')).not.toBeNull()
    expect(api.readSession).toHaveBeenCalledWith('-p-skills', ID1, { limit: 200 })
    await act(async () => resolve({ success: true, data: PAGE }))
    expect(await screen.findByText('新版本已经启动了')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '‹ 对话回顾' }))
    await waitFor(() => expect(rows()).toHaveLength(3))
    expect(container.querySelector('.np-scroll').scrollTop).toBe(120)

    // 第二次打开：读取正常返回（上面的挂起 Promise 只为观察骨架）
    api.readSession.mockResolvedValue({ success: true, data: PAGE, error: null })
    fireEvent.click(rowByTitle('网络诊断页重做'))
    await screen.findByText('新版本已经启动了')
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(rows()).toHaveLength(3))
  })

  it('TC-37 消息流：气泡、署名、工具块展开、压缩行、开头日期行；滚到顶加载更早', async () => {
    const older = { messages: [msg(1, 'ask', '最早的提问')], hasMore: false, cursor: 0 }
    const readSession = vi.fn(async (_p, _s, opts) => ({ success: true, data: opts.before ? older : { ...PAGE, hasMore: true, cursor: 10 } }))
    const { container } = await renderPage({ readSession })
    await openFirst()
    expect(container.querySelectorAll('.np-ask')).toHaveLength(2)
    expect(container.querySelectorAll('.np-sender')[0]).toHaveTextContent('Claude')
    const tools = screen.getByText('3 次工具调用')
    fireEvent.click(tools)
    expect(screen.getByText('Read · a.js')).toBeInTheDocument()
    expect(screen.getByText('Bash · npm test')).toBeInTheDocument()
    expect(screen.getByText('以上内容已压缩')).toBeInTheDocument()
    expect(container.querySelector('.np-msg-when')).toBeNull()

    const body = container.querySelector('.np-detail-body')
    let resolveOlder
    readSession.mockImplementationOnce(() => new Promise((r) => { resolveOlder = r }))
    body.scrollTop = 0
    fireEvent.scroll(body)
    fireEvent.scroll(body) // 一次滑动连着来两个 scroll 事件：只读一次
    expect(await screen.findByText('正在加载更早的消息…')).toBeInTheDocument()
    expect(readSession.mock.calls.filter(([, , o]) => o.before === 10)).toHaveLength(1)
    expect(readSession).toHaveBeenLastCalledWith('-p-skills', ID1, { limit: 200, before: 10 })
    await act(async () => resolveOlder({ success: true, data: older }))
    expect(await screen.findByText('最早的提问')).toBeInTheDocument()
    expect(container.querySelector('.np-msg-when').textContent).toMatch(/^\d{1,2}月\d{1,2}日 \d{2}:\d{2}$/)
  })

  it('TC-38 对话读取失败：整块 + 重试；按钮照常可用', async () => {
    const readSession = vi.fn(async () => ({ success: false, data: null, error: 'ENOENT: no such file' }))
    await renderPage({ readSession })
    await waitFor(() => expect(rowByTitle('网络诊断页重做')).toBeTruthy())
    fireEvent.click(rowByTitle('网络诊断页重做'))
    expect(await screen.findByText('读取失败')).toBeInTheDocument()
    expect(screen.getByText('ENOENT: no such file')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: '复制 resume 参数' })).not.toBeDisabled())
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(readSession).toHaveBeenCalledTimes(2))
  })

  it('TC-39 复制：命令内容；成功与失败 Toast', async () => {
    await renderPage()
    await openFirst()
    await waitFor(() => expect(api.readSessionCwd).toHaveBeenCalledWith({ projectId: '-p-skills', sessionId: ID1 }))
    fireEvent.click(screen.getByRole('button', { name: '复制 resume 参数' }))
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledWith(`cd "/Users/x/Documents/skills" && claude --resume ${ID1}`))
    await waitFor(() => expect(toastText()).toContain('resume 命令已复制到剪贴板'))

    clipboard.writeText.mockRejectedValueOnce(new Error('denied'))
    fireEvent.click(screen.getByRole('button', { name: '复制 resume 参数' }))
    await waitFor(() => expect(toastText()).toContain('复制失败'))
    expect(toastText()).not.toContain('请手动')
  })

  it('TC-40 新终端启动：启动中禁用；成功 / 失败 Toast；结束恢复', async () => {
    let resolve
    await renderPage({ launchSessionInTerminal: vi.fn(() => new Promise((r) => { resolve = r })) })
    await openFirst()
    await waitFor(() => expect(screen.getByRole('button', { name: '新终端启动' })).not.toBeDisabled())
    fireEvent.click(screen.getByRole('button', { name: '新终端启动' }))
    expect(screen.getByRole('button', { name: '启动中…' })).toBeDisabled()
    expect(api.launchSessionInTerminal).toHaveBeenCalledWith({ cwd: '/Users/x/Documents/skills', uuid: ID1 })
    await act(async () => resolve({ success: true }))
    await waitFor(() => expect(toastText()).toContain('已在新 Terminal 窗口启动 Claude Code'))
    expect(screen.getByRole('button', { name: '新终端启动' })).not.toBeDisabled()

    api.launchSessionInTerminal.mockResolvedValueOnce({ success: false, error: 'x' })
    fireEvent.click(screen.getByRole('button', { name: '新终端启动' }))
    await waitFor(() => expect(toastText()).toContain('Terminal 启动失败，可以改用"复制 resume 参数"'))
  })

  it('TC-41 原目录已删：只禁启动；读不到工作目录：两个都禁', async () => {
    await renderPage({ readSessionCwd: vi.fn(async () => ({ success: true, cwd: '/Users/x/gone', cwdExists: false })) })
    await openFirst()
    await waitFor(() => expect(screen.getByRole('button', { name: '新终端启动' })).toBeDisabled())
    expect(screen.getByRole('button', { name: '新终端启动' })).toHaveAttribute('title', '原项目目录已不存在：/Users/x/gone')
    expect(screen.getByRole('button', { name: '复制 resume 参数' })).not.toBeDisabled()
    cleanup(); resetSessionCacheForTests()

    await renderPage({ readSessionCwd: vi.fn(async () => ({ success: true, cwd: null, cwdExists: false })) })
    await openFirst()
    await waitFor(() => expect(screen.getByRole('button', { name: '复制 resume 参数' })).toBeDisabled())
    expect(screen.getByRole('button', { name: '新终端启动' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '复制 resume 参数' })).toHaveAttribute('title', '读不到这个对话的工作目录')
  })

  it('TC-42 从搜索结果进去：往前加载到命中那条、高亮并加框；返回回到结果', async () => {
    const tail = { messages: [msg(500, 'ask', '最后的提问'), msg(510, 'answer', '最后的回答')], hasMore: true, cursor: 500 }
    const earlier = { messages: [msg(100, 'ask', '要不要做通知功能'), msg(110, 'answer', '通知只做两种')], hasMore: false, cursor: 0 }
    const readSession = vi.fn(async (_p, _s, opts) => ({ success: true, data: opts.before ? earlier : tail }))
    const { container } = await renderPage({
      readSession,
      searchSessions: vi.fn(async () => ({ success: true, data: [{ projectId: '-p-skills', sessionId: ID1, snippet: '要不要做通知功能', offset: 100 }] })),
    })
    await waitFor(() => expect(rows()).toHaveLength(3))
    fireEvent.change(screen.getByPlaceholderText('搜索对话'), { target: { value: '通知' } })
    await waitFor(() => expect(rows()).toHaveLength(1), { timeout: 1000 })
    fireEvent.click(rows()[0])
    await screen.findByText('最后的回答')
    await waitFor(() => expect(readSession).toHaveBeenCalledWith('-p-skills', ID1, { limit: 200, before: 500 }))
    await waitFor(() => expect(container.querySelectorAll('.np-detail-body mark.np-hit').length).toBeGreaterThanOrEqual(2))
    expect(container.querySelector('.sr-hit-first')).toHaveTextContent('要不要做通知功能')
    fireEvent.click(screen.getByRole('button', { name: '‹ 对话回顾' }))
    await waitFor(() => expect(container.querySelector('.np-glabel')).toHaveTextContent('搜索结果1'))
  })

  it('TC-43 对话页每 10 秒与回到前台时补读新消息', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const readSession = vi.fn(async () => ({ success: true, data: PAGE }))
    await renderPage({ readSession })
    await openFirst()
    const newer = { ...PAGE, messages: [...PAGE.messages, msg(70, 'ask', '新来的提问')] }
    readSession.mockResolvedValue({ success: true, data: newer })
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(await screen.findByText('新来的提问')).toBeInTheDocument()
    const calls = readSession.mock.calls.length
    act(() => { window.dispatchEvent(new Event('focus')) })
    await waitFor(() => expect(readSession.mock.calls.length).toBe(calls + 1))
    expect(screen.getAllByText('新来的提问')).toHaveLength(1)
  })
})

describe('键盘', () => {
  it('TC-44 列表页 ↑↓ / Enter / ⌘F / Esc；对话页 Esc / ⌘⇧C / ⌘↩', async () => {
    await renderPage()
    await waitFor(() => expect(rows()).toHaveLength(3))
    const [r1, r2] = rows()
    r1.focus()
    fireEvent.keyDown(r1, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(r2)
    fireEvent.keyDown(r2, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(r1)

    fireEvent.keyDown(window, { key: 'f', metaKey: true })
    expect(document.activeElement).toBe(screen.getByPlaceholderText('搜索对话'))

    r1.focus()
    fireEvent.keyDown(r1, { key: 'Enter' })
    await screen.findByText('新版本已经启动了')
    await waitFor(() => expect(screen.getByRole('button', { name: '新终端启动' })).not.toBeDisabled())
    fireEvent.keyDown(window, { key: 'c', metaKey: true, shiftKey: true })
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalled())
    fireEvent.keyDown(window, { key: 'Enter', metaKey: true })
    await waitFor(() => expect(api.launchSessionInTerminal).toHaveBeenCalled())
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(rows()).toHaveLength(3))
  })
})
