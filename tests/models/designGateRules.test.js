/** @vitest-environment node
 * v2.1.28 TC-001（#87 同版，D149）：边界审查、对账复核两道设计审查的默认值与规则键
 *
 * - 建议值：边界审查每个 2 轮、对账复核每个 3 轮（和 dev 0.12.44 没写时的默认一致）
 * - 两项只有轮数键（1～5），派几个由 dev 定（边界审查同需求对齐、对账复核找原审核者），没有个数键
 * - 改成别的值记成改过项、改回建议值就去掉；超出范围、非整数一律拒绝
 * - 默认值多了两项，默认值版本号跟着换
 */
import { expect, it } from 'vitest'

const defaults = await import('../../electron/modules/models/reviewDefaults.js')
const BOUNDARY = 'formal.design-boundary'
const RECONCILE = 'formal.design-reconcile'

it('TC-001 建议值里有两道设计审查的轮数，规则键只有轮数、范围 1～5，改回建议值就去掉', () => {
  expect(defaults.DESIGN_GATE_IDS).toEqual([BOUNDARY, RECONCILE])
  expect(defaults.DEFAULTS.designGates).toEqual({ [BOUNDARY]: { rounds: 2 }, [RECONCILE]: { rounds: 3 } })
  expect(defaults.DEFAULTS_VERSION).not.toBe('2026.10.1')
  for (const gate of [BOUNDARY, RECONCILE]) {
    expect(defaults.RULE_KEYS).toContain(`designGates.${gate}.rounds`)
    expect(defaults.RULE_KEYS).not.toContain(`designGates.${gate}.reviewers`)
    expect(defaults.RULE_KEYS).not.toContain(`gates.${gate}.reviewers`)
    expect(defaults.allowedValues(`designGates.${gate}.rounds`)).toEqual([1, 2, 3, 4, 5])
    for (const bad of [0, 6, 2.5, '2', null]) expect(defaults.isValidRule(`designGates.${gate}.rounds`, bad)).toBe(false)
  }

  const changed = defaults.applyOverride({}, `designGates.${RECONCILE}.rounds`, 5)
  expect(changed).toEqual({ [`designGates.${RECONCILE}.rounds`]: 5 })
  const effective = defaults.effectiveRules(changed)
  expect(effective.designGates).toEqual({ [BOUNDARY]: { rounds: 2 }, [RECONCILE]: { rounds: 5 } })
  // 六道关、自审、高级三项不受影响
  expect(effective.gates).toEqual(defaults.DEFAULTS.gates)
  expect(defaults.isValidRules(effective)).toBe(true)
  // 改回建议值：去掉这一项
  expect(defaults.applyOverride(changed, `designGates.${RECONCILE}.rounds`, 3)).toEqual({})
  expect(() => defaults.applyOverride({}, `designGates.${BOUNDARY}.rounds`, 9)).toThrow()
  // 正本不能被调用方改坏
  effective.designGates[BOUNDARY].rounds = 4
  expect(defaults.DEFAULTS.designGates[BOUNDARY].rounds).toBe(2)
})
