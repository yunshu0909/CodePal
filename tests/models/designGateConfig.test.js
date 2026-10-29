/** @vitest-environment node
 * v2.1.28 TC-002、TC-003（D149、#87 同版）：两道设计审查的轮数存进规则、写进给 dev 读的审核配置
 *
 * - TC-002：逐个保存后重读一致；审核配置 gates 里 formal.design-boundary / formal.design-reconcile 只带 rounds，
 *   dev 0.12.44 起按它派边界审查、对账复核（更早的 dev 忽略不认识的门）；没改时写建议值 2 / 3；恢复默认回到建议值
 * - TC-003：审核规则文件坏了时沿用上一份有效审核配置——升级前写的（只有 6 道关）照样算有效，缺的两项用建议值补；
 *   本版写的（8 项）也认；两项轮数写错的整份不认、按建议值（和其他关卡写错一样）
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { makeSandbox, KEY } from './helpers'

const require = createRequire(import.meta.url)
const { createReviewCenter } = await import('../../electron/modules/models/reviewCenter.js')
const defaults = await import('../../electron/modules/models/reviewDefaults.js')
const store = require('../../electron/modules/models/store.js')

const BOUNDARY = 'formal.design-boundary'
const RECONCILE = 'formal.design-reconcile'
const SUGGESTED = { [BOUNDARY]: { rounds: 2 }, [RECONCILE]: { rounds: 3 } }
let sb, center

const file = (name) => path.join(sb.models, name)
const read = (name) => JSON.parse(fs.readFileSync(file(name), 'utf8'))
const options = () => ({ homeDir: sb.home, env: sb.env, locateClaude: () => null, locateCodex: () => null })
/** 模拟 CodePal 启动：建好后先做一次启动对账 */
function open() {
  center?.stop()
  center = createReviewCenter(options())
  center.reconcile()
  return center
}
/** 让审核配置重新生成一次（改一下模型开关再改回来） */
function regenerate(c) {
  c.setEnabled({ id: 'deepseek:deepseek-flash', enabled: false })
  c.setEnabled({ id: 'deepseek:deepseek-flash', enabled: true })
}
/** 只取 6 道关（升级前的审核配置就只有这些） */
const sixGates = (gates) => Object.fromEntries(defaults.GATE_IDS.map((id) => [id, gates[id]]))

beforeEach(() => {
  sb = makeSandbox()
  for (const [k, v] of Object.entries(sb.env)) vi.stubEnv(k, v)
  store.setKey('deepseek', KEY)
  store.writeStatus('deepseek', 'deepseek-flash', { ok: true, source: 'test' })
  center = null
})
afterEach(() => {
  center?.stop()
  vi.unstubAllEnvs()
  sb.cleanup()
})

it('TC-002 两道设计审查的轮数：保存后重读一致，审核配置只写轮数，没改时写建议值，恢复默认回到建议值', () => {
  const c = open()
  c.list()
  expect(read('review-config.json').gates[BOUNDARY]).toEqual({ rounds: 2 })
  expect(read('review-config.json').gates[RECONCILE]).toEqual({ rounds: 3 })
  expect(c.rulesGet().effective.designGates).toEqual(SUGGESTED)

  expect(c.rulesSet({ key: `designGates.${BOUNDARY}.rounds`, value: 4 })).toMatchObject({ value: 4, changed: true })
  c.rulesSet({ key: `designGates.${RECONCILE}.rounds`, value: 5 })
  const reopened = open()
  expect(reopened.rulesGet().effective.designGates).toEqual({ [BOUNDARY]: { rounds: 4 }, [RECONCILE]: { rounds: 5 } })
  const config = read('review-config.json')
  expect(config.gates[BOUNDARY]).toEqual({ rounds: 4 })
  expect(config.gates[RECONCILE]).toEqual({ rounds: 5 })
  // 6 道关照旧带个数和轮数
  expect(sixGates(config.gates)).toEqual(defaults.DEFAULTS.gates)
  expect(read('review-rules.json').overrides).toEqual({
    [`designGates.${BOUNDARY}.rounds`]: 4,
    [`designGates.${RECONCILE}.rounds`]: 5,
  })
  // 超出范围不写文件
  expect(() => reopened.rulesSet({ key: `designGates.${BOUNDARY}.rounds`, value: 6 })).toThrow()
  expect(() => reopened.rulesSet({ key: `designGates.${BOUNDARY}.reviewers`, value: 2 })).toThrow()

  expect(reopened.rulesReset().effective.designGates).toEqual(SUGGESTED)
  expect(read('review-config.json').gates[BOUNDARY]).toEqual({ rounds: 2 })
  expect(read('review-config.json').gates[RECONCILE]).toEqual({ rounds: 3 })
  expect(reopened.rulesGet().changed).toBe(false)
})

it('TC-003 规则文件坏了：升级前只有 6 道关的上一份配置照样沿用，缺的两项补建议值；本版 8 项也认；两项写错的不认', () => {
  const c = open()
  c.list()
  expect(c.rulesGet().effective.designGates, '规则里有两道设计审查').toEqual(SUGGESTED)
  c.rulesSet({ key: 'gates.lite.G1.reviewers', value: 3 })
  c.rulesSet({ key: `designGates.${RECONCILE}.rounds`, value: 5 })
  fs.writeFileSync(file('review-rules.json'), '{broken')

  // 本版写的上一份（8 项）：整份沿用
  regenerate(c)
  expect(read('review-config.json').gates['lite.G1'].reviewers).toBe(3)
  expect(read('review-config.json').gates[RECONCILE]).toEqual({ rounds: 5 })

  // 升级前写的上一份（只有 6 道关）：6 道关沿用，两项按建议值补上
  const old = read('review-config.json')
  delete old.gates[BOUNDARY]
  delete old.gates[RECONCILE]
  fs.writeFileSync(file('review-config.json'), JSON.stringify(old))
  regenerate(c)
  const upgraded = read('review-config.json')
  expect(upgraded.gates['lite.G1'].reviewers).toBe(3)
  expect(upgraded.gates[BOUNDARY]).toEqual({ rounds: 2 })
  expect(upgraded.gates[RECONCILE]).toEqual({ rounds: 3 })

  // 两项轮数写错：整份不认，规则部分按建议值
  const wrong = read('review-config.json')
  wrong.gates[RECONCILE] = { rounds: 9 }
  fs.writeFileSync(file('review-config.json'), JSON.stringify(wrong))
  regenerate(c)
  const fallback = read('review-config.json')
  expect(fallback.gates['lite.G1'].reviewers).toBe(defaults.DEFAULTS.gates['lite.G1'].reviewers)
  expect(fallback.gates[RECONCILE]).toEqual({ rounds: 3 })
})
