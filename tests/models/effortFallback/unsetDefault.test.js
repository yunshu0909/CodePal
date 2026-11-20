/** @vitest-environment node
 * #79（父 #72）：从没设过审核等级的订阅模型，不支持 high 时和「存过的档位失效」走同一套退法——
 * 支持 high 就用 high；不支持就用它自己的默认档；默认档也没有（或不在支持列表里）就用列表第一个。
 * 用户 2026-11-20 选 B，替换 v2.1.12 定稿「未设强度仍按定稿字面 high」。
 * 没存过东西，所以不带「原来的 xx 不再支持」提示；退下来的档只读推算，不写进本页设置。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { makeSandbox, FAKE } from '../helpers'

const { createReviewCenter } = await import('../../../electron/modules/models/reviewCenter.js')

let sb, codexBin, center

const file = (name) => path.join(sb.models, name)
const read = (name) => JSON.parse(fs.readFileSync(file(name), 'utf8'))
const model = (data, id) => data.vendors.flatMap((v) => v.models).find((m) => m.id === id)
function home(relative, value) {
  const target = path.join(sb.home, relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value))
}
const codexModel = (slug, efforts, defaultLevel) => ({
  slug,
  display_name: slug.toUpperCase(),
  visibility: 'list',
  supported_reasoning_levels: efforts.map((effort) => ({ effort })),
  ...(defaultLevel ? { default_reasoning_level: defaultLevel } : {}),
})

beforeEach(() => {
  sb = makeSandbox()
  for (const [k, v] of Object.entries(sb.env)) vi.stubEnv(k, v)
  fs.mkdirSync(sb.bin, { recursive: true })
  codexBin = path.join(sb.bin, 'codex')
  fs.writeFileSync(codexBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  center = null
})
afterEach(() => {
  center?.stop()
  vi.unstubAllEnvs()
  sb.cleanup()
})

it('#79 没设过等级：支持 high 的照旧 high；不支持的退到自己的默认档或列表第一个，页面与审核配置一致且不提示', () => {
  home('.claude.json', { oauthAccount: { token: 'token_redacted' } })
  home('.claude/settings.json', { model: 'claude-opus-5-5' })
  home('.codex/auth.json', 'auth_value_must_never_be_read')
  home('.codex/config.toml', 'model = "gpt-high"\n')
  home('.codex/models_cache.json', {
    models: [
      codexModel('gpt-high', ['low', 'high', 'ultra'], 'low'),
      codexModel('gpt-odd', ['low', 'ultra'], 'ultra'),
      codexModel('gpt-nodef', ['minimal', 'ultra'], 'high'),
      codexModel('gpt-bare', ['minimal', 'ultra']),
    ],
  })
  const ids = ['claude:opus', 'codex:gpt-high', 'codex:gpt-odd', 'codex:gpt-nodef', 'codex:gpt-bare']
  fs.mkdirSync(sb.models, { recursive: true })
  fs.writeFileSync(
    file('hub.json'),
    JSON.stringify({
      schemaVersion: 1,
      initializedAt: new Date().toISOString(),
      reviewEnabled: Object.fromEntries(ids.map((id) => [id, true])),
      effort: {},
      order: ids,
    }),
    { mode: 0o600 },
  )
  center = createReviewCenter({
    homeDir: sb.home,
    env: sb.env,
    locateClaude: () => FAKE,
    locateCodex: () => codexBin,
  })
  center.reconcile()
  const data = center.list()
  const expected = {
    'claude:opus': 'high',
    'codex:gpt-high': 'high',
    'codex:gpt-odd': 'ultra',
    'codex:gpt-nodef': 'minimal',
    'codex:gpt-bare': 'minimal',
  }
  const shown = Object.fromEntries(ids.map((id) => [id, model(data, id).effort]))
  expect(shown, 'UNSET_DEFAULT 页面上没设过等级时的档').toEqual(expected)
  for (const id of ids) {
    expect(model(data, id), `UNSET_NO_NOTE ${id} 没存过东西不该提示原值`).not.toHaveProperty('effortUnsupported')
    expect(model(data, id).efforts).toContain(model(data, id).effort)
  }
  const exported = Object.fromEntries(read('review-config.json').models.map((m) => [m.id, m.effort]))
  expect(exported, 'UNSET_DEFAULT 审核配置里的档').toEqual(expected)
  // 只读推算：本页设置里不写入等级，模型以后支持 high 了会自动回到 high
  expect(read('hub.json').effort).toEqual({})
})
