/**
 * 模型接入页组件测试（4-test-cases.md 模块 E）
 *
 * 负责：
 * - 渲染 ModelsPage，window.electronAPI 用 vi.fn 替身；toast、confirmDialog 用 vi.mock 捕获
 * - 断言各状态的可见文案、一屏一个主按钮、弹层、写入后的 Toast 与自动测、后台写回与重新激活重读
 * - TC-E18 侧栏位置一并放在这里
 *
 * 系统时间固定为 2026-09-26T13:00:00Z（北京时间 21:00），时区按北京时间算。
 *
 * @module tests/models/ModelsPage.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'

process.env.TZ = 'Asia/Shanghai'

vi.mock('../../src/components/Toast', () => {
  const toast = { show: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), dismiss: vi.fn() }
  return { toast, default: () => null, notifyToast: vi.fn(), resetToastForTests: vi.fn() }
})
vi.mock('../../src/components/Modal/confirmDialog', () => {
  const confirmDialog = vi.fn(async () => false)
  return { confirmDialog, default: confirmDialog }
})

const { toast } = await import('../../src/components/Toast')
const { confirmDialog } = await import('../../src/components/Modal/confirmDialog')
const { default: ModelsPage } = await import('../../src/features/models/ModelsPage')

const WRITE_FAIL = '配置目录没有写入权限，检查权限后重试'
const MODEL = { id: 'deepseek-flash', name: 'deepseek-flash', effort: 'max', contextTokens: 1000000, maxOutputTokens: 128000, lastResult: { ok: true, reason: null, at: '2026-09-26T12:38:00.000Z', source: 'test' } }
const V4 = { ...MODEL, id: 'deepseek-v4-pro', name: 'deepseek-v4-pro', lastResult: null }

/** §0「models:list 返回结构」 */
const base = () => ({
  claudeCode: { found: true, version: '2.1.283' },
  commands: { installed: true, missing: [], stale: false, onPath: true, binDir: '~/.local/bin' },
  providers: { deepseek: { keySet: true, keyReadable: true, models: [{ ...MODEL }] } },
})
const firstTime = () => ({ ...base(), providers: { deepseek: { keySet: false, keyReadable: false, models: [] } } })
const withModels = (...models) => ({ ...base(), providers: { deepseek: { keySet: true, keyReadable: true, models } } })

const never = () => new Promise(() => {})

/** 构造桌面端接口；listeners 收集 models:changed 订阅 */
function makeApi(data, overrides = {}) {
  const listeners = []
  const unsub = vi.fn()
  return {
    listeners,
    unsub,
    modelsList: vi.fn(async () => ({ success: true, data: structuredClone(data) })),
    modelsSetKey: vi.fn(async () => ({ success: true, data: { provider: { keySet: true, keyReadable: true, models: [{ ...MODEL, lastResult: null }] } } })),
    modelsTest: vi.fn(async () => ({ success: true, data: { lastResult: { ok: true, reason: null, at: '2026-09-26T13:00:00.000Z', source: 'test' } } })),
    modelsAddModel: vi.fn(async () => ({ success: true, data: { provider: { keySet: true, keyReadable: true, models: [{ ...MODEL }, { ...V4 }] } } })),
    modelsUpdateModel: vi.fn(async ({ modelId, patch }) => ({ success: true, data: { model: { ...MODEL, ...patch, id: patch.name || modelId } } })),
    modelsRemoveModel: vi.fn(async () => ({ success: true, data: { provider: { keySet: true, keyReadable: true, models: [{ ...MODEL }] } } })),
    modelsRecheckClaude: vi.fn(async () => ({ success: true, data: { found: true, version: '2.1.283' } })),
    modelsInstallCommands: vi.fn(async () => ({ success: true, data: { installed: ['codepal-deepseek-flash'] } })),
    onModelsChanged: vi.fn((cb) => { listeners.push(cb); return unsub }),
    ...overrides,
  }
}

/** 渲染并等首次读取完成 */
async function renderPage(data = base(), overrides = {}) {
  const api = makeApi(data, overrides)
  window.electronAPI = api
  const utils = render(<ModelsPage />)
  await waitFor(() => expect(api.modelsList).toHaveBeenCalled())
  await waitFor(() => expect(document.querySelector('.np-sk')).toBeNull())
  return { api, ...utils }
}

const primaries = () => [...document.querySelectorAll('button.btn--primary:not([disabled])')]
const row = (id = 'deepseek-flash') => document.querySelector(`[data-model="${id}"]`)
const rowButtons = (id) => [...row(id).querySelectorAll('button')]
const btn = (text) => text === '填写 Key'
  ? [...screen.getByText('DeepSeek').closest('section').querySelectorAll('button')].find(b => b.textContent === text)
  : screen.getByRole('button', { name: text })
const queryBtn = (text) => screen.queryByRole('button', { name: text })
const desc = (id = 'deepseek-flash') => row(id).querySelector('.ds')?.textContent ?? null
const expand = (name = 'deepseek-flash') => fireEvent.click(screen.getByTitle(name))

beforeEach(() => {
  vi.setSystemTime(new Date('2026-09-26T13:00:00.000Z'))
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
  delete window.electronAPI
})

describe('TC-005 模块 E · 状态呈现', () => {
  it('TC-E01 正常：可用 + 20:38 测过 + 唯一按钮「测一下」', async () => {
    await renderPage()
    expect(screen.getByText('可用')).toBeInTheDocument()
    expect(desc()).toBe('20:38 测过')
    const buttons = rowButtons('deepseek-flash')
    expect(buttons).toHaveLength(1)
    expect(buttons[0]).toHaveTextContent('测一下')
    expect(buttons[0]).not.toBeDisabled()
  })

  it('TC-E02 首次：主按钮「填写 Key」、无模型行', async () => {
    await renderPage(firstTime())
    expect(primaries()).toHaveLength(1)
    expect(primaries()[0]).toHaveTextContent('填写 Key')
    expect(queryBtn('测一下')).toBeNull()
  })

  it('TC-E03 未测试不写描述', async () => {
    await renderPage(withModels({ ...MODEL, lastResult: null }))
    expect(screen.getByText('未测试')).toBeInTheDocument()
    expect(desc()).toBeNull()
    expect(document.body.textContent).not.toMatch(/测过|还没测过/)
  })

  it('TC-E04 失败：不可用 + 红字原因 + 重试', async () => {
    await renderPage(withModels({ ...MODEL, lastResult: { ok: false, reason: 'key', at: '2026-09-26T12:50:00.000Z' } }))
    expect(screen.getByText('不可用')).toBeInTheDocument()
    expect(screen.getByText('Key 无效，更换 Key 后重试')).toHaveClass('bad')
    expect(rowButtons('deepseek-flash')[0]).toHaveTextContent('重试')
  })

  it('TC-E05 首次读取：卡头照常，模型行是骨架', async () => {
    window.electronAPI = makeApi(base(), { modelsList: vi.fn(never) })
    render(<ModelsPage />)
    expect(screen.getByText('DeepSeek')).toBeInTheDocument()
    expect(document.querySelector('.np-sk')).not.toBeNull()
    expect(screen.queryByText('加载中...')).toBeNull()
  })

  it('TC-E06 配置读不出：整块「读取失败」+ 重试', async () => {
    const api = makeApi(base(), { modelsList: vi.fn(async () => ({ success: false, error: { code: 'read_failed', message: '模型配置文件无法解析' } })) })
    window.electronAPI = api
    render(<ModelsPage />)
    expect(await screen.findByText('读取失败')).toBeInTheDocument()
    expect(screen.getByText('模型配置文件无法解析，修好或删除它后重试')).toBeInTheDocument()
    const calls = api.modelsList.mock.calls.length
    fireEvent.click(btn('重试'))
    await waitFor(() => expect(api.modelsList.mock.calls.length).toBe(calls + 1))
  })

  it('TC-E07 没找到 Claude Code：重新检测 + 测一下禁用，更换 Key 可点', async () => {
    await renderPage({ ...base(), claudeCode: { found: false } })
    expect(screen.getByText('没找到 Claude Code')).toBeInTheDocument()
    expect(btn('重新检测')).toBeInTheDocument()
    expect(btn('测一下')).toBeDisabled()
    expect(btn('更换 Key')).not.toBeDisabled()
  })

  it('TC-E08 读不到 Key：橙点 + 橙字 + 填写 Key，测一下禁用', async () => {
    const data = base()
    data.providers.deepseek.keyReadable = false
    await renderPage(data)
    expect(screen.getByText('读不到 Key')).toBeInTheDocument()
    expect(screen.getByText('本机保存的 Key 找不到了，重新填写')).toHaveClass('warn')
    expect(btn('填写 Key')).toBeInTheDocument()
    expect(btn('测一下')).toBeDisabled()
  })

  it('TC-E09 没填 Key + 没找到 Claude Code + 命令未安装：只有「填写 Key」是主按钮', async () => {
    await renderPage({ ...firstTime(), claudeCode: { found: false }, commands: { installed: false, missing: ['deepseek-flash'], stale: false, onPath: true, binDir: '~/.local/bin' } })
    expect(primaries()).toHaveLength(1)
    expect(primaries()[0]).toHaveTextContent('填写 Key')
    expect(btn('重新检测')).not.toHaveClass('btn--primary')
    expect(queryBtn('安装命令')).toBeNull()
  })

  it('TC-E31 Claude Code 版本太旧的文案', async () => {
    await renderPage({ ...base(), claudeCode: { found: true, version: '2.1.200', tooOld: true, required: '2.1.251' } })
    expect(screen.getByText('Claude Code 版本太旧')).toBeInTheDocument()
    expect(screen.getByText('当前 2.1.200，需要 2.1.251 或更新')).toBeInTheDocument()
    expect(btn('测一下')).toBeDisabled()
  })

  it('TC-E32 三种时间写法', async () => {
    const at = (id, iso) => ({ ...MODEL, id, name: id, lastResult: { ok: true, reason: null, at: iso } })
    await renderPage(withModels(at('m-yday', '2026-09-25T13:48:00.000Z'), at('m-year', '2026-09-17T00:15:00.000Z'), at('m-old', '2025-12-03T02:00:00.000Z')))
    expect(desc('m-yday')).toBe('昨天 21:48 测过')
    expect(desc('m-year')).toBe('9月17日 08:15 测过')
    expect(desc('m-old')).toBe('2025年12月3日 测过')
  })

  it('TC-E35 没有模型只剩卡头与添加；长名字省略带全名；不在 PATH 时复制完整路径', async () => {
    await renderPage(withModels())
    expect(queryBtn('测一下')).toBeNull()
    expect(btn('＋ 添加模型')).toBeInTheDocument()
    cleanup()

    const long = 'deepseek-flash-experimental-preview-20260926-long-name'
    await renderPage(withModels({ ...MODEL, id: long, name: long }))
    const nameEl = screen.getByTitle(long)
    expect(nameEl).toHaveClass('mj-name')
    // jsdom 不加载样式表，改为核对本页样式里 .mj-name 的省略规则
    const css = fs.readFileSync(path.resolve(__dirname, '../../src/features/models/models.css'), 'utf8')
    expect(css).toMatch(/\.mj-page \.mj-name \{[^}]*text-overflow: ellipsis/)
    cleanup()

    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await renderPage({ ...base(), commands: { ...base().commands, onPath: false } })
    expand()
    fireEvent.click(btn('复制命令'))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('~/.local/bin/codepal-deepseek-flash'))
  })
})

describe('TC-005 模块 E · Key 弹层', () => {
  it('TC-E10 打开 Key 弹层后卡头按钮退白，保存禁用', async () => {
    await renderPage(firstTime())
    fireEvent.click(btn('填写 Key'))
    expect(screen.getByText('DeepSeek API Key')).toBeInTheDocument()
    const input = screen.getByPlaceholderText('粘贴 Key')
    expect(input).toHaveAttribute('type', 'password')
    expect(btn('填写 Key')).not.toHaveClass('btn--primary')
    expect(primaries()).toHaveLength(0)
    expect(btn('保存')).toBeDisabled()
  })

  it('TC-E11 Key 前缀不对：红字且不调接口', async () => {
    const { api } = await renderPage(firstTime())
    fireEvent.click(btn('填写 Key'))
    const input = screen.getByPlaceholderText('粘贴 Key')
    fireEvent.change(input, { target: { value: 'ab-123' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByText('DeepSeek 的 Key 以 sk- 开头')).toBeInTheDocument()
    expect(api.modelsSetKey).not.toHaveBeenCalled()
  })

  it('TC-E19 保存失败：弹层不关、红字原因、不弹 Toast', async () => {
    await renderPage(firstTime(), { modelsSetKey: vi.fn(async () => ({ success: false, error: { code: 'write_denied', message: WRITE_FAIL } })) })
    fireEvent.click(btn('填写 Key'))
    fireEvent.change(screen.getByPlaceholderText('粘贴 Key'), { target: { value: 'sk-fixture' } })
    fireEvent.click(btn('保存'))
    expect(await screen.findByText(`保存失败：${WRITE_FAIL}`)).toBeInTheDocument()
    expect(screen.getByPlaceholderText('粘贴 Key')).toBeInTheDocument()
    expect(btn('保存')).not.toBeDisabled()
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('TC-E20 保存成功：Toast、弹层关、自动测一次；更换时输入框为空', async () => {
    const { api } = await renderPage(firstTime(), { modelsTest: vi.fn(never) })
    fireEvent.click(btn('填写 Key'))
    const input = screen.getByPlaceholderText('粘贴 Key')
    fireEvent.change(input, { target: { value: 'sk-fixture' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(api.modelsSetKey).toHaveBeenCalledWith({ providerId: 'deepseek', key: 'sk-fixture' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Key 已保存'))
    expect(toast.success).toHaveBeenCalledTimes(1)
    expect(screen.queryByPlaceholderText('粘贴 Key')).toBeNull()
    expect(api.modelsTest).toHaveBeenCalledTimes(1)
    expect(api.modelsTest).toHaveBeenCalledWith({ providerId: 'deepseek', modelId: 'deepseek-flash' })
    expect(rowButtons('deepseek-flash')[0]).toHaveTextContent('测试中…')
    fireEvent.click(btn('更换 Key'))
    expect(screen.getByPlaceholderText('粘贴 Key')).toHaveValue('')
  })

  it('TC-E33 Esc 关闭 Key 弹层且不保存', async () => {
    const { api } = await renderPage(firstTime())
    fireEvent.click(btn('填写 Key'))
    fireEvent.change(screen.getByPlaceholderText('粘贴 Key'), { target: { value: 'sk-fixture' } })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByPlaceholderText('粘贴 Key')).toBeNull()
    expect(api.modelsSetKey).not.toHaveBeenCalled()
  })
})

describe('TC-005 模块 E · 测一下与后台写回', () => {
  it('TC-E12 测一下期间「测试中…」禁用，状态点不动', async () => {
    await renderPage(base(), { modelsTest: vi.fn(never) })
    fireEvent.click(btn('测一下'))
    const b = rowButtons('deepseek-flash')[0]
    expect(b).toHaveTextContent('测试中…')
    expect(b).toBeDisabled()
    expect(screen.getByText('可用')).toBeInTheDocument()
  })

  it('TC-E13 后台写回：原地更新、不弹 Toast、卸载时取消订阅', async () => {
    const { api, unmount } = await renderPage()
    act(() => {
      api.listeners[0]({ providerId: 'deepseek', modelId: 'deepseek-flash', lastResult: { ok: false, reason: 'balance', at: '2026-09-26T13:05:00.000Z', source: 'review' } })
    })
    expect(screen.getByText('余额不足，充值后重试')).toBeInTheDocument()
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
    unmount()
    expect(api.unsub).toHaveBeenCalledTimes(1)
  })

  it('TC-E34 窗口重新激活时重读', async () => {
    const { api } = await renderPage()
    const n = api.modelsList.mock.calls.length
    expect(n).toBeGreaterThanOrEqual(1)
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(api.modelsList).toHaveBeenCalledTimes(n + 1)
  })
})

describe('TC-005 模块 E · 添加、改名、参数', () => {
  it('TC-E14 添加重名 / 与供应商同名：红字、添加禁用、不调接口', async () => {
    const { api } = await renderPage()
    fireEvent.click(btn('＋ 添加模型'))
    const input = screen.getByPlaceholderText('模型名，例如 deepseek-v4-pro')
    fireEvent.change(input, { target: { value: 'deepseek-flash' } })
    expect(screen.getByText('已经有这个模型了')).toBeInTheDocument()
    expect(btn('添加')).toBeDisabled()
    fireEvent.change(input, { target: { value: 'deepseek' } })
    expect(screen.getByText('不能和供应商同名')).toBeInTheDocument()
    expect(btn('添加')).toBeDisabled()
    expect(api.modelsAddModel).not.toHaveBeenCalled()
  })

  it('TC-E21 添加成功：新行、Toast、自动测', async () => {
    const { api } = await renderPage()
    fireEvent.click(btn('＋ 添加模型'))
    fireEvent.change(screen.getByPlaceholderText('模型名，例如 deepseek-v4-pro'), { target: { value: 'deepseek-v4-pro' } })
    fireEvent.click(btn('添加'))
    await waitFor(() => expect(api.modelsAddModel).toHaveBeenCalledWith({ providerId: 'deepseek', name: 'deepseek-v4-pro' }))
    await waitFor(() => expect(row('deepseek-v4-pro')).not.toBeNull())
    expect(toast.success).toHaveBeenCalledTimes(1)
    expect(toast.success).toHaveBeenCalledWith('已添加 deepseek-v4-pro')
    expect(api.modelsTest).toHaveBeenCalledTimes(1)
    expect(api.modelsTest).toHaveBeenCalledWith({ providerId: 'deepseek', modelId: 'deepseek-v4-pro' })
  })

  it('TC-E15 改名失焦保存后提示并自动测新名字', async () => {
    const { api } = await renderPage()
    expand()
    const input = screen.getByLabelText('模型名')
    fireEvent.change(input, { target: { value: 'deepseek-v4-pro' } })
    fireEvent.blur(input)
    await waitFor(() => expect(api.modelsUpdateModel).toHaveBeenCalledWith({ providerId: 'deepseek', modelId: 'deepseek-flash', patch: { name: 'deepseek-v4-pro' } }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('已保存'))
    expect(toast.success).toHaveBeenCalledTimes(1)
    expect(api.modelsTest).toHaveBeenCalledTimes(1)
    expect(api.modelsTest).toHaveBeenCalledWith({ providerId: 'deepseek', modelId: 'deepseek-v4-pro' })
    // 展开区跟着新名字，不收起
    expect(screen.getByLabelText('模型名')).toHaveValue('deepseek-v4-pro')
  })

  it('SC-026 TC-075 原接入移除强度控件，Key/模型名/上限/终端/移除仍保留', async () => {
    const { api } = await renderPage()
    expand()
    expect(screen.queryByRole('button', { name: '思考强度' })).toBeNull()
    expect(screen.queryByText('思考强度')).toBeNull()
    expect(screen.getByLabelText('模型名')).toHaveValue('deepseek-flash')
    expect(screen.getByLabelText('上下文上限')).toHaveValue('1,000,000')
    expect(screen.getByLabelText('输出上限')).toHaveValue('128,000')
    expect(btn('更换 Key')).toBeInTheDocument()
    expect(btn('复制命令')).toBeInTheDocument()
    expect(btn('移除模型')).toBeInTheDocument()
    expect(api.modelsUpdateModel).not.toHaveBeenCalled()
    expect(api.modelsTest).not.toHaveBeenCalled()
  })

  it('TC-E23 上限填非正整数：红字、不保存；带千分位的正整数照存', async () => {
    const { api } = await renderPage()
    expand()
    const input = screen.getByLabelText('上下文上限')
    expect(input).toHaveValue('1,000,000')
    fireEvent.change(input, { target: { value: 'abc' } })
    fireEvent.blur(input)
    expect(screen.getByText('填正整数')).toBeInTheDocument()
    expect(api.modelsUpdateModel).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: '0' } })
    fireEvent.blur(input)
    expect(screen.getByText('填正整数')).toBeInTheDocument()
    expect(api.modelsUpdateModel).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: '1,048,576' } })
    fireEvent.blur(input)
    await waitFor(() => expect(api.modelsUpdateModel).toHaveBeenCalledWith({ providerId: 'deepseek', modelId: 'deepseek-flash', patch: { contextTokens: 1048576 } }))
  })

  it('输出上限超过 128,000 时红字「最多 128,000」、不保存', async () => {
    const { api } = await renderPage()
    expand()
    const input = screen.getByLabelText('输出上限')
    expect(input).toHaveValue('128,000')
    fireEvent.change(input, { target: { value: '200,000' } })
    fireEvent.blur(input)
    expect(screen.getByText('最多 128,000')).toBeInTheDocument()
    expect(api.modelsUpdateModel).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: '64,000' } })
    fireEvent.blur(input)
    await waitFor(() => expect(api.modelsUpdateModel).toHaveBeenCalledWith({ providerId: 'deepseek', modelId: 'deepseek-flash', patch: { maxOutputTokens: 64000 } }))
  })

  it('TC-E24 改名写入失败：红 Toast、输入框回到原名、不重测', async () => {
    const { api } = await renderPage(base(), { modelsUpdateModel: vi.fn(async () => ({ success: false, error: { code: 'write_denied', message: WRITE_FAIL } })) })
    expand()
    const input = screen.getByLabelText('模型名')
    fireEvent.change(input, { target: { value: 'deepseek-v4-pro' } })
    fireEvent.blur(input)
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(`保存失败：${WRITE_FAIL}`))
    expect(toast.error).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.getByLabelText('模型名')).toHaveValue('deepseek-flash'))
    expect(screen.getByTitle('deepseek-flash')).toBeInTheDocument()
    expect(api.modelsTest).not.toHaveBeenCalled()
  })
})

describe('TC-005 模块 E · 复制、移除', () => {
  it('TC-E17 复制命令写入剪贴板（在 PATH 里）', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await renderPage()
    expand()
    fireEvent.click(btn('复制命令'))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('codepal-deepseek-flash'))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('已复制'))
  })

  it('TC-E16 移除确认对话框的参数；取消不调接口', async () => {
    const { api } = await renderPage()
    expand()
    fireEvent.click(btn('移除模型'))
    await waitFor(() => expect(confirmDialog).toHaveBeenCalledTimes(1))
    const { onConfirm, ...opts } = confirmDialog.mock.calls[0][0]
    expect(opts).toEqual({
      title: '移除 deepseek-flash？',
      description: '移除后审核和终端都不能再用它，Key 不受影响。',
      confirmText: '移除',
      busyText: '移除中…',
      danger: true,
    })
    expect(typeof onConfirm).toBe('function')
    await act(async () => {})
    expect(api.modelsRemoveModel).not.toHaveBeenCalled()
  })

  it('TC-E25 确认移除后行消失、Toast', async () => {
    // 照真实对话框：点「移除」执行 onConfirm，返回 true 才关
    confirmDialog.mockImplementationOnce(async (opts) => opts.onConfirm())
    const { api } = await renderPage(withModels({ ...MODEL }, { ...V4 }))
    expand('deepseek-v4-pro')
    fireEvent.click(btn('移除模型'))
    await waitFor(() => expect(api.modelsRemoveModel).toHaveBeenCalledWith({ providerId: 'deepseek', modelId: 'deepseek-v4-pro' }))
    await waitFor(() => expect(row('deepseek-v4-pro')).toBeNull())
    expect(row('deepseek-flash')).not.toBeNull()
    expect(toast.success).toHaveBeenCalledTimes(1)
    expect(toast.success).toHaveBeenCalledWith('已移除 deepseek-v4-pro')
  })

  it('TC-E26 移除失败：红 Toast、行还在、对话框留着（onConfirm 返回 false）', async () => {
    let confirmResult
    confirmDialog.mockImplementationOnce(async (opts) => { confirmResult = await opts.onConfirm(); return false })
    await renderPage(withModels({ ...MODEL }, { ...V4 }), { modelsRemoveModel: vi.fn(async () => ({ success: false, error: { code: 'write_denied', message: WRITE_FAIL } })) })
    expand('deepseek-v4-pro')
    fireEvent.click(btn('移除模型'))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(`移除失败：${WRITE_FAIL}`))
    expect(confirmResult).toBe(false)
    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(row('deepseek-flash')).not.toBeNull()
    expect(row('deepseek-v4-pro')).not.toBeNull()
  })
})

describe('TC-005 模块 E · 终端命令', () => {
  const noCmd = () => ({ ...base(), commands: { installed: false, missing: ['deepseek-flash'], stale: false, onPath: true, binDir: '~/.local/bin' } })

  it('TC-E27 命令未安装：顶部一行 + 主按钮「安装命令」', async () => {
    await renderPage(noCmd())
    expect(screen.getByText('终端命令未安装')).toBeInTheDocument()
    expect(screen.getByText('未安装')).toBeInTheDocument()
    expect(primaries()).toHaveLength(1)
    expect(primaries()[0]).toHaveTextContent('安装命令')
  })

  it('TC-E28 点安装：安装中…，成功后那一行消失 + Toast', async () => {
    let resolveInstall
    const { api } = await renderPage(noCmd(), { modelsInstallCommands: vi.fn(() => new Promise((r) => { resolveInstall = r })) })
    fireEvent.click(btn('安装命令'))
    expect(btn('安装中…')).toBeDisabled()
    api.modelsList.mockResolvedValue({ success: true, data: base() })
    await act(async () => { resolveInstall({ success: true, data: { installed: ['codepal-deepseek-flash'] } }) })
    await waitFor(() => expect(screen.queryByText('终端命令未安装')).toBeNull())
    expect(toast.success).toHaveBeenCalledTimes(1)
    expect(toast.success).toHaveBeenCalledWith('已安装终端命令')
  })

  it('TC-E29 安装失败：那一行留着 + 红 Toast', async () => {
    const message = '安装失败：~/.local/bin 没有写入权限，检查权限后重试'
    await renderPage(noCmd(), { modelsInstallCommands: vi.fn(async () => ({ success: false, error: { code: 'write_denied', message } })) })
    fireEvent.click(btn('安装命令'))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(message))
    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(screen.getByText('终端命令未安装')).toBeInTheDocument()
    await waitFor(() => expect(btn('安装命令')).not.toBeDisabled())
  })

  it('TC-E30 没找到 Claude Code 与命令未安装同时出现：只有「重新检测」是主按钮', async () => {
    await renderPage({ ...noCmd(), claudeCode: { found: false } })
    expect(screen.getByText('没找到 Claude Code')).toBeInTheDocument()
    expect(screen.getByText('终端命令未安装')).toBeInTheDocument()
    expect(primaries()).toHaveLength(1)
    expect(primaries()[0]).toHaveTextContent('重新检测')
    expect(btn('安装命令')).not.toHaveClass('btn--primary')
  })
})

describe('TC-005 模块 E · 侧栏', () => {
  const withUserAgent = (ua, fn) => {
    const spy = vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(ua)
    try { return fn() } finally { spy.mockRestore() }
  }
  const envGroupLabels = () => {
    const group = [...document.querySelectorAll('.nav-group')].find((g) => g.querySelector('.nav-group-label')?.textContent === '环境配置')
    return [...group.querySelectorAll('.nav-label')].map((n) => n.textContent)
  }

  it('非 Mac 上不显示「模型接入」（终端命令只支持 macOS）', async () => {
    const { default: WorkbenchLayout } = await import('../../src/components/WorkbenchLayout')
    withUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', () => render(<WorkbenchLayout activeModule="usage"><div /></WorkbenchLayout>))
    expect(envGroupLabels()).toEqual(['Claude Code 设置', '网络诊断'])
  })

  it('TC-E18 环境配置组顺序；VALID_ACTIVE_MODULES 含 models', async () => {
    const { default: WorkbenchLayout } = await import('../../src/components/WorkbenchLayout')
    withUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', () => render(<WorkbenchLayout activeModule="usage"><div /></WorkbenchLayout>))
    expect(envGroupLabels()).toEqual(['Claude Code 设置', '模型接入', '模型汇总', '网络诊断'])
    const { VALID_ACTIVE_MODULES } = await import('../../src/App.jsx')
    expect(VALID_ACTIVE_MODULES.has('models')).toBe(true)
  })
})
