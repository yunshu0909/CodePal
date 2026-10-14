/**
 * 模型接入 · 在终端里用 · 代码审核（formal.G4 第 1 轮）提出的页面问题的回归测试
 *
 * 负责：
 * - 测试结果变了（点「测一下」的返回、后台推送）时，顶上一行按主进程带回的命令状态更新（后-11）
 * - 点「加入」时把确认框那个文件的身份一起带回主进程核对（后-13-例6）
 *
 * 渲染 ModelsPage，window.electronAPI 用 vi.fn 替身；toast、confirmDialog 用 vi.mock 捕获。
 *
 * @module tests/models/terminalReviewPage.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'

vi.mock('../../src/components/Toast', () => {
  const toast = { show: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), dismiss: vi.fn() }
  return { toast, default: () => null, notifyToast: vi.fn(), resetToastForTests: vi.fn() }
})
vi.mock('../../src/components/Modal/confirmDialog', () => {
  const confirmDialog = vi.fn(async () => false)
  return { confirmDialog, default: confirmDialog }
})

const { confirmDialog } = await import('../../src/components/Modal/confirmDialog')
const { default: ModelsPage } = await import('../../src/features/models/ModelsPage')

const READY = '在任意终端输入 codepal，↑↓ 选模型，回车就在当前文件夹打开 Claude Code'
const EMPTY = '还没有测过能用的模型，codepal 列表是空的；先在下面点「测一下」'
const OK = { ok: true, reason: null, at: '2026-10-14T01:00:00.000Z', source: 'test' }
const MODEL = { id: 'glm-5.3', name: 'glm-5.3', effort: 'high', contextTokens: 200000, maxOutputTokens: 128000, lastResult: null }
const commandsOf = (extra = {}) => ({ installed: true, missing: [], missingEntries: [], stale: false, onPath: true, binDir: '~/.local/bin', otherApp: null,
  entry: 'ok', readyCount: 1, shell: 'zsh', profile: '~/.zprofile', profileIdentity: 'id-1', pathStatus: 'found', ...extra })
const data = (commands = {}) => ({
  claudeCode: { found: true, version: '2.1.296' },
  commands: commandsOf(commands),
  providers: { 'zhipu-api': { keySet: true, keyReadable: true, models: [{ ...MODEL }] } },
})

async function renderPage(d, overrides = {}) {
  const api = {
    modelsList: vi.fn(async () => ({ success: true, data: structuredClone(d) })),
    modelsTest: vi.fn(async () => ({ success: true, data: { lastResult: OK, commands: commandsOf() } })),
    modelsAddToPath: vi.fn(async () => ({ success: true, data: { profile: '~/.zprofile', added: true, pathStatus: 'found', commands: commandsOf() } })),
    modelsInstallCommands: vi.fn(async () => ({ success: true, data: { installed: [], entry: 'written' } })),
    onModelsChanged: vi.fn(() => () => {}),
    ...overrides,
  }
  window.electronAPI = api
  render(<ModelsPage />)
  await waitFor(() => expect(api.modelsList).toHaveBeenCalled())
  await waitFor(() => expect(document.querySelector('.np-sk')).toBeNull())
  return api
}
const strip = () => document.querySelector('.mj-strip')

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  delete window.electronAPI
})

describe('测试结果变了，顶上一行跟着变（后-11）', () => {
  it('TC-008 G4 后台推送带回新的命令状态 → 从「列表是空的」变成已装好', async () => {
    const api = await renderPage(data({ readyCount: 0 }))
    expect(strip()).toHaveTextContent(EMPTY)
    const onChanged = api.onModelsChanged.mock.calls[0][0]
    act(() => onChanged({ providerId: 'zhipu-api', modelId: 'glm-5.3', lastResult: OK, commands: commandsOf() }))
    await waitFor(() => expect(strip()).toHaveTextContent(READY))
  })

  it('TC-008 G4 点「测一下」通过 → 顶上一行按返回的命令状态变成已装好', async () => {
    await renderPage(data({ readyCount: 0 }))
    fireEvent.click(document.querySelector('[data-model="glm-5.3"]').querySelector('button'))
    await waitFor(() => expect(strip()).toHaveTextContent(READY))
  })
})

describe('加入 PATH 时核对文件身份（后-13-例6）', () => {
  it('TC-015 G4 点「加入」→ 把确认框那个文件的身份一起带回', async () => {
    const api = await renderPage(data({ pathStatus: 'missing', onPath: false }))
    confirmDialog.mockImplementationOnce(async ({ onConfirm }) => onConfirm())
    fireEvent.click(strip().querySelector('button'))
    await waitFor(() => expect(api.modelsAddToPath).toHaveBeenCalledWith({ expectedProfile: '~/.zprofile', expectedIdentity: 'id-1' }))
  })
})
