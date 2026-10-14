/** @vitest-environment node
 * v2.1.24 TC-003（#72）：读已有审核配置时，模型记录少了 family / displayName，或接入模型（runner=codepal）
 * 少了 provider，都算坏了（state=invalid），之后由重新生成按设置修好；CodePal 自己写出的配置照常算有效。
 */
import { afterEach, beforeEach, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { buildReviewConfig, readReviewConfig, CONFIG_FILE } = require('../../../electron/modules/models/reviewModels.js')
const defaults = require('../../../electron/modules/models/reviewDefaults.js')

let root
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codepal-review-config-')))
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

const write = (config) => fs.writeFileSync(path.join(root, CONFIG_FILE), JSON.stringify(config))
function good() {
  const models = [
    { vendorId: 'claude', model: { id: 'claude:opus', slug: 'opus', displayName: 'Opus 5.5', efforts: ['high'], effort: 'high' } },
    { vendorId: 'codex', model: { id: 'codex:gpt-6-sol', slug: 'gpt-6-sol', displayName: 'GPT-6-SOL', efforts: ['low'], effort: 'low' } },
    { vendorId: 'deepseek', model: { id: 'deepseek:deepseek-flash', slug: 'deepseek-flash', displayName: 'deepseek-flash', efforts: [], effort: null } },
  ]
  return buildReviewConfig(models, defaults.effectiveRules({}, defaults.DEFAULTS))
}

it('TC-003 模型记录缺 family / displayName / 接入模型缺 provider 都算坏了；CodePal 写出的配置有效', () => {
  write(good())
  expect(readReviewConfig(root).state).toBe('valid')
  const broken = {
    '订阅模型缺 family': (cfg) => delete cfg.models[0].family,
    '订阅模型 family 为空': (cfg) => (cfg.models[1].family = ''),
    '缺 displayName': (cfg) => delete cfg.models[1].displayName,
    'displayName 不是文字': (cfg) => (cfg.models[0].displayName = 7),
    '接入模型缺 provider': (cfg) => delete cfg.models[2].provider,
    '接入模型 provider 不是文字': (cfg) => (cfg.models[2].provider = null),
    '订阅模型带 provider': (cfg) => (cfg.models[0].provider = 'claude'),
  }
  const accepted = []
  for (const [name, mutate] of Object.entries(broken)) {
    const cfg = good()
    mutate(cfg)
    write(cfg)
    if (readReviewConfig(root).state !== 'invalid') accepted.push(name)
  }
  expect(accepted, 'CONFIG_FIELD_UNCHECKED 这些坏记录被当成有效').toEqual([])
})
