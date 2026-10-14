/** @vitest-environment node
 * v2.1.24 TC-001（#72）：审核用的等级存过、后来模型不再支持这一档时，退回模型自己支持的档——
 * 支持 high 就用 high；不支持就用它自己的默认档；默认档也不在支持列表里就用列表第一个。
 * 页面显示的等级与写进审核配置的等级相同，原值仍以 effortUnsupported 提示。
 * 没设过等级的初始值（v2.1.12 定稿字面 high）不在本条范围，由 hubSubscriptions 的 SC-022 守着。
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

it('TC-001 存过的等级不再支持：退回模型支持的档（high → 自己的默认档 → 列表第一个），页面与审核配置一致并提示原值', () => {
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
      effort: Object.fromEntries(ids.map((id) => [id, 'max-old'])),
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
  expect(shown, 'FALLBACK_UNSUPPORTED 页面退回的档').toEqual(expected)
  for (const id of ids) {
    expect(model(data, id).effortUnsupported).toBe('max-old')
    expect(model(data, id).efforts).toContain(model(data, id).effort)
  }
  const exported = Object.fromEntries(read('review-config.json').models.map((m) => [m.id, m.effort]))
  expect(exported, 'FALLBACK_UNSUPPORTED 审核配置里的档').toEqual(expected)
  // 只读：退回只影响显示和审核配置，本页设置里存的原值不改
  expect(read('hub.json').effort['codex:gpt-odd']).toBe('max-old')
})
