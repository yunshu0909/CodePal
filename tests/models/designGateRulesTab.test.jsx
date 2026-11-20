/** v2.1.28 TC-004（D149、#87 同版）：审核规则页签加边界审查、对账复核两行
 * #89（2026-11-20 用户在对比页选定方案三）：这两行单独成一组「复杂需求 · 设计审查」，放在完整开发组上面
 *
 * - 各只有一个「每个 N 轮」按钮（1～5，点了就保存）；「派几个」那格不放东西
 * - 组下面一行说明个数谁定（用户认过的原文）
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

async function show(rulesData = rules()) {
  const api = {
    modelsHubList: vi.fn(async () => ok(hub())),
    modelsHubSetEnabled: vi.fn(async (payload) => ok(payload)),
    modelsHubSetEffort: vi.fn(async (payload) => ok(payload)),
    modelsHubSetOrder: vi.fn(async (payload) => ok(payload)),
    modelsRulesGet: vi.fn(async () => ok(rulesData)),
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

const DESIGN_LABEL = '复杂需求 · 设计审查'
const DESIGN_NOTE = '这两道派几个由 dev 定：边界审查和需求对齐派一样多，对账复核找原审核者'
const glabel = (name) => [...document.querySelectorAll('.np-glabel')].find((el) => el.textContent === name)
const cardIds = (label) => [...glabel(label).nextElementSibling.querySelectorAll('[data-gate]')].map((el) => el.getAttribute('data-gate'))

it('TC-004 #89 边界审查、对账复核单独成一组「复杂需求 · 设计审查」，在完整开发组上面', async () => {
  await show()
  expect([...document.querySelectorAll('.np-glabel')].map((el) => el.textContent)).toEqual([
    '派审核',
    '简单需求 · 快速开发',
    DESIGN_LABEL,
    '复杂需求 · 完整开发',
    '其他',
  ])
  expect(cardIds(DESIGN_LABEL)).toEqual([BOUNDARY, RECONCILE])
  expect(cardIds('复杂需求 · 完整开发')).toEqual(['formal.G1', 'formal.G2b', 'formal.G3', 'formal.G4'])
})

it('TC-004 #89 设计审查组下面紧跟一行说明，写清个数谁定', async () => {
  await show()
  const note = glabel(DESIGN_LABEL).nextElementSibling.nextElementSibling
  expect(note.classList.contains('mh-foot')).toBe(true)
  expect(note.textContent).toBe(DESIGN_NOTE)
  expect(document.body.textContent.split(DESIGN_NOTE)).toHaveLength(2)
})

it('TC-004 #89 主进程没给出两道设计审查时整组不出，不留空组名和说明', async () => {
  const data = rules()
  delete data.effective.designGates
  await show(data)
  expect(gate('lite.G1')).not.toBeNull()
  expect(glabel(DESIGN_LABEL)).toBeUndefined()
  expect(document.body.textContent).not.toContain(DESIGN_NOTE)
  expect(cardIds('复杂需求 · 完整开发')).toEqual(['formal.G1', 'formal.G2b', 'formal.G3', 'formal.G4'])
})

it('TC-004 两行只有轮数按钮，派几个那格不放东西；选 4 轮按这一项保存', async () => {
  const api = await show()
  for (const [id, name, sub, rounds] of [
    [BOUNDARY, '边界审查', '后端规则有没有漏掉的边界', '每个 2 轮'],
    [RECONCILE, '对账复核', '改完的规则和审核意见对不对得上', '每个 3 轮'],
  ]) {
    expect(gate(id).textContent).toContain(name)
    expect(gate(id).textContent).toContain(sub)
    expect(gate(id).textContent).not.toMatch(/同需求对齐|原审核者/)
    expect(gate(id).querySelector('.mh-gate-n')).toBeNull()
    expect(gate(id).querySelectorAll('button')).toHaveLength(1)
    expect(gate(id).querySelector('.mh-gate-acts').children).toHaveLength(1)
    expect(gate(id).querySelector('.mh-gate-r').textContent).toContain(rounds)
  }
  expect(document.querySelector('.mh-gate-fixed')).toBeNull()

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
