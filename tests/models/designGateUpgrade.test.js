/** @vitest-environment node
 * v2.1.28 TC-014（开工前检查第 4 轮）：从 2.1.27 升级，原来改过的审核规则照样保留
 *
 * 2.1.27 写的规则文件只有 6 道关、自审、高级三项的改过项。升级后：原来改过的照旧生效，两道设计审查用建议值；
 * 再改两道设计审查的轮数、重开 CodePal，原来改过的和新改的都在，给 dev 的审核配置两边都写对。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { makeSandbox, KEY } from './helpers'

const require = createRequire(import.meta.url)
const { createReviewCenter } = await import('../../electron/modules/models/reviewCenter.js')
const store = require('../../electron/modules/models/store.js')

const BOUNDARY = 'formal.design-boundary'
const RECONCILE = 'formal.design-reconcile'
// 2.1.27 留下的规则文件：只存改过的项
const OLD_OVERRIDES = {
  selfReview: true,
  'gates.lite.G1.reviewers': 3,
  'gates.formal.G4.rounds': 5,
  'advanced.timeoutMinutes': 30,
}
let sb, center

const file = (name) => path.join(sb.models, name)
const read = (name) => JSON.parse(fs.readFileSync(file(name), 'utf8'))
function open() {
  center?.stop()
  center = createReviewCenter({ homeDir: sb.home, env: sb.env, locateClaude: () => null, locateCodex: () => null })
  center.reconcile()
  return center
}

beforeEach(() => {
  sb = makeSandbox()
  for (const [k, v] of Object.entries(sb.env)) vi.stubEnv(k, v)
  store.setKey('deepseek', KEY)
  store.writeStatus('deepseek', 'deepseek-flash', { ok: true, source: 'test' })
  fs.mkdirSync(sb.models, { recursive: true })
  fs.writeFileSync(
    file('review-rules.json'),
    JSON.stringify({ schemaVersion: 1, overrides: OLD_OVERRIDES, updatedAt: '2026-10-20T00:00:00.000Z' }),
    { mode: 0o600 },
  )
  center = null
})
afterEach(() => {
  center?.stop()
  vi.unstubAllEnvs()
  sb.cleanup()
})

it('TC-014 升级后原来改过的规则照旧；再改两道设计审查、重开，原来的和新改的都在，审核配置两边都写对', () => {
  const c = open()
  c.list()
  const upgraded = c.rulesGet()
  expect(upgraded.effective.designGates).toEqual({ [BOUNDARY]: { rounds: 2 }, [RECONCILE]: { rounds: 3 } })
  expect(upgraded.effective.selfReview).toBe(true)
  expect(upgraded.effective.gates['lite.G1'].reviewers).toBe(3)
  expect(upgraded.effective.gates['formal.G4'].rounds).toBe(5)
  expect(upgraded.effective.advanced.timeoutMinutes).toBe(30)
  expect(upgraded.changed).toBe(true)

  c.rulesSet({ key: `designGates.${BOUNDARY}.rounds`, value: 4 })
  const reopened = open()
  const after = reopened.rulesGet().effective
  expect(after.designGates[BOUNDARY]).toEqual({ rounds: 4 })
  expect(after.gates['lite.G1'].reviewers).toBe(3)
  expect(after.gates['formal.G4'].rounds).toBe(5)
  expect(after.advanced.timeoutMinutes).toBe(30)
  expect(read('review-rules.json').overrides).toEqual({ ...OLD_OVERRIDES, [`designGates.${BOUNDARY}.rounds`]: 4 })
  const config = read('review-config.json')
  expect(config.selfReview).toBe(true)
  expect(config.gates['lite.G1'].reviewers).toBe(3)
  expect(config.gates['formal.G4'].rounds).toBe(5)
  expect(config.gates[BOUNDARY]).toEqual({ rounds: 4 })
  expect(config.gates[RECONCILE]).toEqual({ rounds: 3 })
  expect(config.advanced.timeoutMinutes).toBe(30)
})
