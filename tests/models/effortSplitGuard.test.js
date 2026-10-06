/** @vitest-environment node
 * v2.1.16 · 拆分接入模型强度后，Claude / Codex 的强度规则保持不变（TC-112）
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { makeSandbox, KEY, FAKE } from './helpers'

const require = createRequire(import.meta.url)
const { registerModelsHandlers } = require('../../electron/modules/models/ipc.js')
const store = require('../../electron/modules/models/store.js')
let sb, original, handlers, lifecycle, env

function write(relative, value) {
  const file = path.join(sb.home, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
}
/** 本机装了 Claude Code 与 Codex 的样子（只放测试值，不读真实凭证） */
function ready() {
  write('.claude.json', { oauthAccount: { token: 'token_redacted' } })
  write('.claude/settings.json', { model: 'claude-sonnet-5-5' })
  write('.codex/auth.json', 'auth_value_must_never_be_read')
  write('.codex/config.toml', 'model = "gpt-6-astra"\n')
  write('.codex/models_cache.json', {
    models: ['gpt-6-astra', 'gpt-6-sol'].map((slug) => ({
      slug,
      display_name: `Display ${slug}`,
      visibility: 'list',
      supported_reasoning_levels: ['low', 'high', 'ultra'].map((effort) => ({ effort })),
    })),
  })
}
async function call(ch, args) {
  const result = await handlers[ch]({}, args)
  expect(result.success).toBe(true)
  return result.data
}
const read = (name) => JSON.parse(fs.readFileSync(path.join(sb.models, name), 'utf8'))
const effortOf = (data, id) => data.vendors.flatMap((v) => v.models).find((m) => m.id === id).effort

beforeEach(() => {
  sb = makeSandbox()
  original = Object.fromEntries(Object.keys(sb.env).map((k) => [k, process.env[k]]))
  Object.assign(process.env, sb.env)
  fs.mkdirSync(sb.bin, { recursive: true })
  const codex = path.join(sb.bin, 'codex')
  fs.writeFileSync(codex, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  env = { ...process.env, CODEPAL_CLAUDE_BIN: FAKE, CODEPAL_CODEX_BIN: codex }
  handlers = {}
  lifecycle = registerModelsHandlers({
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn } },
    getMainWindow: () => null,
    loginPath: () => sb.bin,
    hubOptions: { homeDir: sb.home, env },
  })
})
afterEach(() => {
  lifecycle?.stop()
  vi.restoreAllMocks()
  for (const [k, v] of Object.entries(original)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  sb.cleanup()
})

it('TC-112 Claude、Codex 强度仍存在 hub.json 原条目、清单输出各自的值；接入模型的复制与修改不覆盖它们', async () => {
  ready()
  store.setKey('deepseek', KEY)
  store.writeStatus('deepseek', 'deepseek-flash', { ok: true, source: 'test' })
  const first = await call('models:hubList')
  expect(effortOf(first, 'claude:sonnet')).toBe('high')
  expect(effortOf(first, 'codex:gpt-6-astra')).toBe('high')
  await call('models:hubSetEnabled', { id: 'claude:sonnet', enabled: true })
  await call('models:hubSetEnabled', { id: 'codex:gpt-6-astra', enabled: true })
  await call('models:hubSetEffort', { id: 'claude:sonnet', effort: 'max' })
  await call('models:hubSetEffort', { id: 'codex:gpt-6-astra', effort: 'ultra' })
  await call('models:updateModel', { providerId: 'deepseek', modelId: 'deepseek-flash', patch: { effort: 'low' } })
  const data = await call('models:hubList')
  expect(effortOf(data, 'claude:sonnet')).toBe('max')
  expect(effortOf(data, 'codex:gpt-6-astra')).toBe('ultra')
  const prefs = read('hub.json').effort
  expect(prefs['claude:sonnet']).toBe('max')
  expect(prefs['codex:gpt-6-astra']).toBe('ultra')
  const review = read('review-config.json').models
  expect(review.find((m) => m.id === 'claude:sonnet').effort).toBe('max')
  expect(review.find((m) => m.id === 'codex:gpt-6-astra').effort).toBe('ultra')
})
