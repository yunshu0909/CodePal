/**
 * Claude Code 设置页组件测试
 *
 * 负责：
 * - 按 specs/Claude设置重做 的组件级场景断言页面可观察结果
 * - 固定默认权限模式弹出菜单、状态栏接入与开关、终端预览的文案与调用参数
 * - 确认删减项不再出现在页面上
 *
 * @module tests/claudeSettingsPage.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import PermissionModePage from '../src/pages/PermissionModePage'

const MANAGED = '该设置已被企业 / 组织托管配置覆盖，本次写入不会生效'

/** 构造一个已接入、开关开、全自动的桌面端接口 */
function makeApi(overrides = {}) {
  return {
    getPermissionModeConfig: vi.fn(async () => ({ success: true, mode: 'bypassPermissions', isConfigured: true, isKnownMode: true })),
    setPermissionMode: vi.fn(async () => ({ success: true })),
    getClaudeUsageStatusState: vi.fn(async () => ({
      success: true,
      integrationState: 'ready',
      config: { displayMode: 'always', fiveHourThreshold: 55, sevenDayThreshold: 66 },
    })),
    ensureClaudeUsageStatusInstalled: vi.fn(async () => ({ success: true, integrationState: 'ready', config: { displayMode: 'always', fiveHourThreshold: 70, sevenDayThreshold: 70 } })),
    saveClaudeUsageStatusConfig: vi.fn(async (config) => ({ success: true, integrationState: 'ready', config })),
    ...overrides,
  }
}

/** 渲染页面并等待两侧读取完成 */
async function renderPage(api = makeApi()) {
  window.electronAPI = api
  const utils = render(<PermissionModePage />)
  await waitFor(() => expect(api.getPermissionModeConfig).toHaveBeenCalled())
  await waitFor(() => expect(api.getClaudeUsageStatusState).toHaveBeenCalled())
  return { api, ...utils }
}

const popup = () => screen.getByTestId('cc-permission-popup')
const preview = () => screen.getByTestId('cc-terminal-preview')
const toggle = () => screen.getByRole('switch')

beforeEach(() => {
  vi.useRealTimers()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  delete window.electronAPI
})

describe('默认权限模式', () => {
  it('TC-003 显示当前模式与说明', async () => {
    await renderPage()
    expect(await screen.findByText('默认权限模式')).toBeInTheDocument()
    await waitFor(() => expect(popup()).toHaveTextContent('全自动'))
    expect(screen.getByText('自动执行所有操作，无需确认')).toBeInTheDocument()
  })

  it('TC-004 菜单按固定顺序列出六个模式并勾选当前项', async () => {
    await renderPage()
    await waitFor(() => expect(popup()).toHaveTextContent('全自动'))
    fireEvent.click(popup())
    const menu = await screen.findByRole('listbox')
    const names = within(menu).getAllByRole('option').map((o) => o.querySelector('b').textContent)
    expect(names).toEqual(['全自动', '自动审批', '自动编辑', '每次询问', '仅预先授权', '只读规划'])
    expect(within(menu).getByRole('option', { name: /全自动/ })).toHaveAttribute('aria-selected', 'true')
  })

  it('TC-005 选中即写入，按钮、说明、预览模式行与 Toast 更新', async () => {
    const { api } = await renderPage()
    await waitFor(() => expect(popup()).toHaveTextContent('全自动'))
    fireEvent.click(popup())
    fireEvent.click(within(await screen.findByRole('listbox')).getByRole('option', { name: /自动编辑/ }))
    await waitFor(() => expect(api.setPermissionMode).toHaveBeenCalledWith('acceptEdits'))
    expect(await screen.findByText('已切换至「自动编辑」')).toBeInTheDocument()
    expect(popup()).toHaveTextContent('自动编辑')
    expect(screen.getByText('自动接受文件改动，命令执行和网络访问仍需确认')).toBeInTheDocument()
    expect(preview()).toHaveTextContent('accept edits on')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('TC-006 Esc 与点菜单外关闭菜单且不写入', async () => {
    const { api } = await renderPage()
    await waitFor(() => expect(popup()).toHaveTextContent('全自动'))
    fireEvent.click(popup())
    await screen.findByRole('listbox')
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
    fireEvent.click(popup())
    await screen.findByRole('listbox')
    fireEvent.mouseDown(document.body)
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
    expect(api.setPermissionMode).not.toHaveBeenCalled()
    expect(popup()).toHaveTextContent('全自动')
  })

  it('TC-007 写入中弹出按钮禁用', async () => {
    let resolve
    const api = makeApi({ setPermissionMode: vi.fn(() => new Promise((r) => { resolve = r })) })
    await renderPage(api)
    await waitFor(() => expect(popup()).toHaveTextContent('全自动'))
    fireEvent.click(popup())
    fireEvent.click(within(await screen.findByRole('listbox')).getByRole('option', { name: /只读规划/ }))
    await waitFor(() => expect(popup()).toBeDisabled())
    await act(async () => { resolve({ success: true }) })
    await waitFor(() => expect(popup()).not.toBeDisabled())
  })

  it('TC-008 写入失败回到原值并报错', async () => {
    const api = makeApi({ setPermissionMode: vi.fn(async () => ({ success: false, errorCode: 'UNKNOWN' })) })
    await renderPage(api)
    await waitFor(() => expect(popup()).toHaveTextContent('全自动'))
    fireEvent.click(popup())
    fireEvent.click(within(await screen.findByRole('listbox')).getByRole('option', { name: /自动编辑/ }))
    expect(await screen.findByText('切换失败')).toBeInTheDocument()
    expect(popup()).toHaveTextContent('全自动')
  })

  it('TC-009 托管配置覆盖时说明位橙字并报错', async () => {
    const api = makeApi({ setPermissionMode: vi.fn(async () => ({ success: true, managedNotice: MANAGED })) })
    await renderPage(api)
    await waitFor(() => expect(popup()).toHaveTextContent('全自动'))
    fireEvent.click(popup())
    fireEvent.click(within(await screen.findByRole('listbox')).getByRole('option', { name: /自动编辑/ }))
    const notices = await screen.findAllByText(MANAGED)
    expect(notices.some((el) => el.classList.contains('warn'))).toBe(true)
  })

  it('TC-010 未配置时显示「未配置」与客户端默认模式行', async () => {
    const api = makeApi({ getPermissionModeConfig: vi.fn(async () => ({ success: true, mode: null, isConfigured: false, isKnownMode: true })) })
    await renderPage(api)
    await waitFor(() => expect(popup()).toHaveTextContent('未配置'))
    expect(screen.getByText('未配置 · 由 Claude 决定')).toBeInTheDocument()
    expect(preview()).toHaveTextContent('? for shortcuts')
  })
})

describe('状态栏开关与接入', () => {
  it('TC-011 关掉开关保存 off 并原样带回阈值，预览状态栏消失', async () => {
    const { api } = await renderPage()
    await waitFor(() => expect(toggle()).toHaveClass('on'))
    expect(preview()).toHaveTextContent('Opus 5')
    fireEvent.click(toggle())
    await waitFor(() => expect(api.saveClaudeUsageStatusConfig).toHaveBeenCalledWith({ displayMode: 'off', fiveHourThreshold: 55, sevenDayThreshold: 66 }))
    expect(await screen.findByText('显示设置已保存')).toBeInTheDocument()
    await waitFor(() => expect(preview()).not.toHaveTextContent('Opus 5'))
    expect(preview()).not.toHaveTextContent('git:master*')
  })

  it('TC-012 开关保存失败回到原值', async () => {
    const api = makeApi({ saveClaudeUsageStatusConfig: vi.fn(async () => ({ success: false })) })
    await renderPage(api)
    await waitFor(() => expect(toggle()).toHaveClass('on'))
    fireEvent.click(toggle())
    expect(await screen.findByText('保存失败，请重试')).toBeInTheDocument()
    expect(toggle()).toHaveClass('on')
  })

  it('TC-013 未接入时显示立即接入且开关禁用', async () => {
    const api = makeApi({ getClaudeUsageStatusState: vi.fn(async () => ({ success: true, integrationState: 'not_configured', config: { displayMode: 'always', fiveHourThreshold: 70, sevenDayThreshold: 70 } })) })
    await renderPage(api)
    expect(await screen.findByText('未接入')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '立即接入' })).toBeInTheDocument()
    expect(toggle()).toHaveClass('disabled')
    expect(preview()).not.toHaveTextContent('Opus 5')
  })

  it('TC-014 接入处理中按钮变「处理中...」并禁用', async () => {
    let resolve
    const api = makeApi({
      getClaudeUsageStatusState: vi.fn(async () => ({ success: true, integrationState: 'not_configured', config: { displayMode: 'always', fiveHourThreshold: 70, sevenDayThreshold: 70 } })),
      ensureClaudeUsageStatusInstalled: vi.fn(() => new Promise((r) => { resolve = r })),
    })
    await renderPage(api)
    fireEvent.click(await screen.findByRole('button', { name: '立即接入' }))
    const busy = await screen.findByRole('button', { name: '处理中...' })
    expect(busy).toBeDisabled()
    expect(api.ensureClaudeUsageStatusInstalled).toHaveBeenCalledWith({ intent: 'explicit' })
    await act(async () => { resolve({ success: true, integrationState: 'ready', config: { displayMode: 'always', fiveHourThreshold: 70, sevenDayThreshold: 70 } }) })
  })

  it('TC-015 接入成功后显示已接入、开关可用', async () => {
    const api = makeApi({ getClaudeUsageStatusState: vi.fn(async () => ({ success: true, integrationState: 'not_configured', config: { displayMode: 'always', fiveHourThreshold: 70, sevenDayThreshold: 70 } })) })
    await renderPage(api)
    fireEvent.click(await screen.findByRole('button', { name: '立即接入' }))
    expect(await screen.findByText('已接入')).toBeInTheDocument()
    expect(toggle()).not.toHaveClass('disabled')
    expect(toggle()).toHaveClass('on')
  })

  it('TC-016 接入失败显示无法写入与重试接入', async () => {
    const api = makeApi({ getClaudeUsageStatusState: vi.fn(async () => ({ success: true, integrationState: 'setup_failed', config: { displayMode: 'always', fiveHourThreshold: 70, sevenDayThreshold: 70 } })) })
    await renderPage(api)
    expect(await screen.findByText('无法写入 Claude 配置')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重试接入' })).toBeInTheDocument()
    cleanup()
    const committed = makeApi({ getClaudeUsageStatusState: vi.fn(async () => ({ success: true, integrationState: 'setup_failed', committed: true, config: { displayMode: 'always', fiveHourThreshold: 70, sevenDayThreshold: 70 } })) })
    await renderPage(committed)
    expect(await screen.findByText('配置已写入但未通过校验')).toBeInTheDocument()
  })

  it('TC-017 未安装时显示刷新状态，权限模式照常可设', async () => {
    const api = makeApi({ getClaudeUsageStatusState: vi.fn(async () => ({ success: true, integrationState: 'not_installed', config: { displayMode: 'always', fiveHourThreshold: 70, sevenDayThreshold: 70 } })) })
    await renderPage(api)
    expect(await screen.findByText('本机未安装 Claude Code')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '刷新状态' })).toBeInTheDocument()
    await waitFor(() => expect(popup()).not.toBeDisabled())
    fireEvent.click(screen.getByRole('button', { name: '刷新状态' }))
    await waitFor(() => expect(api.getClaudeUsageStatusState).toHaveBeenCalledTimes(2))
  })

  it('TC-018 已有自定义 statusLine 时经现有弹窗确认接管', async () => {
    const api = makeApi({ getClaudeUsageStatusState: vi.fn(async () => ({ success: true, integrationState: 'conflict', config: { displayMode: 'always', fiveHourThreshold: 70, sevenDayThreshold: 70 } })) })
    await renderPage(api)
    expect(await screen.findByText('检测到已有自定义 statusLine')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '查看接管说明' }))
    expect(await screen.findByText('接管 Claude statusLine')).toBeInTheDocument()
    expect(api.ensureClaudeUsageStatusInstalled).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '确认接管' }))
    await waitFor(() => expect(api.ensureClaudeUsageStatusInstalled).toHaveBeenCalledWith({ force: true, intent: 'explicit' }))
    expect(await screen.findByText('Claude statusLine 已由 CodePal 接管')).toBeInTheDocument()
  })

  it('TC-019 取消接管不写入', async () => {
    const api = makeApi({ getClaudeUsageStatusState: vi.fn(async () => ({ success: true, integrationState: 'conflict', config: { displayMode: 'always', fiveHourThreshold: 70, sevenDayThreshold: 70 } })) })
    await renderPage(api)
    fireEvent.click(await screen.findByRole('button', { name: '查看接管说明' }))
    await screen.findByText('接管 Claude statusLine')
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByText('接管 Claude statusLine')).not.toBeInTheDocument())
    expect(api.ensureClaudeUsageStatusInstalled).not.toHaveBeenCalled()
    expect(screen.getByText('检测到已有自定义 statusLine')).toBeInTheDocument()
  })
})

describe('终端预览、加载与删减', () => {
  it('TC-020 预览用固定示例数据并按模式画模式行', async () => {
    await renderPage()
    await waitFor(() => expect(preview()).toHaveTextContent('Opus 5'))
    expect(preview()).toHaveTextContent('16%')
    expect(preview()).toHaveTextContent('5h:4%')
    expect(preview()).toHaveTextContent('7d:69%')
    expect(preview()).toHaveTextContent('resets in 25m (15:30)')
    expect(preview()).toHaveTextContent('git:master*')
    expect(preview()).toHaveTextContent('bypass permissions on')
    expect(preview()).toHaveTextContent('(shift+tab to cycle)')
  })

  it('TC-021 首次加载显示骨架', async () => {
    window.electronAPI = makeApi({
      getPermissionModeConfig: vi.fn(() => new Promise(() => {})),
      getClaudeUsageStatusState: vi.fn(() => new Promise(() => {})),
    })
    render(<PermissionModePage />)
    expect(await screen.findByTestId('cc-skeleton')).toBeInTheDocument()
    expect(screen.queryByTestId('cc-permission-popup')).not.toBeInTheDocument()
  })

  it('TC-022 两侧读取失败各自行内报错并可重试', async () => {
    const api = makeApi({
      getPermissionModeConfig: vi.fn(async () => ({ success: false, error: '读取失败' })),
      getClaudeUsageStatusState: vi.fn(async () => ({ success: false, error: '读取失败' })),
    })
    await renderPage(api)
    expect(await screen.findByText('无法读取当前配置')).toBeInTheDocument()
    expect(screen.getByText('无法读取额度状态')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: '重试' })).toHaveLength(2)
    expect(toggle()).toHaveClass('disabled')
    fireEvent.click(screen.getAllByRole('button', { name: '重试' })[0])
    await waitFor(() => expect(api.getPermissionModeConfig).toHaveBeenCalledTimes(2))
  })

  it('TC-023 删减项不再出现', async () => {
    await renderPage()
    await waitFor(() => expect(popup()).toHaveTextContent('全自动'))
    for (const text of ['模型配置与推理等级', '恢复上次修改', '恢复客户端默认', '会员额度', '当前模式', '5 小时阈值', '额度达阈值']) {
      expect(screen.queryByText(new RegExp(text))).not.toBeInTheDocument()
    }
  })

  it('TC-025 页面结构：默认权限模式卡、状态栏卡、终端预览依次排列', async () => {
    const { container } = await renderPage()
    await waitFor(() => expect(popup()).toHaveTextContent('全自动'))
    const page = container.querySelector('.cc-page')
    expect(page).not.toBeNull()
    const order = [...page.querySelectorAll('.cc-card, .cc-gl, [data-testid="cc-terminal-preview"]')].map((el) =>
      el.matches('[data-testid="cc-terminal-preview"]') ? 'preview' : el.classList.contains('cc-gl') ? `gl:${el.textContent}` : 'card')
    expect(order).toEqual(['card', 'gl:状态栏', 'card', 'gl:终端预览', 'preview'])
  })

  it('TC-026 页面标题为 Claude Code 设置且设置行不设固定宽度', async () => {
    const { container } = await renderPage()
    await waitFor(() => expect(popup()).toHaveTextContent('全自动'))
    expect(screen.getByRole('heading', { name: 'Claude Code 设置' })).toBeInTheDocument()
    container.querySelectorAll('.cc-row').forEach((row) => expect(row.style.width).toBe(''))
  })

  it('TC-027 菜单挂在权限模式行内并右对齐弹出按钮', async () => {
    await renderPage()
    await waitFor(() => expect(popup()).toHaveTextContent('全自动'))
    fireEvent.click(popup())
    const menu = await screen.findByRole('listbox')
    expect(menu.closest('.cc-row')).toBe(popup().closest('.cc-row'))
    expect(menu).toHaveClass('cc-menu')
  })
})

describe('兼容、单侧失败、键盘与读取次数', () => {
  it('TC-028 旧 threshold 配置显示为开且进页不写入，拨开关才写 off', async () => {
    const api = makeApi({ getClaudeUsageStatusState: vi.fn(async () => ({ success: true, integrationState: 'ready', config: { displayMode: 'threshold', fiveHourThreshold: 55, sevenDayThreshold: 66 } })) })
    await renderPage(api)
    await waitFor(() => expect(toggle()).toHaveClass('on'))
    expect(api.saveClaudeUsageStatusConfig).not.toHaveBeenCalled()
    fireEvent.click(toggle())
    await waitFor(() => expect(api.saveClaudeUsageStatusConfig).toHaveBeenCalledWith({ displayMode: 'off', fiveHourThreshold: 55, sevenDayThreshold: 66 }))
  })

  it('TC-029 未知模式值等宽显示原值并标「未知模式」', async () => {
    const api = makeApi({ getPermissionModeConfig: vi.fn(async () => ({ success: true, mode: 'bypassAll', isConfigured: true, isKnownMode: false })) })
    await renderPage(api)
    await waitFor(() => expect(popup()).toHaveTextContent('bypassAll'))
    expect(popup().querySelector('.raw')).not.toBeNull()
    expect(screen.getByText('未知模式')).toBeInTheDocument()
    expect(preview()).toHaveTextContent('? for shortcuts')
  })

  it('TC-030 菜单说明单行省略并在悬停时给出全文', async () => {
    await renderPage()
    await waitFor(() => expect(popup()).toHaveTextContent('全自动'))
    fireEvent.click(popup())
    const option = within(await screen.findByRole('listbox')).getByRole('option', { name: /自动审批/ })
    expect(option).toHaveAttribute('title', '由审批模型判断操作；可用性取决于客户端和账户')
  })

  it('TC-031 只有权限模式读取失败时状态栏照常可用', async () => {
    const api = makeApi({ getPermissionModeConfig: vi.fn(async () => ({ success: false, error: '读取失败' })) })
    await renderPage(api)
    expect(await screen.findByText('无法读取当前配置')).toBeInTheDocument()
    expect(screen.getByText('已接入')).toBeInTheDocument()
    expect(toggle()).not.toHaveClass('disabled')
  })

  it('TC-032 只有状态栏读取失败时权限模式照常可设', async () => {
    const api = makeApi({ getClaudeUsageStatusState: vi.fn(async () => ({ success: false, error: '读取失败' })) })
    await renderPage(api)
    expect(await screen.findByText('无法读取额度状态')).toBeInTheDocument()
    expect(toggle()).toHaveClass('disabled')
    await waitFor(() => expect(popup()).toHaveTextContent('全自动'))
    expect(popup()).not.toBeDisabled()
  })

  it('TC-033 键盘下移一项并回车写入', async () => {
    const { api } = await renderPage()
    await waitFor(() => expect(popup()).toHaveTextContent('全自动'))
    fireEvent.click(popup())
    const menu = await screen.findByRole('listbox')
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    fireEvent.keyDown(menu, { key: 'Enter' })
    await waitFor(() => expect(api.setPermissionMode).toHaveBeenCalledWith('auto'))
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
  })

  it('TC-034 进页只读一次，获焦不重读', async () => {
    const { api } = await renderPage()
    await waitFor(() => expect(popup()).toHaveTextContent('全自动'))
    fireEvent(window, new Event('focus'))
    fireEvent(document, new Event('visibilitychange'))
    await new Promise((r) => setTimeout(r, 30))
    expect(api.getPermissionModeConfig).toHaveBeenCalledTimes(1)
    expect(api.getClaudeUsageStatusState).toHaveBeenCalledTimes(1)
  })

  it('TC-036 接管失败时弹窗保持打开并报错', async () => {
    const api = makeApi({
      getClaudeUsageStatusState: vi.fn(async () => ({ success: true, integrationState: 'conflict', config: { displayMode: 'always', fiveHourThreshold: 70, sevenDayThreshold: 70 } })),
      ensureClaudeUsageStatusInstalled: vi.fn(async () => ({ success: false, integrationState: 'conflict' })),
    })
    await renderPage(api)
    fireEvent.click(await screen.findByRole('button', { name: '查看接管说明' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认接管' }))
    expect(await screen.findByText('接管失败，请检查配置权限后重试')).toBeInTheDocument()
    expect(screen.getByText('接管 Claude statusLine')).toBeInTheDocument()
  })

  it('TC-037 等首个快照时按已接入处理', async () => {
    const api = makeApi({ getClaudeUsageStatusState: vi.fn(async () => ({ success: true, integrationState: 'waiting_for_data', config: { displayMode: 'always', fiveHourThreshold: 70, sevenDayThreshold: 70 } })) })
    await renderPage(api)
    expect(await screen.findByText('已接入')).toBeInTheDocument()
    expect(toggle()).not.toHaveClass('disabled')
    expect(preview()).toHaveTextContent('Opus 5')
  })

  it('TC-038 接管行的状态文字与按钮在同一行容器里', async () => {
    const api = makeApi({ getClaudeUsageStatusState: vi.fn(async () => ({ success: true, integrationState: 'conflict', config: { displayMode: 'always', fiveHourThreshold: 70, sevenDayThreshold: 70 } })) })
    await renderPage(api)
    const text = await screen.findByText('检测到已有自定义 statusLine')
    const acts = text.closest('.cc-acts')
    expect(acts).not.toBeNull()
    expect(within(acts).getByRole('button', { name: '查看接管说明' })).toBeInTheDocument()
  })
})

describe('重试与不可交互', () => {
  it('TC-039 开关从关拨到开写入 always 并原样带回阈值', async () => {
    const api = makeApi({ getClaudeUsageStatusState: vi.fn(async () => ({ success: true, integrationState: 'ready', config: { displayMode: 'off', fiveHourThreshold: 55, sevenDayThreshold: 66 } })) })
    await renderPage(api)
    await waitFor(() => expect(toggle()).not.toHaveClass('on'))
    expect(preview()).not.toHaveTextContent('Opus 5')
    fireEvent.click(toggle())
    await waitFor(() => expect(api.saveClaudeUsageStatusConfig).toHaveBeenCalledWith({ displayMode: 'always', fiveHourThreshold: 55, sevenDayThreshold: 66 }))
    expect(await screen.findByText('显示设置已保存')).toBeInTheDocument()
    await waitFor(() => expect(preview()).toHaveTextContent('Opus 5'))
  })

  it('TC-040 两侧「重试」重新读取，成功后回到正常', async () => {
    const perm = vi.fn()
      .mockResolvedValueOnce({ success: false, error: '读取失败' })
      .mockResolvedValue({ success: true, mode: 'bypassPermissions', isConfigured: true, isKnownMode: true })
    const status = vi.fn()
      .mockResolvedValueOnce({ success: false, error: '读取失败' })
      .mockResolvedValue({ success: true, integrationState: 'ready', config: { displayMode: 'always', fiveHourThreshold: 70, sevenDayThreshold: 70 } })
    await renderPage(makeApi({ getPermissionModeConfig: perm, getClaudeUsageStatusState: status }))
    const [permRetry, statusRetry] = await screen.findAllByRole('button', { name: '重试' })
    fireEvent.click(permRetry)
    fireEvent.click(statusRetry)
    await waitFor(() => expect(popup()).toHaveTextContent('全自动'))
    expect(await screen.findByText('已接入')).toBeInTheDocument()
  })

  it('TC-041 「重试接入」重新执行接入，成功后显示已接入', async () => {
    const api = makeApi({ getClaudeUsageStatusState: vi.fn(async () => ({ success: true, integrationState: 'setup_failed', config: { displayMode: 'always', fiveHourThreshold: 70, sevenDayThreshold: 70 } })) })
    await renderPage(api)
    fireEvent.click(await screen.findByRole('button', { name: '重试接入' }))
    await waitFor(() => expect(api.ensureClaudeUsageStatusInstalled).toHaveBeenCalledWith({ intent: 'explicit' }))
    expect(await screen.findByText('已接入')).toBeInTheDocument()
    expect(toggle()).not.toHaveClass('disabled')
  })

  it('TC-042 设置行与终端预览点击无反应', async () => {
    const { api, container } = await renderPage()
    await waitFor(() => expect(popup()).toHaveTextContent('全自动'))
    fireEvent.click(preview())
    container.querySelectorAll('.cc-row').forEach((row) => fireEvent.click(row.querySelector('.lb')))
    expect(api.setPermissionMode).not.toHaveBeenCalled()
    expect(api.saveClaudeUsageStatusConfig).not.toHaveBeenCalled()
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })
})
