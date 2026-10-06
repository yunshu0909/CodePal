/** @vitest-environment node
 * v2.1.17 · 审核规则默认值正本、改过项与升级跟随（后-03、后-13、后-16、后-19、后-50）
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { makeSandbox, KEY } from './helpers'

const require = createRequire(import.meta.url)
// 新模块用 import() 载入：写实现前先失败于 Failed to resolve import
const defaults = await import('../../electron/modules/models/reviewDefaults.js')
const { createReviewCenter } = await import('../../electron/modules/models/reviewCenter.js')
const store = require('../../electron/modules/models/store.js')

let sb
beforeEach(() => {
  sb = makeSandbox()
  for (const [k, v] of Object.entries(sb.env)) vi.stubEnv(k, v)
  store.setKey('deepseek', KEY)
  store.writeStatus('deepseek', 'deepseek-flash', { ok: true, source: 'test' })
})
afterEach(() => {
  vi.unstubAllEnvs()
  sb.cleanup()
})

const readJson = (name) => JSON.parse(fs.readFileSync(path.join(sb.models, name), 'utf8'))
/** 模拟 CodePal 启动：建好后先做一次启动对账 */
const center = (extra = {}) => {
  const c = createReviewCenter({ homeDir: sb.home, env: sb.env, locateClaude: () => null, locateCodex: () => null, ...extra })
  c.reconcile()
  return c
}

const V1 = {
  selfReview: false,
  gates: {
    'lite.G0': { reviewers: 1, rounds: 3 },
    'lite.G1': { reviewers: 2, rounds: 3 },
    'formal.G1': { reviewers: 1, rounds: 3 },
    'formal.G2b': { reviewers: 1, rounds: 2 },
    'formal.G3': { reviewers: 1, rounds: 3 },
    'formal.G4': { reviewers: 2, rounds: 3 },
  },
  advanced: { timeoutMinutes: 20, failoverMax: 3, autoExtendRounds: 1 },
}

it('SC-007 本版默认值正本：带版本、6 道关、自审关、高级三项；生效值在没有改过项时等于默认值', () => {
  expect(defaults.DEFAULTS).toEqual(V1)
  expect(typeof defaults.DEFAULTS_VERSION).toBe('string')
  expect(defaults.DEFAULTS_VERSION.length).toBeGreaterThan(0)
  expect(defaults.GATE_IDS).toEqual(['lite.G0', 'lite.G1', 'formal.G1', 'formal.G2b', 'formal.G3', 'formal.G4'])
  expect(defaults.effectiveRules({})).toEqual(V1)
  // 正本不能被调用方改坏
  expect(Object.isFrozen(defaults.DEFAULTS)).toBe(true)
  const copy = defaults.effectiveRules({})
  copy.gates['lite.G0'].reviewers = 3
  expect(defaults.DEFAULTS.gates['lite.G0'].reviewers).toBe(1)
})

it('SC-025 规则键白名单与取值范围：个数 1–3、轮数 1–5、自审布尔、高级三项各自档位；其余一律拒绝', () => {
  const keys = defaults.RULE_KEYS
  expect(keys).toContain('selfReview')
  for (const gate of defaults.GATE_IDS) {
    expect(keys).toContain(`gates.${gate}.reviewers`)
    expect(keys).toContain(`gates.${gate}.rounds`)
    expect(defaults.allowedValues(`gates.${gate}.reviewers`)).toEqual([1, 2, 3])
    expect(defaults.allowedValues(`gates.${gate}.rounds`)).toEqual([1, 2, 3, 4, 5])
  }
  expect(defaults.allowedValues('advanced.timeoutMinutes')).toEqual([5, 10, 15, 20, 30, 45, 60])
  expect(defaults.allowedValues('advanced.failoverMax')).toEqual([0, 1, 2, 3, 4, 5])
  expect(defaults.allowedValues('advanced.autoExtendRounds')).toEqual([0, 1, 2, 3])
  expect(defaults.allowedValues('selfReview')).toEqual([false, true])
  expect(keys.length).toBe(6 * 2 + 1 + 3)
  for (const [key, value] of [
    ['gates.lite.G1.reviewers', 4],
    ['gates.lite.G1.reviewers', 0],
    ['gates.lite.G1.reviewers', 2.5],
    ['gates.lite.G1.reviewers', '2'],
    ['gates.formal.G3.rounds', 6],
    ['advanced.timeoutMinutes', 7],
    ['advanced.failoverMax', 6],
    ['advanced.autoExtendRounds', 4],
    ['selfReview', 'true'],
    ['gates.lite.G9.reviewers', 1],
    ['__proto__', 1],
    ['advanced', { timeoutMinutes: 30 }],
  ]) {
    let error
    try {
      defaults.applyOverride({}, key, value)
    } catch (caught) {
      error = caught
    }
    expect(error, `${key}=${JSON.stringify(value)}`).toBeDefined()
    expect(error.code).toBe('invalid_input')
  }
  expect(defaults.applyOverride({}, 'gates.formal.G3.rounds', 2)).toEqual({ 'gates.formal.G3.rounds': 2 })
})

it('SC-038 改过的判定：亲手改回建议值就去掉；生效值 = 当前版本默认值 + 改过项', () => {
  const once = defaults.applyOverride({}, 'gates.lite.G1.reviewers', 3)
  expect(once).toEqual({ 'gates.lite.G1.reviewers': 3 })
  const twice = defaults.applyOverride(once, 'advanced.timeoutMinutes', 30)
  expect(twice).toEqual({ 'gates.lite.G1.reviewers': 3, 'advanced.timeoutMinutes': 30 })
  expect(once).toEqual({ 'gates.lite.G1.reviewers': 3 })
  const back = defaults.applyOverride(twice, 'gates.lite.G1.reviewers', 2)
  expect(back).toEqual({ 'advanced.timeoutMinutes': 30 })
  const effective = defaults.effectiveRules(twice)
  expect(effective.gates['lite.G1']).toEqual({ reviewers: 3, rounds: 3 })
  expect(effective.advanced.timeoutMinutes).toBe(30)
  expect(effective.gates['formal.G4']).toEqual({ reviewers: 2, rounds: 3 })
})

it('SC-038 升级：改过的保留、没改过的跟新版本、撞值仍算改过，审核配置换成新版本重新生成', () => {
  const v1 = center({ defaults: { version: 'test-v1', values: V1 } })
  v1.list()
  v1.rulesSet({ key: 'gates.formal.G4.reviewers', value: 3 })
  v1.rulesSet({ key: 'gates.lite.G1.reviewers', value: 3 })
  expect(readJson('review-config.json').defaultsVersion).toBe('test-v1')
  v1.stop()

  const V2 = structuredClone(V1)
  V2.gates['formal.G4'].rounds = 2
  V2.advanced.timeoutMinutes = 15
  V2.gates['lite.G1'].reviewers = 3
  const v2 = center({ defaults: { version: 'test-v2', values: V2 } })
  v2.reconcile()
  const config = readJson('review-config.json')
  expect(config.defaultsVersion).toBe('test-v2')
  expect(config.gates['formal.G4']).toEqual({ reviewers: 3, rounds: 2 })
  expect(config.advanced.timeoutMinutes).toBe(15)
  expect(config.gates['lite.G1']).toEqual({ reviewers: 3, rounds: 3 })
  const rules = v2.rulesGet()
  // formal.G4 的个数仍和建议值不同：恢复默认可点
  expect(rules.changed).toBe(true)
  expect(readJson('review-rules.json').overrides).toEqual({
    'gates.formal.G4.reviewers': 3,
    'gates.lite.G1.reviewers': 3,
  })
  expect(rules.defaultsVersion).toBe('test-v2')
  v2.stop()
})

it('SC-038 全部没改过才算没改过；恢复默认后按钮变灰', () => {
  const c = center()
  c.list()
  expect(c.rulesGet().changed).toBe(false)
  c.rulesSet({ key: 'advanced.failoverMax', value: 5 })
  expect(c.rulesGet().changed).toBe(true)
  c.rulesSet({ key: 'advanced.failoverMax', value: 3 })
  expect(c.rulesGet().changed).toBe(false)
  c.stop()
})

it('SC-038 升级后建议值碰巧等于你改过的值：仍算改过（改过记录保留，以后升级不跟），但和建议值一样，恢复默认变灰（A-003）', () => {
  const v1 = center({ defaults: { version: 'test-v1', values: V1 } })
  v1.list()
  v1.rulesSet({ key: 'gates.lite.G1.reviewers', value: 3 })
  v1.stop()
  const V2 = structuredClone(V1)
  V2.gates['lite.G1'].reviewers = 3
  const v2 = center({ defaults: { version: 'test-v2', values: V2 } })
  v2.reconcile()
  expect(v2.rulesGet().changed).toBe(false)
  expect(readJson('review-rules.json').overrides).toEqual({ 'gates.lite.G1.reviewers': 3 })
  v2.stop()
  const V3 = structuredClone(V1)
  V3.gates['lite.G1'].reviewers = 1
  const v3 = center({ defaults: { version: 'test-v3', values: V3 } })
  v3.reconcile()
  // 改过记录还在：下一版建议值变了，你的 3 仍保留
  expect(readJson('review-config.json').gates['lite.G1'].reviewers).toBe(3)
  expect(v3.rulesGet().changed).toBe(true)
  v3.stop()
})
