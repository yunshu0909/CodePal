/** v2.1.28 TC-004（D149、#87 同版）：审核规则页签「复杂需求 · 完整开发」组最上面加边界审查、对账复核两行
 *
 * - 各只有一个「每个 N 轮」按钮（1～5，点了就保存）；派几个的位置写「同需求对齐」「原审核者」，不是按钮
 * - 保存的键是 designGates.<门>.rounds，成功提示已保存
 * - 能来审的模型数橙字只看「派几个模型」，不受这两行影响
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
const { capacityWarning } = await import('../../src/features/modelHub/reviewCapacity.js')

const BOUNDARY = 'formal.design-boundary'
const RECONCILE = 'formal.design-reconcile'
const mk = (vendor, slug, enabled) => ({ id: `${vendor}:${slug}`, displayName: slug, enabled, efforts: ['high'], effort: 'high' })
function hub() {
  return {
    providerConfigError: false,
    order: ['claude:opus', 'codex:gpt-6-sol'],
    vendors: [
      { id: 'claude', name: 'Claude Code', color: 'var(--tool-claude)', blocked: null, models: [mk('claude', 'opus', true)] },
      { id: 'codex', name: 'Codex', color: 'var(--tool-codex)', blocked: null, models: [mk('codex', 'gpt-6-sol', true)] },
    ],
  }
}
const GATES = {
  'lite.G0': { reviewers: 1, rounds: 3 },
  'lite.G1': { reviewers: 2, rounds: 3 },
  'formal.G1': { reviewers: 1, rounds: 3 },
  'formal.G2b': { reviewers: 1, rounds: 2 },
  'formal.G3': { reviewers: 1, rounds: 3 },
  'formal.G4': { reviewers: 2, rounds: 3 },
}
function rules() {
  return {
    effective: {
      selfReview: false,
      gates: structuredClone(GATES),
      designGates: { [BOUNDARY]: { rounds: 2 }, [RECONCILE]: { rounds: 3 } },
      advanced: { timeoutMinutes: 20, failoverMax: 3, autoExtendRounds: 1 },
    },
    changed: false,
    defaultsVersion: '2026.10.2',
    exportOk: true,
  }
}
const ok = (data) => ({ success: true, data, error: null })

async function show() {
  const api = {
    modelsHubList: vi.fn(async () => ok(hub())),
    modelsHubSetEnabled: vi.fn(async (payload) => ok(payload)),
    modelsHubSetEffort: vi.fn(async (payload) => ok(payload)),
    modelsHubSetOrder: vi.fn(async (payload) => ok(payload)),
    modelsRulesGet: vi.fn(async () => ok(rules())),
    modelsRulesSet: vi.fn(async ({ key, value }) => ok({ key, value, changed: true })),
    modelsRulesReset: vi.fn(async () => ok({ effective: rules().effective, changed: false })),
    modelsConfigRepublish: vi.fn(async () => ok({ exportOk: true })),
  }
  window.electronAPI = api
  render(<Page />)
  await act(async () => {})
  fireEvent.click(screen.getAllByRole('tab').find((el) => el.textContent.trim() === '审核规则'))
  await act(async () => {})
  return api
}
const gate = (id) => document.querySelector(`[data-gate="${id}"]`)

beforeEach(() => vi.clearAllMocks())
afterEach(() => {
  cleanup()
  delete window.electronAPI
})

it('TC-004 完整开发组最上面是边界审查、对账复核两行，只有轮数按钮，派几个写固定说法；选 4 轮按这一项保存', async () => {
  const api = await show()
  const formal = [...document.querySelectorAll('.np-glabel')].find((el) => el.textContent === '复杂需求 · 完整开发')
  const card = formal.nextElementSibling
  const order = [...card.querySelectorAll('[data-gate]')].map((el) => el.getAttribute('data-gate'))
  expect(order).toEqual([BOUNDARY, RECONCILE, 'formal.G1', 'formal.G2b', 'formal.G3', 'formal.G4'])

  for (const [id, name, fixed, rounds] of [
    [BOUNDARY, '边界审查', '同需求对齐', '每个 2 轮'],
    [RECONCILE, '对账复核', '原审核者', '每个 3 轮'],
  ]) {
    expect(gate(id).textContent).toContain(name)
    expect(gate(id).textContent).toContain(fixed)
    expect(gate(id).querySelector('.mh-gate-n')).toBeNull()
    expect(gate(id).querySelectorAll('button')).toHaveLength(1)
    expect(gate(id).querySelector('.mh-gate-r').textContent).toContain(rounds)
  }

  fireEvent.click(gate(RECONCILE).querySelector('.mh-gate-r'))
  const menu = screen.getByRole('menu')
  expect(within(menu).getAllByRole('menuitemradio').map((el) => el.textContent.trim().replace('✓', ''))).toEqual(
    ['每个 1 轮', '每个 2 轮', '每个 3 轮', '每个 4 轮', '每个 5 轮'],
  )
  fireEvent.click(within(menu).getByRole('menuitemradio', { name: '每个 4 轮' }))
  await act(async () => {})
  expect(api.modelsRulesSet).toHaveBeenCalledWith({ key: `designGates.${RECONCILE}.rounds`, value: 4 })
  expect(toast.success).toHaveBeenCalledWith('已保存')
})

it('TC-004 能来审的模型数橙字只看派几个模型，两道设计审查不参与', () => {
  const models = [{ id: 'claude:opus', vendor: 'claude' }, { id: 'codex:gpt-6-sol', vendor: 'codex' }]
  const design = { [BOUNDARY]: { rounds: 5 }, [RECONCILE]: { rounds: 5 } }
  // 每道关都只派 1 个：两种情况各有 1 个能来审，够用
  const one = Object.fromEntries(Object.keys(GATES).map((id) => [id, { reviewers: 1, rounds: 3 }]))
  expect(capacityWarning(models, false, one)).toBeNull()
  expect(capacityWarning(models, false, { ...one, ...design })).toBeNull()
  expect(capacityWarning(models, false, { ...GATES, ...design })).toBe(capacityWarning(models, false, GATES))
})
