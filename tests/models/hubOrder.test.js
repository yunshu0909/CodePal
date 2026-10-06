/** @vitest-environment node
 * v2.1.17 · 审核在用的顺序、第一次打开与模型来源事件（A-002、A-012、A-016、后-35、后-45）
 * 用真实的订阅发现（临时 HOME 里的 Claude / Codex 文件）与模型接入存储，不读真实 Key
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { makeSandbox, KEY, FAKE } from './helpers'

const require = createRequire(import.meta.url)
// 新模块用 import() 载入：写实现前先失败于 Failed to resolve import
const { createReviewCenter } = await import('../../electron/modules/models/reviewCenter.js')
const store = require('../../electron/modules/models/store.js')

let sb, state, codexBin, center
const cacheModel = (slug) => ({
  slug,
  display_name: slug.toUpperCase(),
  visibility: 'list',
  supported_reasoning_levels: ['low', 'high', 'ultra'].map((effort) => ({ effort })),
})
function write(relative, value) {
  const file = path.join(sb.home, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
}
function codexModels(slugs) {
  write('.codex/models_cache.json', { models: slugs.map(cacheModel) })
}
function machine({ claudeModel = 'claude-sonnet-5-5', codexModel = 'gpt-6-sol', slugs = ['gpt-6-astra', 'gpt-6-sol'] } = {}) {
  write('.claude.json', { oauthAccount: { token: 'token_redacted' } })
  if (claudeModel) write('.claude/settings.json', { model: claudeModel })
  write('.codex/auth.json', 'auth_value_must_never_be_read')
  write('.codex/config.toml', codexModel ? `model = "${codexModel}"\n` : '')
  codexModels(slugs)
  state.claude = true
  state.codex = true
}
function open() {
  center?.stop()
  center = createReviewCenter({
    homeDir: sb.home,
    env: sb.env,
    locateClaude: () => (state.claude ? FAKE : null),
    locateCodex: () => (state.codex ? codexBin : null),
  })
  // 模拟 CodePal 启动：先做一次启动对账（打开页面只读）
  center.reconcile()
  return center
}
const read = (name) => JSON.parse(fs.readFileSync(path.join(sb.models, name), 'utf8'))
const configIds = () => read('review-config.json').models.map((m) => m.id)
const model = (data, id) => data.vendors.flatMap((v) => v.models).find((m) => m.id === id)

beforeEach(() => {
  sb = makeSandbox()
  for (const [k, v] of Object.entries(sb.env)) vi.stubEnv(k, v)
  state = { claude: false, codex: false }
  fs.mkdirSync(sb.bin, { recursive: true })
  codexBin = path.join(sb.bin, 'codex')
  fs.writeFileSync(codexBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  center = null
})
afterEach(() => {
  center?.stop()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  sb.cleanup()
})

it('SC-001 第一次打开：开关按本机审核实际会用的、顺序 Claude Code → Codex → 模型接入、等级默认值', () => {
  machine()
  store.setKey('deepseek', KEY)
  store.writeStatus('deepseek', 'deepseek-flash', { ok: true, source: 'test' })
  store.setKey('mimo-api', KEY)
  store.writeStatus('mimo-api', 'mimo-v2.6-pro', { ok: true, source: 'test' })
  const data = open().list()
  expect(data.order).toEqual(['claude:sonnet', 'codex:gpt-6-sol', 'deepseek:deepseek-flash'])
  expect(read('hub.json').order).toEqual(['claude:sonnet', 'codex:gpt-6-sol', 'deepseek:deepseek-flash'])
  // 模型接入里测通、但审核原本没在用的不开
  expect(model(data, 'mimo-api:mimo-v2.6-pro').enabled).toBe(false)
  expect(model(data, 'claude:sonnet').effort).toBe('high')
  expect(model(data, 'codex:gpt-6-sol').effort).toBe('high')
  const access = store.readConfig().providers.deepseek.models.find((m) => m.id === 'deepseek-flash').effort
  expect(model(data, 'deepseek:deepseek-flash').effort).toBe(access)
  expect(configIds()).toEqual(['claude:sonnet', 'codex:gpt-6-sol', 'deepseek:deepseek-flash'])
})

it('SC-001 第一次打开的回退：Claude 设置没写模型用 Opus；Codex 配置的模型不在清单里用清单第一个', () => {
  machine({ claudeModel: null, codexModel: 'not-listed' })
  const data = open().list()
  expect(data.order).toEqual(['claude:opus', 'codex:gpt-6-astra'])
})

it('SC-001 从上一版升级：hub.json 没有顺序时按固定顺序排一次并写下，已有开关和等级不变', () => {
  machine()
  store.setKey('deepseek', KEY)
  store.writeStatus('deepseek', 'deepseek-flash', { ok: true, source: 'test' })
  fs.mkdirSync(sb.models, { recursive: true })
  fs.writeFileSync(
    path.join(sb.models, 'hub.json'),
    JSON.stringify({
      schemaVersion: 1,
      initializedAt: '2026-10-04T00:00:00.000Z',
      reviewEnabled: { 'deepseek:deepseek-flash': true, 'codex:gpt-6-astra': true, 'claude:opus': true },
      effort: { 'codex:gpt-6-astra': 'ultra' },
    }),
    { mode: 0o600 },
  )
  const data = open().list()
  expect(data.order).toEqual(['claude:opus', 'codex:gpt-6-astra', 'deepseek:deepseek-flash'])
  const hub = read('hub.json')
  expect(hub.order).toEqual(['claude:opus', 'codex:gpt-6-astra', 'deepseek:deepseek-flash'])
  expect(hub.initializedAt).toBe('2026-10-04T00:00:00.000Z')
  expect(model(data, 'codex:gpt-6-astra').effort).toBe('ultra')
})

it('SC-012 打开排到最后、关掉移出顺序、再打开仍排最后；审核配置跟着变', () => {
  machine()
  const c = open()
  expect(c.list().order).toEqual(['claude:sonnet', 'codex:gpt-6-sol'])
  c.setEnabled({ id: 'codex:gpt-6-astra', enabled: true })
  expect(read('hub.json').order).toEqual(['claude:sonnet', 'codex:gpt-6-sol', 'codex:gpt-6-astra'])
  expect(configIds()).toEqual(['claude:sonnet', 'codex:gpt-6-sol', 'codex:gpt-6-astra'])
  c.setEnabled({ id: 'claude:sonnet', enabled: false })
  expect(read('hub.json').order).toEqual(['codex:gpt-6-sol', 'codex:gpt-6-astra'])
  expect(configIds()).toEqual(['codex:gpt-6-sol', 'codex:gpt-6-astra'])
  c.setEnabled({ id: 'claude:sonnet', enabled: true })
  expect(c.list().order).toEqual(['codex:gpt-6-sol', 'codex:gpt-6-astra', 'claude:sonnet'])
  expect(configIds()).toEqual(['codex:gpt-6-sol', 'codex:gpt-6-astra', 'claude:sonnet'])
})

it('SC-012 Codex 新出的模型：出现在 Codex 里、关着、等级 high、不进审核配置', () => {
  machine()
  const c = open()
  c.list()
  codexModels(['gpt-6-astra', 'gpt-6-sol', 'gpt-6-nova'])
  c.refreshQuietly()
  const nova = model(c.list(), 'codex:gpt-6-nova')
  expect(nova).toMatchObject({ enabled: false, effort: 'high' })
  expect(configIds()).not.toContain('codex:gpt-6-nova')
})

it('SC-047 新电脑什么都没有：初始化不报错，顺序为空，审核配置合法且没有模型', () => {
  const c = open()
  const data = c.list()
  expect(data.order).toEqual([])
  expect(data.vendors.find((v) => v.id === 'claude').blocked).toBe('notInstalled')
  expect(data.vendors.find((v) => v.id === 'codex').blocked).toBe('notInstalled')
  expect(data.vendors.filter((v) => !['claude', 'codex'].includes(v.id))).toEqual([])
  expect(read('hub.json').order).toEqual([])
  expect(read('review-config.json').models).toEqual([])
})

it('SC-049 来源被挡住：模型移出审核在用与审核配置，顺序位置、开关与等级保留；恢复后回原位', () => {
  machine()
  store.setKey('deepseek', KEY)
  store.writeStatus('deepseek', 'deepseek-flash', { ok: true, source: 'test' })
  const c = open()
  c.list()
  c.setEffort({ id: 'codex:gpt-6-sol', effort: 'ultra' })
  fs.rmSync(path.join(sb.home, '.codex/auth.json'))
  let data = c.list()
  expect(data.vendors.find((v) => v.id === 'codex').blocked).toBe('notLoggedIn')
  expect(data.order).toEqual(['claude:sonnet', 'deepseek:deepseek-flash'])
  c.refreshQuietly()
  expect(configIds()).toEqual(['claude:sonnet', 'deepseek:deepseek-flash'])
  expect(read('hub.json').order).toEqual(['claude:sonnet', 'codex:gpt-6-sol', 'deepseek:deepseek-flash'])
  write('.codex/auth.json', 'auth_value_must_never_be_read')
  data = c.list()
  expect(data.order).toEqual(['claude:sonnet', 'codex:gpt-6-sol', 'deepseek:deepseek-flash'])
  expect(model(data, 'codex:gpt-6-sol')).toMatchObject({ enabled: true, effort: 'ultra' })
  c.refreshQuietly()
  expect(configIds()).toEqual(['claude:sonnet', 'codex:gpt-6-sol', 'deepseek:deepseek-flash'])
})

it('SC-049 不打开页面的事件：测不通移出、再测通回原位；Codex 单个模型消失再出现回原位', () => {
  machine()
  store.setKey('deepseek', KEY)
  store.writeStatus('deepseek', 'deepseek-flash', { ok: true, source: 'test' })
  const c = open()
  c.list()
  store.writeStatus('deepseek', 'deepseek-flash', { ok: false, source: 'test', category: 'auth' })
  c.refreshQuietly()
  expect(configIds()).toEqual(['claude:sonnet', 'codex:gpt-6-sol'])
  expect(read('hub.json').order).toContain('deepseek:deepseek-flash')
  store.writeStatus('deepseek', 'deepseek-flash', { ok: true, source: 'test' })
  c.refreshQuietly()
  expect(configIds()).toEqual(['claude:sonnet', 'codex:gpt-6-sol', 'deepseek:deepseek-flash'])

  codexModels(['gpt-6-astra'])
  c.refreshQuietly()
  expect(configIds()).toEqual(['claude:sonnet', 'deepseek:deepseek-flash'])
  expect(read('hub.json').order).toEqual(['claude:sonnet', 'codex:gpt-6-sol', 'deepseek:deepseek-flash'])
  codexModels(['gpt-6-astra', 'gpt-6-sol'])
  c.refreshQuietly()
  expect(configIds()).toEqual(['claude:sonnet', 'codex:gpt-6-sol', 'deepseek:deepseek-flash'])
  expect(model(c.list(), 'codex:gpt-6-sol').enabled).toBe(true)
})

it('SC-049 CodePal 运行中 Codex 清单下架了审核在用的模型：不用打开页面、不用手动刷新，审核配置自动去掉它；回来后回原位', async () => {
  machine()
  store.setKey('deepseek', KEY)
  store.writeStatus('deepseek', 'deepseek-flash', { ok: true, source: 'test' })
  const { registerModelsHandlers } = require('../../electron/modules/models/ipc.js')
  const lifecycle = registerModelsHandlers({
    ipcMain: { handle: () => {} },
    getMainWindow: () => null,
    loginPath: () => sb.bin,
    hubOptions: {
      homeDir: sb.home,
      env: sb.env,
      locateClaude: () => (state.claude ? FAKE : null),
      locateCodex: () => (state.codex ? codexBin : null),
    },
  })
  try {
    expect(configIds()).toEqual(['claude:sonnet', 'codex:gpt-6-sol', 'deepseek:deepseek-flash'])
    // Codex 用「写临时文件再改名」替换清单
    const cache = path.join(sb.home, '.codex/models_cache.json')
    fs.writeFileSync(`${cache}.tmp`, JSON.stringify({ models: [cacheModel('gpt-6-astra')] }))
    fs.renameSync(`${cache}.tmp`, cache)
    await vi.waitFor(() => expect(configIds()).toEqual(['claude:sonnet', 'deepseek:deepseek-flash']), { timeout: 10000 })
    expect(read('hub.json').order).toEqual(['claude:sonnet', 'codex:gpt-6-sol', 'deepseek:deepseek-flash'])
    fs.writeFileSync(`${cache}.tmp`, JSON.stringify({ models: ['gpt-6-astra', 'gpt-6-sol'].map(cacheModel) }))
    fs.renameSync(`${cache}.tmp`, cache)
    await vi.waitFor(() => expect(configIds()).toEqual(['claude:sonnet', 'codex:gpt-6-sol', 'deepseek:deepseek-flash']), { timeout: 10000 })
  } finally {
    lifecycle.stop()
  }
  // 系统的文件变化通知偶尔要等一两秒，给足时间
}, 30000)

it('SC-049 DeepSeek 的 Key 文件读不出：只把这一家移出汇总与审核配置，开关、等级、顺序都留着；读得出后回原位', () => {
  machine()
  store.setKey('deepseek', KEY)
  store.writeStatus('deepseek', 'deepseek-flash', { ok: true, source: 'test' })
  const c = open()
  expect(configIds()).toEqual(['claude:sonnet', 'codex:gpt-6-sol', 'deepseek:deepseek-flash'])
  const keyFile = path.join(sb.models, 'secrets', 'deepseek.key')
  const keyBytes = fs.readFileSync(keyFile)
  fs.rmSync(keyFile)
  expect(store.keyState('deepseek')).toEqual({ keySet: true, keyReadable: false })
  c.refreshQuietly()
  expect(configIds()).toEqual(['claude:sonnet', 'codex:gpt-6-sol'])
  expect(c.list().vendors.some((v) => v.id === 'deepseek')).toBe(false)
  expect(read('hub.json').order).toEqual(['claude:sonnet', 'codex:gpt-6-sol', 'deepseek:deepseek-flash'])
  expect(read('hub.json').reviewEnabled['deepseek:deepseek-flash']).toBe(true)
  fs.writeFileSync(keyFile, keyBytes, { mode: 0o600 })
  c.refreshQuietly()
  expect(configIds()).toEqual(['claude:sonnet', 'codex:gpt-6-sol', 'deepseek:deepseek-flash'])
})

it('SC-049 接入模型改名当新模型：旧的不再出现，新的测通后关着，打开后排最后；一家只测通部分模型只列测通的', () => {
  machine()
  store.setKey('mimo-api', KEY)
  store.writeStatus('mimo-api', 'mimo-v2.6-pro', { ok: true, source: 'test' })
  const c = open()
  c.list()
  c.setEnabled({ id: 'mimo-api:mimo-v2.6-pro', enabled: true })
  expect(configIds()).toEqual(['claude:sonnet', 'codex:gpt-6-sol', 'mimo-api:mimo-v2.6-pro'])
  store.updateModel('mimo-api', 'mimo-v2.6-pro', { name: 'mimo-v2.7' })
  c.refreshQuietly()
  let data = c.list()
  expect(model(data, 'mimo-api:mimo-v2.6-pro')).toBeUndefined()
  expect(model(data, 'mimo-api:mimo-v2.7')).toBeUndefined()
  expect(configIds()).toEqual(['claude:sonnet', 'codex:gpt-6-sol'])
  store.writeStatus('mimo-api', 'mimo-v2.7', { ok: true, source: 'test' })
  store.addModel('mimo-api', 'mimo-untested')
  c.refreshQuietly()
  data = c.list()
  expect(model(data, 'mimo-api:mimo-v2.7').enabled).toBe(false)
  expect(model(data, 'mimo-api:mimo-untested')).toBeUndefined()
  c.setEnabled({ id: 'mimo-api:mimo-v2.7', enabled: true })
  expect(c.list().order).toEqual(['claude:sonnet', 'codex:gpt-6-sol', 'mimo-api:mimo-v2.7'])
})
