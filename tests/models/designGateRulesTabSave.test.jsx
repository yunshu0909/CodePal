/** v2.1.28 TC-012（代码审核第 1 轮）：边界审查、对账复核点选轮数后，页面上看到的跟着变
 *
 * - 点选后按钮先显示新值并禁用（保存中），保存成功后保持新值，「默认值」一行写恢复成建议值
 * - 保存失败退回原值并红色提示，「默认值」一行回到原样
 * - 高级三项不被这两行的保存带坏
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'

vi.mock('../../src/components/Toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
  default: () => null,
  resetToastForTests: vi.fn(),
}))
const { toast } = await import('../../src/components/Toast')
const { default: Page } = await import('../../src/features/modelHub/ModelHubPage.jsx')

const BOUNDARY = 'formal.design-boundary'
const RECONCILE = 'formal.design-reconcile'
const mk = (vendor, slug) => ({ id: `${vendor}:${slug}`, displayName: slug, enabled: true, efforts: ['high'], effort: 'high' })
const hub = () => ({
  providerConfigError: false,
  order: ['claude:opus', 'codex:gpt-6-sol'],
  vendors: [
    { id: 'claude', name: 'Claude Code', color: 'var(--tool-claude)', blocked: null, models: [mk('claude', 'opus')] },
    { id: 'codex', name: 'Codex', color: 'var(--tool-codex)', blocked: null, models: [mk('codex', 'gpt-6-sol')] },
  ],
})
function effective() {
  return {
    selfReview: false,
    gates: {
      'lite.G0': { reviewers: 1, rounds: 3 },
      'lite.G1': { reviewers: 2, rounds: 3 },
      'formal.G1': { reviewers: 1, rounds: 3 },
      'formal.G2b': { reviewers: 1, rounds: 2 },
      'formal.G3': { reviewers: 1, rounds: 3 },
      'formal.G4': { reviewers: 2, rounds: 3 },
    },
    designGates: { [BOUNDARY]: { rounds: 2 }, [RECONCILE]: { rounds: 3 } },
    advanced: { timeoutMinutes: 20, failoverMax: 3, autoExtendRounds: 1 },
  }
}
const rules = () => ({ effective: effective(), suggested: effective(), changed: false, defaultsVersion: '2026.10.2', exportOk: true })
const ok = (data) => ({ success: true, data, error: null })
const DENIED = { success: false, data: null, error: { code: 'write_denied', message: '配置目录没有写入权限，检查权限后重试' } }

async function show(rulesSet) {
  window.electronAPI = {
    modelsHubList: vi.fn(async () => ok(hub())),
    modelsHubSetEnabled: vi.fn(async (payload) => ok(payload)),
    modelsHubSetEffort: vi.fn(async (payload) => ok(payload)),
    modelsHubSetOrder: vi.fn(async (payload) => ok(payload)),
    modelsRulesGet: vi.fn(async () => ok(rules())),
    modelsRulesSet: rulesSet,
    modelsRulesReset: vi.fn(async () => ok({ effective: effective(), changed: false })),
    modelsConfigRepublish: vi.fn(async () => ok({ exportOk: true })),
  }
  render(<Page />)
  await act(async () => {})
  fireEvent.click(screen.getAllByRole('tab').find((el) => el.textContent.trim() === '审核规则'))
  await act(async () => {})
}
const button = (id) => document.querySelector(`[data-gate="${id}"] .mh-gate-r`)
const defaultsLine = () => document.querySelector('[data-rules="defaults"]').textContent
function pick(id, name) {
  fireEvent.click(button(id))
  fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitemradio', { name }))
}

beforeEach(() => vi.clearAllMocks())
afterEach(() => {
  cleanup()
  delete window.electronAPI
})

it('TC-012 点选对账复核 4 轮：保存中先显示新值并禁用，保存成功保持新值、默认值一行写恢复成建议值，高级三项不变', async () => {
  let finish
  await show(vi.fn(() => new Promise((resolve) => (finish = resolve))))
  pick(RECONCILE, '每个 4 轮')
  await act(async () => {})
  expect(button(RECONCILE).textContent).toContain('每个 4 轮')
  expect(button(RECONCILE)).toBeDisabled()
  expect(defaultsLine()).toContain('恢复成这个版本配好的建议值')
  await act(async () => finish(ok({ key: `designGates.${RECONCILE}.rounds`, value: 4, changed: true })))
  expect(button(RECONCILE).textContent).toContain('每个 4 轮')
  expect(button(RECONCILE)).not.toBeDisabled()
  expect(button(BOUNDARY).textContent).toContain('每个 2 轮')
  fireEvent.click(screen.getByRole('button', { name: /高级/ }))
  expect(document.querySelector('[data-adv="timeoutMinutes"]').textContent).toContain('20 分钟')
  expect(document.querySelector('[data-adv="failoverMax"]').textContent).toContain('3 次')
  expect(document.querySelector('[data-adv="autoExtendRounds"]').textContent).toContain('1 轮')
})

it('TC-012 点选边界审查 5 轮保存失败：退回 2 轮并红色提示，默认值一行回到原样', async () => {
  await show(vi.fn(async () => DENIED))
  pick(BOUNDARY, '每个 5 轮')
  await act(async () => {})
  expect(button(BOUNDARY).textContent).toContain('每个 2 轮')
  expect(button(BOUNDARY)).not.toBeDisabled()
  expect(toast.error).toHaveBeenCalled()
  expect(defaultsLine()).toContain('现在用的就是这个版本的建议值')
})
