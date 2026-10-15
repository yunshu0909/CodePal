/** v2.1.25 · 插件管理页（界面行为）；版式另在真实窗口按 W1–W9 截图对照
 * 假 window.electronAPI：devPluginRead / devPluginSetEnabled 可控返回；Toast 全局入口打桩。
 * 新页面用 import() 载入，写实现前先失败于 Failed to resolve import。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

vi.mock('../../src/components/Toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
  default: () => null,
  resetToastForTests: vi.fn(),
}))
const { toast } = await import('../../src/components/Toast')
const { default: Page } = await import('../../src/features/devPlugin/DevPluginPage.jsx')

const end = (patch = {}) => ({ installed: true, enabled: true, locked: false, ...patch })
function state(patch = {}) {
  return { versionText: '0.12.22', claude: end(), codex: end(), saving: { claude: false, codex: false }, ...patch }
}
const ok = (data) => ({ success: true, data, error: null })
const fail = (code, message) => ({ success: false, data: null, error: { code, message } })
const deferred = () => {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}
function api({ read = () => Promise.resolve(ok(state())), set = (p) => Promise.resolve(ok({ status: 'saved', enabled: p.enabled })) } = {}) {
  const a = { devPluginRead: vi.fn(read), devPluginSetEnabled: vi.fn(set) }
  window.electronAPI = a
  return a
}
async function show() {
  const view = render(<Page />)
  await act(async () => {})
  return view
}
const rowOf = (name) => [...document.querySelectorAll('[data-dev-tool]')].find((el) => el.textContent.includes(name))
const toggleOf = (name) => rowOf(name).querySelector('[role="switch"]')
const checked = (name) => toggleOf(name).getAttribute('aria-checked') === 'true'
const disabled = (name) => toggleOf(name).getAttribute('aria-disabled') === 'true'

beforeEach(() => vi.clearAllMocks())
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  delete window.electronAPI
})

it('TC-101 打开插件管理：身份卡与版本号、两行「装在 …」都开', async () => {
  api()
  await show()
  expect(screen.getByText('dev-workflow')).toBeTruthy()
  expect(screen.getByText('需求 → 测试 → 交叉审核 → 验收的开发流程插件')).toBeTruthy()
  expect(screen.getByText('0.12.22')).toBeTruthy()
  expect(screen.getByText('启用')).toBeTruthy()
  expect(rowOf('Claude Code').textContent).toContain('装在 ~/.claude/skills/dev-workflow')
  expect(rowOf('Codex').textContent).toContain('装在 ~/.codex 插件缓存')
  expect(checked('Claude Code') && checked('Codex')).toBe(true)
})

it('TC-101 停在页面不自动刷新：外部改了要离开再进入才显示（后-08-例1）', async () => {
  let current = state()
  const a = api({ read: () => Promise.resolve(ok(current)) })
  const view = await show()
  current = state({ codex: end({ enabled: false }) })
  await act(async () => { window.dispatchEvent(new Event('focus')) })
  expect(checked('Codex')).toBe(true)
  view.unmount()
  await show()
  expect(checked('Codex')).toBe(false)
  expect(a.devPluginRead).toHaveBeenCalledTimes(2)
})

it('TC-103 读取中：两行原位出骨架，没有报错或空态', async () => {
  const d = deferred()
  api({ read: () => d.promise })
  await show()
  expect(document.querySelectorAll('.np-sk').length).toBeGreaterThan(0)
  expect(screen.queryByText('读取失败')).toBeNull()
  expect(screen.queryByText('没装这个插件')).toBeNull()
})

it('TC-104 读不出：整块「读取失败」+ 原因 + 重试；点重试再读一次', async () => {
  let calls = 0
  const a = api({ read: () => (++calls === 1 ? Promise.resolve(fail('read_failed', '读不了 ~/.claude/settings.json：没有权限')) : Promise.resolve(ok(state()))) })
  await show()
  expect(screen.getByText('读取失败')).toBeTruthy()
  expect(screen.getByText(/读不了 ~\/\.claude\/settings\.json/)).toBeTruthy()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重试' })) })
  expect(a.devPluginRead).toHaveBeenCalledTimes(2)
  expect(screen.getByText('0.12.22')).toBeTruthy()
})

it('TC-113 读取超过 10 秒没有结果：按读取失败显示', async () => {
  vi.useFakeTimers()
  api({ read: () => new Promise(() => {}) })
  render(<Page />)
  await act(async () => { vi.advanceTimersByTime(10_001) })
  expect(screen.getByText('读取失败')).toBeTruthy()
  expect(screen.getByText(/读取超过 10 秒没有结果/)).toBeTruthy()
})

it('TC-105 一边没装：写「没装这个插件」、开关关且不能点；两边都没装版本位写「没装」', async () => {
  api({ read: () => Promise.resolve(ok(state({ versionText: '没装', claude: end({ installed: false, enabled: false }), codex: end({ installed: false, enabled: false }) }))) })
  await show()
  expect(rowOf('Codex').textContent).toContain('没装这个插件')
  expect(disabled('Codex')).toBe(true)
  expect(checked('Codex')).toBe(false)
  expect(screen.getByText('没装')).toBeTruthy()
})

it('TC-106 最小窗口：页面只有身份卡和启用卡两块（版式在真实窗口 720 × 500 截图对照）', async () => {
  api()
  const { container } = await show()
  expect(container.querySelectorAll('.np-card').length).toBe(2)
  expect(container.querySelector('.np-scroll')).toBeTruthy()
})

it('TC-107 关 Codex 成功：只传工具和开关值，弹写明全局设置的成功提示；Claude 一行不动', async () => {
  const a = api()
  await show()
  await act(async () => { fireEvent.click(toggleOf('Codex')) })
  expect(a.devPluginSetEnabled).toHaveBeenCalledTimes(1)
  expect(a.devPluginSetEnabled.mock.calls[0][0]).toEqual({ tool: 'codex', enabled: false })
  expect(toast.success).toHaveBeenCalledWith('Codex 已在全局设置里停用 dev-workflow，新开的会话生效')
  expect(checked('Codex')).toBe(false)
  expect(checked('Claude Code')).toBe(true)
})

it('TC-107 关 Claude Code 成功：提示「Claude Code 已在全局设置里停用 dev-workflow，新开的会话生效」', async () => {
  api()
  await show()
  await act(async () => { fireEvent.click(toggleOf('Claude Code')) })
  expect(toast.success).toHaveBeenCalledWith('Claude Code 已在全局设置里停用 dev-workflow，新开的会话生效')
  expect(checked('Claude Code')).toBe(false)
})

it('TC-108 保存中：开关先变关并禁用、说明「正在保存…」；Claude 一行不受影响', async () => {
  const d = deferred()
  api({ set: () => d.promise })
  await show()
  await act(async () => { fireEvent.click(toggleOf('Codex')) })
  expect(checked('Codex')).toBe(false)
  expect(disabled('Codex')).toBe(true)
  expect(rowOf('Codex').textContent).toContain('正在保存…')
  expect(disabled('Claude Code')).toBe(false)
  await act(async () => { d.resolve(ok({ status: 'saved', enabled: false })) })
  expect(disabled('Codex')).toBe(false)
})

it('TC-109 没改成：红色提示、开关退回原值、行里不留字', async () => {
  api({ set: () => Promise.resolve(fail('failed', '没改成：~/.codex/config.toml 写不进去')) })
  await show()
  await act(async () => { fireEvent.click(toggleOf('Codex')) })
  expect(toast.error).toHaveBeenCalledWith('没改成：~/.codex/config.toml 写不进去')
  expect(checked('Codex')).toBe(true)
  expect(rowOf('Codex').textContent).not.toContain('没改成')
  expect(toast.success).not.toHaveBeenCalled()
})

it('TC-109 别处改过：提示「插件状态刚被别处改过，已重新读取」并按重读结果显示这一行', async () => {
  let current = state()
  const a = api({
    read: () => Promise.resolve(ok(current)),
    set: () => { current = state({ codex: end({ installed: false, enabled: false }) }); return Promise.resolve(fail('changed', '插件状态刚被别处改过，已重新读取')) },
  })
  await show()
  await act(async () => { fireEvent.click(toggleOf('Codex')) })
  expect(toast.warning).toHaveBeenCalledWith('插件状态刚被别处改过，已重新读取')
  expect(a.devPluginRead).toHaveBeenCalledTimes(2)
  expect(rowOf('Codex').textContent).toContain('没装这个插件')
})

it('TC-110 不能点的开关：没装时点击不发请求；被系统管理设置锁定时显示说明并禁用', async () => {
  const a = api({ read: () => Promise.resolve(ok(state({ codex: end({ installed: false, enabled: false }), claude: end({ enabled: false, locked: true }) }))) })
  await show()
  await act(async () => { fireEvent.click(toggleOf('Codex')) })
  await act(async () => { fireEvent.click(toggleOf('Claude Code')) })
  expect(a.devPluginSetEnabled).not.toHaveBeenCalled()
  expect(rowOf('Claude Code').textContent).toContain('被系统管理设置锁定')
  expect(disabled('Claude Code')).toBe(true)
  expect(checked('Claude Code')).toBe(false)
})

it('TC-110 写时才发现锁定：红色提示「没改成：这一项被系统管理设置锁定」', async () => {
  api({ set: () => Promise.resolve(fail('locked', '没改成：这一项被系统管理设置锁定')) })
  await show()
  await act(async () => { fireEvent.click(toggleOf('Claude Code')) })
  expect(toast.error).toHaveBeenCalledWith('没改成：这一项被系统管理设置锁定')
  expect(checked('Claude Code')).toBe(true)
})

it('TC-111 保存中连点只写一次；两行各管各的，先结束的只恢复自己那一行（后-11-例1、后-11-例2、后-12-例2）', async () => {
  const pending = { claude: deferred(), codex: deferred() }
  const a = api({ set: (p) => pending[p.tool].promise })
  await show()
  await act(async () => { fireEvent.click(toggleOf('Codex')) })
  await act(async () => { fireEvent.click(toggleOf('Codex')) })
  await act(async () => { fireEvent.click(toggleOf('Claude Code')) })
  expect(a.devPluginSetEnabled.mock.calls.filter(([p]) => p.tool === 'codex')).toHaveLength(1)
  await act(async () => { pending.codex.resolve(ok({ status: 'saved', enabled: false })) })
  expect(disabled('Codex')).toBe(false)
  expect(disabled('Claude Code')).toBe(true)
  expect(rowOf('Claude Code').textContent).toContain('正在保存…')
  await act(async () => { pending.claude.resolve(ok({ status: 'saved', enabled: false })) })
  expect(checked('Codex')).toBe(false)
  expect(checked('Claude Code')).toBe(false)
})

it('TC-111 晚到的读取不覆盖刚保存的那一行（后-12-例3）', async () => {
  let readCount = 0
  const slowRead = deferred()
  api({
    read: () => (++readCount === 1 ? Promise.resolve(ok(state())) : slowRead.promise),
    set: (p) => (p.tool === 'claude' ? Promise.resolve(fail('changed', '插件状态刚被别处改过，已重新读取')) : Promise.resolve(ok({ status: 'saved', enabled: false }))),
  })
  await show()
  await act(async () => { fireEvent.click(toggleOf('Claude Code')) })
  await act(async () => { fireEvent.click(toggleOf('Codex')) })
  expect(checked('Codex')).toBe(false)
  await act(async () => { slowRead.resolve(ok(state())) })
  expect(checked('Codex')).toBe(false)
})

it('TC-111 离开页面不取消保存：旧页面结果作废；回来时在途的一行仍显示正在保存，做完按实际显示（后-25-例1）', async () => {
  vi.useFakeTimers()
  const d = deferred()
  let saving = true
  api({
    read: () => Promise.resolve(ok(state({ codex: end({ enabled: !saving ? false : true }), saving: { claude: false, codex: saving } }))),
    set: () => d.promise,
  })
  const first = render(<Page />)
  await act(async () => {})
  await act(async () => { fireEvent.click(toggleOf('Codex')) })
  first.unmount()
  await act(async () => { d.resolve(ok({ status: 'saved', enabled: false })) })
  expect(toast.success).not.toHaveBeenCalled()
  render(<Page />)
  await act(async () => {})
  expect(rowOf('Codex').textContent).toContain('正在保存…')
  expect(disabled('Codex')).toBe(true)
  saving = false
  await act(async () => { vi.advanceTimersByTime(1_100) })
  await act(async () => {})
  expect(disabled('Codex')).toBe(false)
  expect(checked('Codex')).toBe(false)
})

it('TC-112 关着再点一次：按同样过程打开，提示「Codex 已在全局设置里启用 dev-workflow，新开的会话生效」', async () => {
  const a = api({ read: () => Promise.resolve(ok(state({ codex: end({ enabled: false }) }))) })
  await show()
  expect(checked('Codex')).toBe(false)
  await act(async () => { fireEvent.click(toggleOf('Codex')) })
  expect(a.devPluginSetEnabled.mock.calls[0][0]).toEqual({ tool: 'codex', enabled: true })
  expect(toast.success).toHaveBeenCalledWith('Codex 已在全局设置里启用 dev-workflow，新开的会话生效')
  expect(checked('Codex')).toBe(true)
})

it('TC-113 结果说不清：提示「保存结果没确认…」、不弹成功；做完后重读按实际值显示再恢复可点', async () => {
  let current = state()
  const a = api({
    read: () => Promise.resolve(ok(current)),
    set: () => { current = state({ codex: end({ enabled: true }) }); return Promise.resolve(fail('uncertain', '保存结果没确认：~/.codex/config.toml，重新打开这页看实际状态')) },
  })
  await show()
  await act(async () => { fireEvent.click(toggleOf('Codex')) })
  expect(toast.warning).toHaveBeenCalledWith('保存结果没确认：~/.codex/config.toml，重新打开这页看实际状态')
  expect(toast.success).not.toHaveBeenCalled()
  expect(a.devPluginRead).toHaveBeenCalledTimes(2)
  expect(checked('Codex')).toBe(true)
  expect(disabled('Codex')).toBe(false)
})

it('TC-113 保存等了 10 秒还没结果：先提示没确认，这一行保持正在保存；做完后重读再恢复', async () => {
  vi.useFakeTimers()
  const d = deferred()
  let current = state()
  api({ read: () => Promise.resolve(ok(current)), set: () => d.promise })
  render(<Page />)
  await act(async () => {})
  await act(async () => { fireEvent.click(toggleOf('Codex')) })
  await act(async () => { vi.advanceTimersByTime(10_001) })
  expect(toast.warning).toHaveBeenCalledWith('保存结果没确认：~/.codex/config.toml，重新打开这页看实际状态')
  expect(disabled('Codex')).toBe(true)
  current = state({ codex: end({ enabled: false }) })
  await act(async () => { d.resolve(ok({ status: 'saved', enabled: false })) })
  await act(async () => {})
  expect(toast.success).not.toHaveBeenCalled()
  expect(disabled('Codex')).toBe(false)
  expect(checked('Codex')).toBe(false)
})
