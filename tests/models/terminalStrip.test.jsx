/**
 * 模型接入 · 在终端里用 · 页面顶上那一行（specs/v2.1.22-在终端里用/4-test-cases.md）
 *
 * 负责：
 * - 渲染 ModelsPage，window.electronAPI 用 vi.fn 替身；toast、confirmDialog 用 vi.mock 捕获
 * - 各状态的说明、状态点、按钮（定稿 §4、§5；后-11 优先级；真话表 真-01/03/04/05/06/09/11）
 * - 安装 / 更新 / 加入 PATH 的进行中、成功、失败、取消与 Toast
 *
 * @module tests/models/terminalStrip.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'

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
// 新组件与纯函数；先红时这里解析不到
const { default: TerminalStrip } = await import('../../src/features/models/TerminalStrip')
const { terminalStrip } = await import('../../src/features/models/modelsView')

const LINE = '在任意终端输入 codepal，↑↓ 选模型，回车就在当前文件夹打开 Claude Code'
const MODEL = { id: 'glm-5.3', name: 'glm-5.3', effort: 'high', contextTokens: 200000, maxOutputTokens: 128000, lastResult: { ok: true, reason: null, at: '2026-10-14T01:00:00.000Z', source: 'test' } }
const ready = () => ({ installed: true, missing: [], missingEntries: [], stale: false, onPath: true, binDir: '~/.local/bin', otherApp: null,
  entry: 'ok', readyCount: 1, shell: 'zsh', profile: '~/.zprofile', pathStatus: 'found' })
const data = (commands = {}, providers) => ({
  claudeCode: { found: true, version: '2.1.296' },
  commands: { ...ready(), ...commands },
  providers: providers || { 'zhipu-api': { keySet: true, keyReadable: true, models: [{ ...MODEL }] } },
})
const never = () => new Promise(() => {})

function makeApi(d, overrides = {}) {
  return {
    modelsList: vi.fn(async () => ({ success: true, data: structuredClone(d) })),
    modelsInstallCommands: vi.fn(async () => ({ success: true, data: { installed: ['codepal-zhipu-api--glm-5.3'], entry: 'written' } })),
    modelsAddToPath: vi.fn(async () => ({ success: true, data: { profile: '~/.zprofile', added: true, pathStatus: 'found', commands: ready() } })),
    onModelsChanged: vi.fn(() => () => {}),
    ...overrides,
  }
}
async function renderPage(d = data(), overrides = {}) {
  const api = makeApi(d, overrides)
  window.electronAPI = api
  const utils = render(<ModelsPage />)
  await waitFor(() => expect(api.modelsList).toHaveBeenCalled())
  await waitFor(() => expect(document.querySelector('.np-sk')).toBeNull())
  return { api, ...utils }
}
const strip = () => document.querySelector('.mj-strip')
const stripBtn = () => strip()?.querySelector('button') || null

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  delete window.electronAPI
})

describe('顶上一行（F-001）', () => {
  it('TC-001 已装好：名称 + 用法 + 绿点「已装好」，没有按钮；被挡住卡里不再有终端命令；真-01 出现、真-05 / 真-06 / 真-09 消失', async () => {
    await renderPage()
    expect(strip()).toHaveTextContent('在终端里用')
    expect(strip()).toHaveTextContent(LINE)
    expect(strip().querySelector('.np-st')).toHaveTextContent('已装好')
    expect(strip().querySelector('.np-st')).not.toHaveClass('warn')
    expect(stripBtn()).toBeNull()
    expect(screen.queryByText('终端命令未安装')).toBeNull()
    expect(strip()).not.toHaveTextContent('名字被占')
    expect(strip()).not.toHaveTextContent('还没有测过能用的模型')
    expect(strip()).not.toHaveTextContent('加进你的 shell 的 PATH')
  })

  it('TC-001 后-11-例1 装好、PATH 对、有可用模型 → 已装好；后-11-例2 差一步排在要更新前面；后-11-例3 有命令缺 → 未安装', () => {
    const page = (c) => terminalStrip(data(c))
    expect(page({}).kind).toBe('ready')
    expect(page({ pathStatus: 'missing', otherApp: { version: '2.1.1', location: '/Applications/CodePal.app', dev: false } }).kind).toBe('no-path')
    expect(page({ missing: ['glm-5.3'] }).kind).toBe('not-installed')
    expect(page({ entry: 'missing' }).kind).toBe('not-installed')
  })

  it('TC-001 后-16-例1 窗口重新激活就重读：codepal 被删后显示「未安装」', async () => {
    const { api } = await renderPage()
    api.modelsList.mockResolvedValue({ success: true, data: data({ entry: 'missing' }) })
    window.dispatchEvent(new Event('focus'))
    await waitFor(() => expect(strip()).toHaveTextContent('未安装'))
  })

  it('TC-002 首次读取：这一行原地骨架，不出空态或按钮', async () => {
    window.electronAPI = makeApi(data(), { modelsList: vi.fn(never) })
    render(<ModelsPage />)
    expect(strip()).not.toBeNull()
    expect(strip().querySelectorAll('.np-sk').length).toBe(2)
    expect(stripBtn()).toBeNull()
  })

  it('TC-003 一个模型都没加：这一行不出现', async () => {
    await renderPage(data({ installed: false, entry: 'missing' }, { 'zhipu-api': { keySet: false, keyReadable: false, models: [] } }))
    expect(strip()).toBeNull()
    expect(screen.getAllByText('填写 Key').length).toBeGreaterThan(0)
  })

  it('TC-004 未安装：说明 + 橙点 + 主按钮「安装命令」；真-01 消失、真-03 出现', async () => {
    await renderPage(data({ installed: false, entry: 'missing', missing: ['glm-5.3'] }))
    expect(strip()).toHaveTextContent('装好后，在任意终端输入 codepal 就能选模型打开 Claude Code')
    expect(strip().querySelector('.np-st')).toHaveClass('warn')
    expect(strip().querySelector('.np-st')).toHaveTextContent('未安装')
    expect(stripBtn()).toHaveTextContent('安装命令')
    expect(stripBtn()).toHaveClass('btn--primary')
    expect(strip()).not.toHaveTextContent('已装好')
  })

  it('TC-005 说明不截断、上下居中', () => {
    const css = fs.readFileSync(path.resolve(__dirname, '../../src/features/models/models.css'), 'utf8')
    expect(css).toMatch(/\.mj-strip \.ds\s*\{[^}]*white-space:\s*normal/)
    render(<TerminalStrip strip={terminalStrip(data())} primary={false} busy={null} onInstall={() => {}} onAddToPath={() => {}} />)
    expect(document.querySelector('.mj-strip .np-row')).not.toBeNull()
    expect(document.querySelector('.mj-strip .ds')).toHaveTextContent(LINE)
  })
})

describe('安装与更新（F-002、F-006）', () => {
  it('TC-006 安装成功：Toast「已安装终端命令」，重读后已装好；真-03 消失、真-11 消失', async () => {
    const { api } = await renderPage(data({ installed: false, entry: 'missing', missing: ['glm-5.3'] }))
    api.modelsList.mockResolvedValue({ success: true, data: data() })
    fireEvent.click(stripBtn())
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('已安装终端命令'))
    expect(toast.success).not.toHaveBeenCalledWith('已更新终端命令')
    await waitFor(() => expect(strip()).toHaveTextContent('已装好'))
  })

  it('TC-007 安装中：按钮禁用「安装中…」，状态点不动', async () => {
    await renderPage(data({ installed: false, entry: 'missing', missing: ['glm-5.3'] }), { modelsInstallCommands: vi.fn(never) })
    fireEvent.click(stripBtn())
    await waitFor(() => expect(stripBtn()).toHaveTextContent('安装中…'))
    expect(stripBtn()).toBeDisabled()
    expect(strip().querySelector('.np-st')).toHaveTextContent('未安装')
  })

  it('TC-008 装好但没有测过能用的模型：灰点已装好；真-06 出现', async () => {
    await renderPage(data({ readyCount: 0 }))
    expect(strip()).toHaveTextContent('还没有测过能用的模型，codepal 列表是空的；先在下面点「测一下」')
    expect(strip().querySelector('.np-st')).toHaveClass('off')
    expect(stripBtn()).toBeNull()
  })

  it('TC-009 安装失败：红色 Toast 写原因，留在未安装', async () => {
    await renderPage(data({ installed: false, entry: 'missing', missing: ['glm-5.3'] }), {
      modelsInstallCommands: vi.fn(async () => ({ success: false, error: { code: 'write_denied', message: '安装失败：~/.local/bin 没有写入权限，检查权限后重试' } })),
    })
    fireEvent.click(stripBtn())
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('安装失败：~/.local/bin 没有写入权限，检查权限后重试'))
    expect(strip()).toHaveTextContent('未安装')
  })

  it('TC-010 名字被占：说明 + 橙点、无按钮；真-05 出现', async () => {
    await renderPage(data({ entry: 'taken' }))
    expect(strip()).toHaveTextContent('已有别的程序叫 codepal，没有覆盖；单个模型的命令照常能用')
    expect(strip().querySelector('.np-st')).toHaveTextContent('名字被占')
    expect(stripBtn()).toBeNull()
  })

  it('TC-023 要更新：说明含版本 + 主按钮「更新命令」；读不到版本不写括号；真-04 出现', async () => {
    await renderPage(data({ otherApp: { version: '2.1.1', location: '/Applications/CodePal.app', dev: false } }))
    expect(strip()).toHaveTextContent('命令还连着另一个 CodePal（2.1.1），点「更新命令」改连这一个')
    expect(strip().querySelector('.np-st')).toHaveTextContent('要更新')
    expect(stripBtn()).toHaveTextContent('更新命令')
    expect(terminalStrip(data({ otherApp: { version: null, location: '/x', dev: false } })).text).toBe('命令还连着另一个 CodePal，点「更新命令」改连这一个')
  })

  it('TC-024 更新中：按钮禁用「更新中…」；成功 Toast「已更新终端命令」；真-04 消失、真-11 出现', async () => {
    let finish
    const { api } = await renderPage(data({ otherApp: { version: '2.1.1', location: '/x', dev: false } }), {
      modelsInstallCommands: vi.fn(() => new Promise((r) => { finish = r })),
    })
    fireEvent.click(stripBtn())
    await waitFor(() => expect(stripBtn()).toHaveTextContent('更新中…'))
    expect(stripBtn()).toBeDisabled()
    api.modelsList.mockResolvedValue({ success: true, data: data() })
    finish({ success: true, data: { installed: [], entry: 'written' } })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('已更新终端命令'))
    await waitFor(() => expect(strip()).not.toHaveTextContent('要更新'))
  })
})

describe('加入 PATH（F-003）', () => {
  const noPath = (c = {}) => data({ pathStatus: 'missing', onPath: false, ...c })

  it('TC-014 差一步：说明 + 橙点 + 主按钮「加入 PATH」；真-02 出现；fish 时换成手动那句、无按钮（真-09 出现）', async () => {
    await renderPage(noPath())
    expect(strip()).toHaveTextContent('命令装好了，但终端还找不到，要把 ~/.local/bin 加入 PATH')
    expect(strip().querySelector('.np-st')).toHaveTextContent('差一步')
    expect(stripBtn()).toHaveTextContent('加入 PATH')
    cleanup()
    await renderPage(noPath({ shell: 'other', profile: null }))
    expect(strip()).toHaveTextContent('命令装好了，但终端还找不到；把 ~/.local/bin 加进你的 shell 的 PATH 后新开终端')
    expect(stripBtn()).toBeNull()
  })

  it('TC-015 确认框写明文件和那一行；按钮「取消」「加入」', async () => {
    await renderPage(noPath())
    fireEvent.click(stripBtn())
    await waitFor(() => expect(confirmDialog).toHaveBeenCalled())
    const opts = confirmDialog.mock.calls[0][0]
    expect(opts.title).toBe('把 ~/.local/bin 加入 PATH？')
    const { container } = render(<div>{opts.description}</div>)
    expect(container).toHaveTextContent('~/.zprofile')
    expect(container).toHaveTextContent('export PATH="$HOME/.local/bin:$PATH"')
    expect(container).toHaveTextContent('新打开的终端窗口就能用 codepal 了')
    expect(opts.confirmText).toBe('加入')
    expect(opts.cancelText).toBe('取消')
    expect(opts.busyText).toBe('加入中…')
  })

  it('TC-016 取消：不调用加入接口，仍是差一步；真-10 消失', async () => {
    const { api } = await renderPage(noPath())
    confirmDialog.mockResolvedValueOnce(false)
    fireEvent.click(stripBtn())
    await waitFor(() => expect(confirmDialog).toHaveBeenCalled())
    expect(api.modelsAddToPath).not.toHaveBeenCalled()
    expect(strip()).toHaveTextContent('差一步')
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('TC-011 加入成功：Toast「已加入 PATH，新开一个终端窗口就能用 codepal」，这一行变已装好；真-02 消失', async () => {
    const { api } = await renderPage(noPath())
    confirmDialog.mockImplementationOnce(async ({ onConfirm }) => onConfirm())
    api.modelsList.mockResolvedValue({ success: true, data: data() })
    fireEvent.click(stripBtn())
    await waitFor(() => expect(api.modelsAddToPath).toHaveBeenCalledWith({ expectedProfile: '~/.zprofile' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('已加入 PATH，新开一个终端窗口就能用 codepal'))
    await waitFor(() => expect(strip()).toHaveTextContent('已装好'))
  })

  it('TC-011 后-15-例2 写好仍找不到 → 红色 Toast；后-15-例3 判断不了 → 只说写好了', async () => {
    const { api } = await renderPage(noPath())
    confirmDialog.mockImplementation(async ({ onConfirm }) => onConfirm())
    api.modelsAddToPath.mockResolvedValueOnce({ success: true, data: { profile: '~/.zprofile', added: true, pathStatus: 'missing', commands: noPath().commands } })
    fireEvent.click(stripBtn())
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('已写入 ~/.zprofile，但终端还是找不到 codepal，看看 shell 配置里有没有改写 PATH'))
    api.modelsAddToPath.mockResolvedValueOnce({ success: true, data: { profile: '~/.zprofile', added: true, pathStatus: 'unknown', commands: ready() } })
    fireEvent.click(stripBtn())
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith('已写入 ~/.zprofile，还没确认终端能不能找到 codepal'))
    confirmDialog.mockReset()
  })

  it('TC-012 加入中：确认框动作按钮的进行中文字「加入中…」', async () => {
    await renderPage(noPath())
    fireEvent.click(stripBtn())
    await waitFor(() => expect(confirmDialog).toHaveBeenCalled())
    expect(confirmDialog.mock.calls[0][0].busyText).toBe('加入中…')
  })

  it('TC-013 加入失败：红色 Toast 写原因，仍是差一步', async () => {
    const { api } = await renderPage(noPath(), {
      modelsAddToPath: vi.fn(async () => ({ success: false, error: { code: 'write_denied', message: '没能写入 ~/.zprofile：没有写入权限，检查这个文件的权限后再试' } })),
    })
    confirmDialog.mockImplementationOnce(async ({ onConfirm }) => onConfirm())
    fireEvent.click(stripBtn())
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('没能写入 ~/.zprofile：没有写入权限，检查这个文件的权限后再试'))
    expect(api.modelsAddToPath).toHaveBeenCalled()
    expect(strip()).toHaveTextContent('差一步')
  })
})
