/**
 * #100 切回页面先显示上次的内容（7 个页）
 *
 * 每页同一个假的 electronAPI（= 同一次运行）：先进页读完 → 卸载（切走）→ 再进页（切回）。
 * - 切回第一帧就是上次的内容；用 MutationObserver 盯住切回后的每一次 DOM 变化，任何时刻都不能出骨架 / 读取中
 * - 后台读到新的原地换；读到一样的文字不变
 * - 页里做完的操作切回还在
 * - 切回后重读失败：上次的内容留着，用页面已有的说法提示这次没更新
 * - 换一个运行（新的 electronAPI）不串用；第一次进照旧出骨架
 * 全部是假接口，不读写磁盘。
 *
 * @module tests/reads/switchBack
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createRequire } from 'node:module'

vi.mock('../../src/components/Toast', () => {
  const toast = { show: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), dismiss: vi.fn() }
  return { toast, default: () => null, notifyToast: vi.fn(), resetToastForTests: vi.fn() }
})
vi.mock('../../src/components/Modal/confirmDialog', () => {
  const confirmDialog = vi.fn(async (opts) => opts.onConfirm())
  return { confirmDialog, default: confirmDialog }
})

const { toast, notifyToast } = await import('../../src/components/Toast')
const { default: SessionStatusPage } = await import('../../src/pages/SessionStatusPage')
const { default: ClaudeEnvironmentPage } = await import('../../src/features/claudeEnvironment/ClaudeEnvironmentPage')
const { default: DevPluginPage } = await import('../../src/features/devPlugin/DevPluginPage')
const { default: PermissionModePage } = await import('../../src/pages/PermissionModePage')
const { default: ModelsPage } = await import('../../src/features/models/ModelsPage')
const { default: PlanManagementPage } = await import('../../src/pages/PlanManagementPage')
const { default: DocBrowserPage } = await import('../../src/pages/DocBrowserPage')

const STALE = '读取失败，下面是上次读到的结果'
const SKELETON = '.np-sk, .np-sk-text, .cc-sk, .state-view--loading, .plan-sk, .np-sk--pulse'
const LOADING_TEXT = /^(读取中…?|加载中\.{0,3}|扫描中\.{0,3}|正在统计…)$/

const deferred = () => {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

/** 页面里现在有没有骨架 / 读取中；有就返回是什么 */
function loadingNow() {
  const el = document.querySelector(SKELETON)
  if (el) return `skeleton:${el.className}`
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  let node
  while ((node = walker.nextNode())) {
    if (LOADING_TEXT.test(node.nodeValue.trim()) && !node.parentElement.closest('button')) return `text:${node.nodeValue.trim()}`
  }
  return null
}

/** 切回：挂上页面，并从第一帧起盯住每一次变化，记下有没有出过骨架 */
function revisit(element) {
  const seen = []
  const observer = new MutationObserver(() => { const l = loadingNow(); if (l) seen.push(l) })
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
  const view = render(element)
  const first = loadingNow()
  if (first) seen.push(first)
  return { ...view, seen, stop: () => observer.disconnect() }
}

/** 第一次进页：等骨架 / 读取中消失 */
async function visit(element) {
  const view = render(element)
  await waitFor(() => expect(loadingNow()).toBeNull())
  await act(async () => {})
  return view
}

afterEach(() => {
  cleanup()
  delete window.electronAPI
  vi.clearAllMocks()
  vi.useRealTimers()
})

// ───────── 会话状态 ─────────
describe('会话状态', () => {
  const now = Math.floor(Date.now() / 1000)
  const SESS = [{ key: 'a', state: 'busy', epoch: now - 180, name: 'skills', source: 'Claude', task: '整理' }]
  const DATA = { enabled: true, tools: { claude: true, codex: true }, failures: [], sessions: SESS, total: 1, error: null }
  const api = () => {
    const a = {
      getSessionStatus: vi.fn(async () => ({ success: true, data: DATA })),
      setSessionStatusEnabled: vi.fn(async (on) => ({ success: true, data: { ...DATA, enabled: on, sessions: [], total: 0 } })),
      retrySessionStatus: vi.fn(async () => ({ success: true, data: DATA })),
      setSessionStatusPageVisible: vi.fn(),
      onSessionStatusChanged: vi.fn(() => () => {}),
    }
    window.electronAPI = a
    return a
  }

  it('切回第一帧就是上次的会话列表，后台读到新的原地换，整段没出过骨架', async () => {
    const a = api()
    ;(await visit(<SessionStatusPage />)).unmount()
    const later = deferred()
    a.getSessionStatus = vi.fn(() => later.promise)
    const view = revisit(<SessionStatusPage />)
    expect(screen.getByTestId('ss-list')).toHaveTextContent('skills')
    await act(async () => later.resolve({ success: true, data: { ...DATA, sessions: [{ ...SESS[0], name: 'codepal' }] } }))
    expect(screen.getByTestId('ss-list')).toHaveTextContent('codepal')
    view.stop()
    expect(view.seen).toEqual([])
    expect(a.getSessionStatus).toHaveBeenCalledTimes(1)
  })

  it('读到一样的：第一帧之后文字不变', async () => {
    api()
    ;(await visit(<SessionStatusPage />)).unmount()
    const view = revisit(<SessionStatusPage />)
    const before = document.body.textContent
    await act(async () => {})
    expect(document.body.textContent).toBe(before)
    view.stop()
  })

  it('关掉会话状态再切回：显示的是关掉后的', async () => {
    const a = api()
    const first = await visit(<SessionStatusPage />)
    fireEvent.click(screen.getByRole('switch'))
    await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false'))
    first.unmount()
    a.getSessionStatus = vi.fn(() => new Promise(() => {}))
    revisit(<SessionStatusPage />)
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
  })

  it('切回后重读失败：上次的列表留着，提示这次没更新', async () => {
    const a = api()
    ;(await visit(<SessionStatusPage />)).unmount()
    a.getSessionStatus = vi.fn(async () => ({ success: false, error: '读不到' }))
    revisit(<SessionStatusPage />)
    await act(async () => {})
    expect(screen.getByTestId('ss-list')).toHaveTextContent('skills')
    expect(screen.getByText(STALE)).toBeInTheDocument()
  })

  it('切回后会话列表这次没读出来（开关读到了）：列表留着上次的，提示没更新', async () => {
    const a = api()
    ;(await visit(<SessionStatusPage />)).unmount()
    a.getSessionStatus = vi.fn(async () => ({ success: true, data: { ...DATA, sessions: [], total: 0, error: '读不到会话' } }))
    revisit(<SessionStatusPage />)
    await act(async () => {})
    expect(screen.getByTestId('ss-list')).toHaveTextContent('skills')
    expect(screen.getByText(STALE)).toBeInTheDocument()
  })

  it('实时推送说会话列表这次没读出来：列表留着、提示没更新；下一次推送读出来了，提示撤掉', async () => {
    const a = api()
    let push
    a.onSessionStatusChanged = vi.fn((cb) => { push = cb; return () => {} })
    ;(await visit(<SessionStatusPage />)).unmount()
    revisit(<SessionStatusPage />)
    await act(async () => {})
    await act(async () => push({ sessions: [], total: 0, error: '读不到会话' }))
    expect(screen.getByTestId('ss-list')).toHaveTextContent('skills')
    expect(screen.getByText(STALE)).toBeInTheDocument()
    await act(async () => push({ sessions: [{ ...SESS[0], name: 'codepal' }], total: 1, error: null }))
    expect(screen.getByTestId('ss-list')).toHaveTextContent('codepal')
    expect(screen.queryByText(STALE)).toBeNull()
  })

  it('换一个运行（新的接口）：第一次进照旧出骨架，不串用上次的', async () => {
    api()
    ;(await visit(<SessionStatusPage />)).unmount()
    const a = api()
    a.getSessionStatus = vi.fn(() => new Promise(() => {}))
    render(<SessionStatusPage />)
    expect(screen.getByTestId('ss-skeleton')).toBeInTheDocument()
  })
})

// ───────── 环境监测 ─────────
describe('环境监测', () => {
  const require = createRequire(import.meta.url)
  const { present, cleanNetwork } = require('../../electron/modules/claudeEnvironment/state')
  const fixture = (ip = '203.0.113.24', patch = {}) => present({ metadata: { supported: true, available: true, entryManaged: true, expectedIp: ip, proxyPort: 17897, fingerprint: 'same' }, sample: { checkedAt: Date.now(), fingerprint: 'same', network: cleanNetwork({ proxyReady: true, isolationActive: true, egress: { ok: true, ip, country: 'US' }, dns: { complete: true, resolvers: [{ ip: '198.51.100.53', country: 'US' }] } }) }, monitoring: true, busy: false, history: [], lastSuccess: null, revision: 10, ...patch })
  const api = () => {
    const a = {
      claudeEnvironmentRead: vi.fn(async () => ({ success: true, data: fixture() })),
      claudeEnvironmentProbe: vi.fn(),
      claudeEnvironmentForeground: vi.fn(async () => ({ success: true })),
      claudeEnvironmentSetMonitoring: vi.fn(async (value) => ({ success: true, data: fixture(undefined, { monitoring: value, revision: 20 }) })),
      onClaudeEnvironmentState: vi.fn(() => () => {}),
    }
    window.electronAPI = a
    return a
  }

  it('切回第一帧就是上次的出口 IP 和五项，读到新的原地换，整段没出过骨架 / 读取中', async () => {
    const a = api()
    ;(await visit(<ClaudeEnvironmentPage />)).unmount()
    const later = deferred()
    a.claudeEnvironmentRead = vi.fn(() => later.promise)
    const view = revisit(<ClaudeEnvironmentPage />)
    expect(document.querySelector('.ce-ip')).toHaveTextContent('203.0.113.24')
    await act(async () => later.resolve({ success: true, data: fixture('203.0.113.99', { revision: 11 }) }))
    expect(document.querySelector('.ce-ip')).toHaveTextContent('203.0.113.99')
    view.stop()
    expect(view.seen).toEqual([])
  })

  it('关掉持续监测再切回：开关是关的', async () => {
    const a = api()
    const first = await visit(<ClaudeEnvironmentPage />)
    fireEvent.click(screen.getByRole('switch', { name: '持续监测' }))
    await waitFor(() => expect(screen.getByRole('switch', { name: '持续监测' })).toHaveAttribute('aria-checked', 'false'))
    first.unmount()
    a.claudeEnvironmentRead = vi.fn(() => new Promise(() => {}))
    revisit(<ClaudeEnvironmentPage />)
    expect(document.querySelector('.ce-ip')).toHaveTextContent('203.0.113.24')
    expect(screen.getByRole('switch', { name: '持续监测' })).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByRole('switch', { name: '持续监测' })).not.toHaveAttribute('aria-disabled', 'true')
  })

  it('切回后重读失败：用页面已有的「状态待核实」，上次的 IP 标成历史结果', async () => {
    const a = api()
    ;(await visit(<ClaudeEnvironmentPage />)).unmount()
    a.claudeEnvironmentRead = vi.fn(async () => ({ success: false }))
    revisit(<ClaudeEnvironmentPage />)
    await act(async () => {})
    expect(screen.getByText('状态待核实')).toBeInTheDocument()
    expect(document.querySelector('.ce-ip')).toHaveTextContent('203.0.113.24')
    expect(screen.getByText(/历史结果/)).toBeInTheDocument()
  })
})

// ───────── 插件管理 ─────────
describe('插件管理', () => {
  const side = (patch = {}) => ({ installed: true, enabled: true, locked: false, ...patch })
  const state = (patch = {}) => ({ versionText: '0.12.22', claude: side(), codex: side(), saving: { claude: false, codex: false }, ...patch })
  const api = () => {
    const a = {
      devPluginRead: vi.fn(async () => ({ success: true, data: state() })),
      devPluginSetEnabled: vi.fn(async (p) => ({ success: true, data: { status: 'saved', enabled: p.enabled } })),
    }
    window.electronAPI = a
    return a
  }
  const toggleOf = (name) => [...document.querySelectorAll('[data-dev-tool]')].find((el) => el.textContent.includes(name)).querySelector('[role="switch"]')

  it('切回第一帧就是上次的版本号和两行开关，读到新的原地换，整段没出过骨架', async () => {
    const a = api()
    ;(await visit(<DevPluginPage />)).unmount()
    const later = deferred()
    a.devPluginRead = vi.fn(() => later.promise)
    const view = revisit(<DevPluginPage />)
    expect(screen.getByText('0.12.22')).toBeInTheDocument()
    expect(toggleOf('Codex')).toHaveAttribute('aria-checked', 'true')
    await act(async () => later.resolve({ success: true, data: state({ versionText: '0.13.0' }) }))
    expect(screen.getByText('0.13.0')).toBeInTheDocument()
    view.stop()
    expect(view.seen).toEqual([])
  })

  it('关掉 Codex 那一行再切回：显示关', async () => {
    const a = api()
    const first = await visit(<DevPluginPage />)
    fireEvent.click(toggleOf('Codex'))
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    first.unmount()
    a.devPluginRead = vi.fn(() => new Promise(() => {}))
    revisit(<DevPluginPage />)
    expect(toggleOf('Codex')).toHaveAttribute('aria-checked', 'false')
    expect(toggleOf('Claude Code')).toHaveAttribute('aria-checked', 'true')
  })

  it('切回时某行还在保存、之后每秒的查询失败：两行留着，提示没更新，不整块报错', async () => {
    vi.useFakeTimers()
    const a = api()
    a.devPluginRead = vi.fn(async () => ({ success: true, data: state({ saving: { claude: false, codex: true } }) }))
    render(<DevPluginPage />)
    await act(async () => {})
    a.devPluginRead = vi.fn(async () => ({ success: false, error: { message: '读不到插件的安装信息' } }))
    await act(async () => { await vi.advanceTimersByTimeAsync(1100) })
    expect(screen.getByText('0.12.22')).toBeInTheDocument()
    expect(screen.getByText(STALE)).toBeInTheDocument()
    expect(document.querySelector('.state-view--error')).toBeNull()
  })

  it('切回时带回「正在保存…」、这次第一次读就失败：接着每秒查，保存做完那一行按读到的值放开', async () => {
    vi.useFakeTimers()
    const a = api()
    a.devPluginRead = vi.fn(async () => ({ success: true, data: state({ saving: { claude: false, codex: true } }) }))
    const first = render(<DevPluginPage />)
    await act(async () => {})
    first.unmount()
    a.devPluginRead = vi.fn(async () => ({ success: false, error: { message: '读不到插件的安装信息' } }))
    render(<DevPluginPage />)
    await act(async () => {})
    expect(screen.getByText(STALE)).toBeInTheDocument()
    a.devPluginRead = vi.fn(async () => ({ success: true, data: state({ codex: side({ enabled: false }) }) }))
    await act(async () => { await vi.advanceTimersByTimeAsync(1100) })
    expect(toggleOf('Codex')).toHaveAttribute('aria-checked', 'false')
    expect(toggleOf('Codex')).not.toHaveAttribute('aria-disabled', 'true')
  })

  it('切回后重读失败：两行留着，提示这次没更新，不整块报错', async () => {
    const a = api()
    ;(await visit(<DevPluginPage />)).unmount()
    a.devPluginRead = vi.fn(async () => ({ success: false, error: { message: '读不到插件的安装信息' } }))
    revisit(<DevPluginPage />)
    await act(async () => {})
    expect(screen.getByText('0.12.22')).toBeInTheDocument()
    expect(toggleOf('Codex')).toBeTruthy()
    expect(screen.getByText(STALE)).toBeInTheDocument()
    expect(document.querySelector('.state-view--error')).toBeNull()
  })
})

// ───────── Claude Code 设置 ─────────
describe('Claude Code 设置', () => {
  const api = () => {
    const a = {
      getPermissionModeConfig: vi.fn(async () => ({ success: true, mode: 'bypassPermissions', isConfigured: true, isKnownMode: true })),
      setPermissionMode: vi.fn(async () => ({ success: true })),
      getClaudeUsageStatusState: vi.fn(async () => ({ success: true, integrationState: 'ready', config: { displayMode: 'always', fiveHourThreshold: 70, sevenDayThreshold: 70 } })),
      ensureClaudeUsageStatusInstalled: vi.fn(async () => ({ success: true })),
      saveClaudeUsageStatusConfig: vi.fn(async (config) => ({ success: true, integrationState: 'ready', config })),
    }
    window.electronAPI = a
    return a
  }
  const popup = () => screen.getByTestId('cc-permission-popup')

  it('切回第一帧就是上次的权限模式和状态栏，读到新的原地换，整段没出过骨架', async () => {
    const a = api()
    ;(await visit(<PermissionModePage />)).unmount()
    const mode = deferred()
    const status = deferred()
    a.getPermissionModeConfig = vi.fn(() => mode.promise)
    a.getClaudeUsageStatusState = vi.fn(() => status.promise)
    const view = revisit(<PermissionModePage />)
    expect(popup()).toHaveTextContent('全自动')
    expect(screen.getByText('已接入')).toBeInTheDocument()
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true')
    await act(async () => {
      mode.resolve({ success: true, mode: 'plan', isConfigured: true, isKnownMode: true })
      status.resolve({ success: true, integrationState: 'ready', config: { displayMode: 'off', fiveHourThreshold: 70, sevenDayThreshold: 70 } })
    })
    expect(popup()).toHaveTextContent('只读规划')
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
    view.stop()
    expect(view.seen).toEqual([])
  })

  it('改成「自动编辑」再切回：显示自动编辑', async () => {
    const a = api()
    const first = await visit(<PermissionModePage />)
    fireEvent.click(popup())
    fireEvent.click(within(await screen.findByRole('listbox')).getByRole('option', { name: /自动编辑/ }))
    await waitFor(() => expect(popup()).toHaveTextContent('自动编辑'))
    first.unmount()
    a.getPermissionModeConfig = vi.fn(() => new Promise(() => {}))
    a.getClaudeUsageStatusState = vi.fn(() => new Promise(() => {}))
    revisit(<PermissionModePage />)
    expect(popup()).toHaveTextContent('自动编辑')
  })

  it('切回后这次还没读到 / 读失败：拨「显示状态栏」、选模式都不写入（不拿上次的阈值和配置去写）', async () => {
    const a = api()
    ;(await visit(<PermissionModePage />)).unmount()
    a.getPermissionModeConfig = vi.fn(() => new Promise(() => {}))
    a.getClaudeUsageStatusState = vi.fn(() => new Promise(() => {}))
    const view = revisit(<PermissionModePage />)
    fireEvent.click(screen.getByRole('switch'))
    fireEvent.click(popup())
    fireEvent.click(within(await screen.findByRole('listbox')).getByRole('option', { name: /自动编辑/ }))
    await act(async () => {})
    expect(a.saveClaudeUsageStatusConfig).not.toHaveBeenCalled()
    expect(a.setPermissionMode).not.toHaveBeenCalled()
    view.unmount()
    a.getPermissionModeConfig = vi.fn(async () => ({ success: false }))
    a.getClaudeUsageStatusState = vi.fn(async () => ({ success: false, error: '读不到' }))
    revisit(<PermissionModePage />)
    await act(async () => {})
    fireEvent.click(screen.getByRole('switch'))
    fireEvent.click(popup())
    fireEvent.click(within(await screen.findByRole('listbox')).getByRole('option', { name: /只读规划/ }))
    await act(async () => {})
    expect(a.saveClaudeUsageStatusConfig).not.toHaveBeenCalled()
    expect(a.setPermissionMode).not.toHaveBeenCalled()
  })

  it('上次状态栏就没读出来：切回先显示「无法读取额度状态」那一行，不出骨架', async () => {
    const a = api()
    a.getClaudeUsageStatusState = vi.fn(async () => ({ success: false, error: '读不到' }))
    ;(await visit(<PermissionModePage />)).unmount()
    a.getClaudeUsageStatusState = vi.fn(() => new Promise(() => {}))
    const view = revisit(<PermissionModePage />)
    expect(popup()).toHaveTextContent('全自动')
    expect(screen.getByText('无法读取额度状态')).toBeInTheDocument()
    view.stop()
    expect(view.seen).toEqual([])
  })

  it('切回后重读失败：上次的模式留着，提示这次没更新', async () => {
    const a = api()
    ;(await visit(<PermissionModePage />)).unmount()
    a.getPermissionModeConfig = vi.fn(async () => ({ success: false }))
    a.getClaudeUsageStatusState = vi.fn(async () => ({ success: false, error: '读不到' }))
    revisit(<PermissionModePage />)
    await act(async () => {})
    expect(popup()).toHaveTextContent('全自动')
    expect(screen.getByText('已接入')).toBeInTheDocument()
    expect(screen.getByText(STALE)).toBeInTheDocument()
  })
})

// ───────── 模型接入 ─────────
describe('模型接入', () => {
  const MODEL = { id: 'deepseek-flash', name: 'deepseek-flash', effort: 'max', contextTokens: 1000000, maxOutputTokens: 128000, lastResult: null }
  const V4 = { ...MODEL, id: 'deepseek-v4-pro', name: 'deepseek-v4-pro' }
  const COMMANDS = { installed: true, missing: [], stale: false, onPath: true, binDir: '~/.local/bin' }
  const list = (...models) => ({ claudeCode: { found: true, version: '2.1.283' }, claudeChecking: false, commands: COMMANDS, commandsChecking: false, providers: { deepseek: { keySet: true, keyReadable: true, models } } })
  const api = (data = list(MODEL)) => {
    const a = {
      modelsList: vi.fn(async () => ({ success: true, data: structuredClone(data) })),
      modelsClaudeStatus: vi.fn(async () => ({ success: true, data: data.claudeCode })),
      modelsCommandsStatus: vi.fn(async () => ({ success: true, data: COMMANDS })),
      modelsRemoveModel: vi.fn(async () => ({ success: true, data: { provider: { keySet: true, keyReadable: true, models: [{ ...MODEL }] } } })),
      onModelsChanged: vi.fn(() => () => {}),
    }
    window.electronAPI = a
    return a
  }
  const row = (id) => document.querySelector(`[data-model="${id}"]`)

  it('切回第一帧就是上次的供应商和模型，读到新的原地换，整段没出过骨架', async () => {
    const a = api()
    ;(await visit(<ModelsPage />)).unmount()
    const later = deferred()
    a.modelsList = vi.fn(() => later.promise)
    const view = revisit(<ModelsPage />)
    expect(row('deepseek-flash')).not.toBeNull()
    await act(async () => later.resolve({ success: true, data: list(MODEL, V4) }))
    expect(row('deepseek-v4-pro')).not.toBeNull()
    view.stop()
    expect(view.seen).toEqual([])
  })

  it('切回时终端判断没赶上列表：先留着上次的终端状态，不出骨架', async () => {
    const a = api()
    ;(await visit(<ModelsPage />)).unmount()
    const commands = deferred()
    a.modelsList = vi.fn(async () => ({ success: true, data: { ...list(MODEL), commands: null, commandsChecking: true } }))
    a.modelsCommandsStatus = vi.fn(() => commands.promise)
    const view = revisit(<ModelsPage />)
    await act(async () => {})
    expect(view.seen).toEqual([])
    await act(async () => commands.resolve({ success: true, data: COMMANDS }))
    view.stop()
    expect(view.seen).toEqual([])
  })

  it('移除一个模型再切回：它不在了', async () => {
    const a = api(list(MODEL, V4))
    const first = await visit(<ModelsPage />)
    fireEvent.click(screen.getByTitle('deepseek-v4-pro'))
    fireEvent.click(screen.getByRole('button', { name: '移除模型' }))
    await waitFor(() => expect(row('deepseek-v4-pro')).toBeNull())
    first.unmount()
    a.modelsList = vi.fn(() => new Promise(() => {}))
    revisit(<ModelsPage />)
    expect(row('deepseek-flash')).not.toBeNull()
    expect(row('deepseek-v4-pro')).toBeNull()
  })

  it('切回读列表直接抛错：上次的模型留着并提示；较早那次的失败晚于较新的成功回来，不提示', async () => {
    const a = api()
    ;(await visit(<ModelsPage />)).unmount()
    a.modelsList = vi.fn(async () => { throw new Error('ipc gone') })
    const view = revisit(<ModelsPage />)
    await act(async () => {})
    expect(row('deepseek-flash')).not.toBeNull()
    expect(screen.getByText(STALE)).toBeInTheDocument()
    view.unmount()
    const old = deferred()
    a.modelsList = vi.fn(() => old.promise)
    revisit(<ModelsPage />)
    a.modelsList = vi.fn(async () => ({ success: true, data: list(MODEL) }))
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    await act(async () => old.resolve({ success: false }))
    expect(screen.queryByText(STALE)).toBeNull()
  })

  it('切回后重读失败：上次的模型留着，提示这次没更新，不整块报错', async () => {
    const a = api()
    ;(await visit(<ModelsPage />)).unmount()
    a.modelsList = vi.fn(async () => ({ success: false, error: { message: 'bad' } }))
    revisit(<ModelsPage />)
    await act(async () => {})
    expect(row('deepseek-flash')).not.toBeNull()
    expect(screen.getByText(STALE)).toBeInTheDocument()
    expect(document.querySelector('.state-view--error')).toBeNull()
  })
})

// ───────── 订阅管理 ─────────
describe('订阅管理', () => {
  const cycle = { id: '2026-08-20', start: '2026-08-20', end: '2026-09-20', price: 20 }
  const plan = { price: 20, billingDay: 20, autoRenew: false, version: 1, stopped: false, cycles: [cycle] }
  const api = () => {
    const a = {
      readPlan: vi.fn(async ({ planId }) => ({ success: true, data: { plan: planId === 'claude' ? plan : { cycles: [], version: 0, stopped: false }, metadata: { type: 'Pro' }, today: '2026-09-16' } })),
      queryPlan: vi.fn(async ({ cycleId }) => ({ success: true, data: { version: 1, cycleId, total: 751, models: [] } })),
      savePlan: vi.fn(async () => ({ success: true, data: { plan: { ...plan, version: 2, price: 100, cycles: [{ ...cycle, price: 100 }] }, metadata: { type: 'Pro' }, today: '2026-09-16' } })),
    }
    window.electronAPI = a
    return a
  }
  const claudeCard = () => screen.getAllByTestId('plan-card')[0]

  it('切回第一帧就是上次的倍数和金额，读到新的原地换，整段没出过骨架', async () => {
    const a = api()
    ;(await visit(<PlanManagementPage />)).unmount()
    const later = deferred()
    a.queryPlan = vi.fn(({ cycleId }) => later.promise.then(() => ({ success: true, data: { version: 1, cycleId, total: 1000, models: [] } })))
    const view = revisit(<PlanManagementPage />)
    expect(within(claudeCard()).getByText('38×')).toBeInTheDocument()
    await act(async () => {})
    await act(async () => later.resolve())
    expect(within(claudeCard()).getByText('50×')).toBeInTheDocument()
    view.stop()
    expect(view.seen).toEqual([])
  })

  it('切回时统计还在算：先显示上次的，不出骨架', async () => {
    const a = api()
    ;(await visit(<PlanManagementPage />)).unmount()
    a.queryPlan = vi.fn(async ({ cycleId }) => ({ success: true, data: { version: 1, cycleId, pending: true } }))
    const view = revisit(<PlanManagementPage />)
    await act(async () => {})
    expect(within(claudeCard()).getByText('38×')).toBeInTheDocument()
    view.stop()
    expect(view.seen).toEqual([])
  })

  it('切回时后台读到新周期（续费日过了）：新数字出来之前整张卡照上次的，不出骨架；出来了整张换', async () => {
    const a = api()
    ;(await visit(<PlanManagementPage />)).unmount()
    const next = { id: '2026-09-20', start: '2026-09-20', end: '2026-10-20', price: 20 }
    const renewed = { ...plan, version: 2, autoRenew: true, cycles: [cycle, next] }
    const later = deferred()
    a.readPlan = vi.fn(async ({ planId }) => ({ success: true, data: { plan: planId === 'claude' ? renewed : { cycles: [], version: 0, stopped: false }, metadata: { type: 'Pro' }, today: '2026-09-21' } }))
    a.queryPlan = vi.fn(({ cycleId }) => later.promise.then(() => ({ success: true, data: { version: 2, cycleId, total: 40, models: [] } })))
    const view = revisit(<PlanManagementPage />)
    await act(async () => {})
    expect(within(claudeCard()).getByText('38×')).toBeInTheDocument()
    await act(async () => later.resolve())
    expect(within(claudeCard()).getByText('2.0×')).toBeInTheDocument()
    expect(within(claudeCard()).getByText('09.20 – 10.20')).toBeInTheDocument()
    view.stop()
    expect(view.seen).toEqual([])
  })

  it('切回时读到新周期、但新数字没读到：整张卡留着上次的，Toast 说明', async () => {
    const a = api()
    ;(await visit(<PlanManagementPage />)).unmount()
    const next = { id: '2026-09-20', start: '2026-09-20', end: '2026-10-20', price: 20 }
    a.readPlan = vi.fn(async ({ planId }) => ({ success: true, data: { plan: planId === 'claude' ? { ...plan, version: 2, cycles: [cycle, next] } : { cycles: [], version: 0, stopped: false }, metadata: { type: 'Pro' }, today: '2026-09-21' } }))
    a.queryPlan = vi.fn(async () => ({ success: false }))
    revisit(<PlanManagementPage />)
    await act(async () => {})
    expect(within(claudeCard()).getByText('38×')).toBeInTheDocument()
    expect(notifyToast).toHaveBeenCalledWith({ message: 'Claude Code 用量读取失败，显示的是上次读到的结果', type: 'error' })
  })

  it('垫着上次的卡时改订阅费：只交改过的订阅费，账单日照账本最新的、用最新版本提交（不把旧账单日配上新版本）', async () => {
    const a = api()
    ;(await visit(<PlanManagementPage />)).unmount()
    a.readPlan = vi.fn(async ({ planId }) => ({ success: true, data: { plan: planId === 'claude' ? { ...plan, version: 2, billingDay: 5 } : { cycles: [], version: 0, stopped: false }, metadata: { type: 'Pro' }, today: '2026-09-16' } }))
    a.queryPlan = vi.fn(() => new Promise(() => {}))
    revisit(<PlanManagementPage />)
    await act(async () => {})
    fireEvent.click(screen.getByRole('button', { name: 'Claude Code 订阅设置' }))
    fireEvent.change(screen.getByLabelText('订阅费'), { target: { value: '100' } })
    fireEvent.keyDown(screen.getByLabelText('订阅费'), { key: 'Enter' })
    await waitFor(() => expect(a.savePlan).toHaveBeenCalledTimes(1))
    expect(a.savePlan.mock.calls[0][0]).toMatchObject({ expectedVersion: 2, price: 100, billingDay: 5, autoRenew: false })
  })

  it('改了订阅费再切回：显示改后的', async () => {
    const a = api()
    const first = await visit(<PlanManagementPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Claude Code 订阅设置' }))
    fireEvent.change(screen.getByLabelText('订阅费'), { target: { value: '100' } })
    fireEvent.keyDown(screen.getByLabelText('订阅费'), { key: 'Enter' })
    await waitFor(() => expect(a.savePlan).toHaveBeenCalledTimes(1))
    a.queryPlan = vi.fn(async ({ cycleId }) => ({ success: true, data: { version: 2, cycleId, total: 751, models: [] } }))
    await waitFor(() => expect(within(claudeCard()).getByText('$100')).toBeInTheDocument())
    first.unmount()
    a.readPlan = vi.fn(() => new Promise(() => {}))
    revisit(<PlanManagementPage />)
    expect(within(claudeCard()).getByText('$100')).toBeInTheDocument()
  })

  it('切回后重读失败：数字留着，Toast 说明显示的是上次读到的', async () => {
    const a = api()
    ;(await visit(<PlanManagementPage />)).unmount()
    a.queryPlan = vi.fn(async () => ({ success: false }))
    revisit(<PlanManagementPage />)
    await act(async () => {})
    expect(within(claudeCard()).getByText('38×')).toBeInTheDocument()
    expect(notifyToast).toHaveBeenCalledWith({ message: 'Claude Code 用量读取失败，显示的是上次读到的结果', type: 'error' })
  })
})

// ───────── 文档查阅 ─────────
describe('文档查阅', () => {
  const ALPHA = '/x/docs/Alpha'
  const BETA = '/x/docs/Beta'
  const file = (folder, relativePath) => {
    const parts = relativePath.split('/')
    return { name: parts[parts.length - 1], relativePath, dir: parts.slice(0, -1).join('/'), fullPath: `${folder}/${relativePath}`, size: 1234 }
  }
  const FOLDERS = [{ name: 'Alpha', path: ALPHA, fileCount: 2, valid: true }, { name: 'Beta', path: BETA, fileCount: 1, valid: true }]
  const FILES = { [ALPHA]: [file(ALPHA, 'readme.md'), file(ALPHA, 'sub/guide.md')], [BETA]: [file(BETA, 'notes.md')] }
  const api = () => {
    const a = {
      docListFolders: vi.fn(async () => ({ success: true, data: FOLDERS })),
      docListFiles: vi.fn(async (p) => ({ success: true, data: FILES[p] || [] })),
      docReadFile: vi.fn(async () => ({ success: true, data: { content: '# 标题\n\n正文内容', size: 1234 } })),
      docSelectFolder: vi.fn(async () => ({ success: true, data: null })),
      docAddFolder: vi.fn(),
      docRemoveFolder: vi.fn(async () => ({ success: true })),
    }
    window.electronAPI = a
    return a
  }
  const rootRow = (name) => [...document.querySelectorAll('.np-tr--root')].find((r) => r.querySelector('.nm')?.textContent === name)
  const detail = () => document.querySelector('.np-pane--detail')

  /** 进页、展开 Alpha、打开 readme.md */
  async function openReadme() {
    const view = await visit(<DocBrowserPage />)
    fireEvent.click(screen.getByText('Alpha'))
    fireEvent.click(await screen.findByText('readme.md'))
    await waitFor(() => expect(detail()).toHaveTextContent('正文内容'))
    return view
  }

  it('切回第一帧：文件夹、展开的目录树、选中的文档和正文都在，读到新的原地换，整段没出过骨架 / 转圈', async () => {
    const a = api()
    ;(await openReadme()).unmount()
    const folders = deferred()
    const content = deferred()
    a.docListFolders = vi.fn(() => folders.promise)
    a.docListFiles = vi.fn(() => new Promise(() => {}))
    a.docReadFile = vi.fn(() => content.promise)
    const view = revisit(<DocBrowserPage />)
    expect(rootRow('Alpha')).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('readme.md', { selector: '.np-tr .nm' }).closest('.np-tr')).toHaveClass('on')
    expect(detail()).toHaveTextContent('正文内容')
    await act(async () => {
      folders.resolve({ success: true, data: FOLDERS })
      content.resolve({ success: true, data: { content: '# 标题\n\n新的正文', size: 2000 } })
    })
    expect(detail()).toHaveTextContent('新的正文')
    view.stop()
    expect(view.seen).toEqual([])
  })

  it('搜索词切回还在，搜索结果照常', async () => {
    api()
    const first = await openReadme()
    fireEvent.change(screen.getByPlaceholderText('搜索文件名...'), { target: { value: 'guide' } })
    expect(await screen.findByText('1')).toBeInTheDocument()
    first.unmount()
    revisit(<DocBrowserPage />)
    expect(screen.getByPlaceholderText('搜索文件名...')).toHaveValue('guide')
    expect(screen.getByText('guide.md')).toBeInTheDocument()
  })

  it('读过两个文件夹：切回后没展开的那个也重读，搜索范围跟着更新（外面改了名的搜得到新名字）', async () => {
    const a = api()
    const first = await visit(<DocBrowserPage />)
    fireEvent.click(screen.getByText('Beta'))
    await screen.findByText('notes.md')
    fireEvent.click(screen.getByText('Alpha'))
    await screen.findByText('readme.md')
    first.unmount()
    a.docListFiles = vi.fn(async (p) => ({ success: true, data: p === BETA ? [file(BETA, 'renamed.md')] : FILES[p] }))
    revisit(<DocBrowserPage />)
    await act(async () => {})
    fireEvent.change(screen.getByPlaceholderText('搜索文件名...'), { target: { value: 'renamed' } })
    expect(screen.getByText('renamed.md')).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText('搜索文件名...'), { target: { value: 'notes' } })
    expect(screen.queryByText('notes.md')).toBeNull()
  })

  it('切回时后台还在重读收起的文件夹、又手动展开了它：搜索范围用手动展开那次读到的', async () => {
    const a = api()
    const first = await visit(<DocBrowserPage />)
    fireEvent.click(screen.getByText('Beta'))
    await screen.findByText('notes.md')
    fireEvent.click(screen.getByText('Alpha'))
    await screen.findByText('readme.md')
    first.unmount()
    const slow = deferred()
    a.docListFiles = vi.fn((p) => (p === BETA ? slow.promise : Promise.resolve({ success: true, data: FILES[p] })))
    revisit(<DocBrowserPage />)
    await act(async () => {})
    a.docListFiles = vi.fn(async (p) => ({ success: true, data: p === BETA ? [file(BETA, 'new.md')] : FILES[p] }))
    fireEvent.click(screen.getByText('Beta'))
    await screen.findByText('new.md')
    await act(async () => slow.resolve({ success: true, data: [file(BETA, 'old.md')] }))
    fireEvent.change(screen.getByPlaceholderText('搜索文件名...'), { target: { value: '.md' } })
    expect(screen.getByText('new.md')).toBeInTheDocument()
    expect(screen.queryByText('old.md')).toBeNull()
  })

  it('切回后文件列表读失败、文件夹列表读成功：左栏的提示不被抹掉', async () => {
    const a = api()
    ;(await openReadme()).unmount()
    const folders = deferred()
    a.docListFolders = vi.fn(() => folders.promise)
    a.docListFiles = vi.fn(async () => ({ success: false, error: 'bad' }))
    revisit(<DocBrowserPage />)
    await act(async () => {})
    await act(async () => folders.resolve({ success: true, data: FOLDERS }))
    expect(within(document.querySelector('.np-pane--list')).getByText(STALE)).toBeInTheDocument()
    expect(screen.getByText('readme.md', { selector: '.np-tr .nm' })).toBeInTheDocument()
  })

  it('点开一篇正文还没读到就切走：回来照第一次那样读，读不到照旧报「无法读取文件」，不冒充上次的', async () => {
    const a = api()
    const first = await visit(<DocBrowserPage />)
    fireEvent.click(screen.getByText('Alpha'))
    a.docReadFile = vi.fn(() => new Promise(() => {}))
    fireEvent.click(await screen.findByText('readme.md'))
    first.unmount()
    a.docReadFile = vi.fn(async () => ({ success: false, error: 'gone' }))
    revisit(<DocBrowserPage />)
    await act(async () => {})
    expect(within(detail()).getByText('无法读取文件')).toBeInTheDocument()
    expect(within(detail()).queryByText(STALE)).toBeNull()
  })

  it('移除一个文件夹再切回：它不在了', async () => {
    const a = api()
    const first = await visit(<DocBrowserPage />)
    a.docListFolders = vi.fn(async () => ({ success: true, data: [FOLDERS[0]] }))
    fireEvent.click(within(rootRow('Beta')).getByRole('button', { name: '移除' }))
    await waitFor(() => expect(rootRow('Beta')).toBeUndefined())
    first.unmount()
    a.docListFolders = vi.fn(() => new Promise(() => {}))
    revisit(<DocBrowserPage />)
    expect(rootRow('Alpha')).toBeTruthy()
    expect(rootRow('Beta')).toBeUndefined()
  })

  it('切回后正文重读失败：上次的正文留着，提示这次没更新', async () => {
    const a = api()
    ;(await openReadme()).unmount()
    a.docReadFile = vi.fn(async () => ({ success: false, error: 'gone' }))
    revisit(<DocBrowserPage />)
    await act(async () => {})
    expect(detail()).toHaveTextContent('正文内容')
    expect(within(detail()).getByText(STALE)).toBeInTheDocument()
  })

  it('切回后文件夹列表重读失败：上次的文件夹留着，提示这次没更新', async () => {
    const a = api()
    ;(await visit(<DocBrowserPage />)).unmount()
    a.docListFolders = vi.fn(async () => ({ success: false, error: 'bad' }))
    revisit(<DocBrowserPage />)
    await act(async () => {})
    expect(rootRow('Alpha')).toBeTruthy()
    expect(within(document.querySelector('.np-pane--list')).getByText(STALE)).toBeInTheDocument()
  })
})
