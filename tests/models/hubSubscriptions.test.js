/** @vitest-environment node */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { makeSandbox, KEY, FAKE } from './helpers'
const require = createRequire(import.meta.url)
const {
  registerModelsHandlers,
} = require('../../electron/modules/models/ipc.js')
const store = require('../../electron/modules/models/store.js')
let sb, original, handlers, lifecycle, env
const model = (slug, visibility = 'list') => ({
  slug,
  display_name: `Display ${slug}`,
  visibility,
  supported_reasoning_levels: ['low', 'high', 'ultra'].map((effort) => ({
    effort,
  })),
})
function write(relative, value) {
  const file = path.join(sb.home, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    typeof value === 'string' ? value : JSON.stringify(value),
  )
  return file
}
function ready() {
  write('.claude.json', { oauthAccount: { token: 'token_redacted' } })
  write('.claude/settings.json', { model: 'claude-sonnet-5-5' })
  write('.codex/auth.json', 'auth_value_must_never_be_read')
  write('.codex/config.toml', 'model = "hidden-model"\n')
  write('.codex/models_cache.json', {
    models: [
      model('gpt-6-astra'),
      model('hidden-model', 'hide'),
      model('gpt-6-sol'),
    ],
  })
}
function open() {
  lifecycle?.stop()
  handlers = {}
  lifecycle = registerModelsHandlers({
    ipcMain: {
      handle: (ch, fn) => {
        handlers[ch] = fn
      },
    },
    getMainWindow: () => null,
    loginPath: () => sb.bin,
    hubOptions: { homeDir: sb.home, env },
  })
}
async function list() {
  expect(typeof handlers['models:hubList']).toBe('function')
  const result = await handlers['models:hubList']({})
  expect(result.success).toBe(true)
  return result.data
}
async function save(action, payload) {
  expect(typeof handlers[`models:${action}`]).toBe('function')
  const r = await handlers[`models:${action}`]({}, payload)
  expect(r.success).toBe(true)
  return r.data
}
const vendor = (data, id) => data.vendors.find((v) => v.id === id)
beforeEach(() => {
  sb = makeSandbox()
  original = Object.fromEntries(
    Object.keys(sb.env).map((k) => [k, process.env[k]]),
  )
  Object.assign(process.env, sb.env)
  fs.mkdirSync(sb.bin, { recursive: true })
  const codex = path.join(sb.bin, 'codex')
  fs.writeFileSync(codex, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  env = { ...process.env, CODEPAL_CLAUDE_BIN: FAKE, CODEPAL_CODEX_BIN: codex }
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
it('SC-022 TC-071 本机首次默认、四Claude简称及真实Codex可见档位；不读取auth值', async () => {
  ready()
  store.setKey('deepseek', KEY)
  store.addModel('deepseek', 'deepseek-v4-pro')
  for (const name of ['deepseek-flash', 'deepseek-v4-pro'])
    store.writeStatus('deepseek', name, { ok: true, source: 'test' })
  const readFile = fs.readFileSync
  vi.spyOn(fs, 'readFileSync').mockImplementation((file, ...args) => {
    if (String(file) === path.join(sb.home, '.codex/auth.json'))
      throw new Error('auth contents were accessed')
    return readFile(file, ...args)
  })
  open()
  const data = await list()
  const claude = vendor(data, 'claude')
  const codex = vendor(data, 'codex')
  expect(claude.models.map((m) => [m.id, m.displayName])).toEqual([
    ['claude:fable', 'Fable 5.1'],
    ['claude:opus', 'Opus 5.5'],
    ['claude:sonnet', 'Sonnet 5.5'],
    ['claude:haiku', 'Haiku 4.5'],
  ])
  expect(
    claude.models.every(
      (m) => m.efforts.join(',') === 'low,medium,high,xhigh,max',
    ),
  ).toBe(true)
  expect(claude.models.filter((m) => m.enabled).map((m) => m.id)).toEqual([
    'claude:sonnet',
  ])
  expect(codex.models.map((m) => m.id)).toEqual([
    'codex:gpt-6-astra',
    'codex:gpt-6-sol',
  ])
  expect(codex.models[0]).toMatchObject({
    displayName: 'Display gpt-6-astra',
    enabled: true,
    effort: 'high',
    efforts: ['low', 'high', 'ultra'],
  })
  expect(
    vendor(data, 'deepseek')
      .models.filter((m) => m.enabled)
      .map((m) => m.id),
  ).toEqual(['deepseek:deepseek-flash'])
  expect(JSON.stringify(data)).not.toContain('token_redacted')
  expect(JSON.stringify(data)).not.toContain(KEY)
  const snapshot = JSON.parse(
    fs.readFileSync(path.join(sb.models, 'review-models.json'), 'utf8'),
  )
  expect(snapshot.models.slice(0, 2)).toMatchObject([
    {
      vendor: 'claude',
      family: 'anthropic',
      runner: 'claude-cli',
      billing: 'subscription',
      model: 'sonnet',
    },
    {
      vendor: 'codex',
      family: 'openai',
      runner: 'codex-exec',
      billing: 'subscription',
      model: 'gpt-6-astra',
    },
  ])
})
it('SC-022 TC-071 下架、恢复、新模型及重启保留原偏好与强度，不重设初始化时间', async () => {
  ready()
  open()
  await list()
  const hubPath = path.join(sb.models, 'hub.json')
  const first = JSON.parse(fs.readFileSync(hubPath, 'utf8')).initializedAt
  await save('hubSetEnabled', { id: 'codex:gpt-6-astra', enabled: false })
  await save('hubSetEffort', { id: 'codex:gpt-6-astra', effort: 'ultra' })
  write('.codex/models_cache.json', { models: [model('gpt-6-sol')] })
  expect(vendor(await list(), 'codex').models.map((m) => m.id)).toEqual([
    'codex:gpt-6-sol',
  ])
  write('.codex/models_cache.json', {
    models: [model('gpt-6-astra'), model('gpt-6-luna'), model('gpt-6-sol')],
  })
  const data = await list()
  expect(vendor(data, 'codex').models[0]).toMatchObject({
    enabled: false,
    effort: 'ultra',
  })
  expect(vendor(data, 'codex').models[1]).toMatchObject({
    enabled: false,
    effort: 'high',
  })
  write('.claude.json', {})
  expect(vendor(await list(), 'claude')).toMatchObject({
    blocked: 'notLoggedIn',
    models: [],
  })
  write('.claude.json', { oauthAccount: null })
  open()
  expect(
    vendor(await list(), 'claude').models.find((m) => m.id === 'claude:sonnet')
      .enabled,
  ).toBe(true)
  expect(JSON.parse(fs.readFileSync(hubPath, 'utf8')).initializedAt).toBe(first)
})
it.each([
  ['fable', 'fable'],
  ['opus[1m]', 'opus'],
  ['claude-sonnet-5-5', 'sonnet'],
  ['claude-haiku-4-5', 'haiku'],
  ['unknown-custom-model', 'opus'],
])('SC-022 默认Claude %s归到%s；不改用户设置', async (input, expected) => {
  ready()
  const settings = write('.claude/settings.json', { model: input })
  const before = fs.readFileSync(settings, 'utf8')
  open()
  const data = await list()
  expect(
    vendor(data, 'claude')
      .models.filter((m) => m.enabled)
      .map((m) => m.id),
  ).toEqual([`claude:${expected}`])
  expect(fs.readFileSync(settings, 'utf8')).toBe(before)
})
it('SC-023 TC-072 新电脑没有来源也生成合法空清单；后来安装不自动改变偏好', async () => {
  env.CODEPAL_CLAUDE_BIN = path.join(sb.root, 'missing-claude')
  env.CODEPAL_CODEX_BIN = path.join(sb.root, 'missing-codex')
  open()
  const data = await list()
  expect(data.vendors).toMatchObject([
    { id: 'claude', blocked: 'notInstalled', models: [] },
    { id: 'codex', blocked: 'notInstalled', models: [] },
  ])
  expect(data.vendors).toHaveLength(2)
  expect(
    JSON.parse(
      fs.readFileSync(path.join(sb.models, 'review-models.json'), 'utf8'),
    ).models,
  ).toEqual([])
})
it('SC-024 TC-073 挡住优先级：没装先于未登录；登录只看字段存在', async () => {
  ready()
  env.CODEPAL_CLAUDE_BIN = path.join(sb.root, 'missing-claude')
  env.CODEPAL_CODEX_BIN = path.join(sb.root, 'missing-codex')
  open()
  expect(vendor(await list(), 'claude').blocked).toBe('notInstalled')
  expect(vendor(await list(), 'codex').blocked).toBe('notInstalled')
  env.CODEPAL_CLAUDE_BIN = FAKE
  env.CODEPAL_CODEX_BIN = path.join(sb.bin, 'codex')
  fs.rmSync(path.join(sb.home, '.claude.json'))
  fs.rmSync(path.join(sb.home, '.codex/auth.json'))
  expect(vendor(await list(), 'claude').blocked).toBe('notLoggedIn')
  expect(vendor(await list(), 'codex').blocked).toBe('notLoggedIn')
  write('.claude.json', { oauthAccount: null })
  write('.codex/auth.json', 'unreadable values are not accessed')
  fs.rmSync(path.join(sb.home, '.codex/models_cache.json'))
  expect(vendor(await list(), 'claude').blocked).toBeNull()
  expect(vendor(await list(), 'codex').blocked).toBe('noModelList')
  write('.codex/models_cache.json', '{bad')
  expect(vendor(await list(), 'codex').models).toEqual([])
  write('.codex/models_cache.json', { models: [model('gpt-6-astra')] })
  expect(vendor(await list(), 'codex').blocked).toBeNull()
})
it('模型接入配置损坏仅降级该来源；订阅可用且坏文件保持', async () => {
  ready()
  fs.mkdirSync(sb.models, { recursive: true })
  fs.writeFileSync(path.join(sb.models, 'models.json'), '{bad')
  open()
  const data = await list()
  expect(data.providerConfigError).toBe(true)
  expect(data.vendors.map((v) => v.id)).toEqual(['claude', 'codex'])
  expect(vendor(data, 'claude').models).toHaveLength(4)
  expect(fs.readFileSync(path.join(sb.models, 'models.json'), 'utf8')).toBe(
    '{bad',
  )
})

it('SC-022 未设强度仍按定稿字面high，不偷偷替换成首档；菜单与保存只认支持档位', async () => {
  ready()
  const item = model('gpt-6-astra')
  item.supported_reasoning_levels = [{ effort: 'low' }, { effort: 'ultra' }]
  write('.codex/models_cache.json', { models: [item] })
  open()
  const data = await list()
  expect(vendor(data, 'codex').models[0]).toMatchObject({
    effort: 'high',
    efforts: ['low', 'ultra'],
    enabled: true,
  })
  const snapshot = JSON.parse(
    fs.readFileSync(path.join(sb.models, 'review-models.json'), 'utf8'),
  )
  expect(snapshot.models.find((m) => m.id === 'codex:gpt-6-astra').effort).toBe(
    'high',
  )
  expect(
    (
      await handlers['models:hubSetEffort'](
        {},
        { id: 'codex:gpt-6-astra', effort: 'high' },
      )
    ).success,
  ).toBe(false)
  await save('hubSetEffort', { id: 'codex:gpt-6-astra', effort: 'ultra' })
  expect(vendor(await list(), 'codex').models[0].effort).toBe('ultra')
})

it.each([
  ['claude:sonnet', 'max'],
  ['codex:gpt-6-astra', 'ultra'],
])('SC-026 TC-075 订阅强度%s只写hub并更新清单；非法值与写失败保持原文件', async (id, effort) => {
  ready()
  open()
  await list()
  const hubPath = path.join(sb.models, 'hub.json')
  const publicPath = path.join(sb.models, 'review-models.json')
  const configPath = path.join(sb.models, 'models.json')
  const configBefore = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : null
  await save('hubSetEffort', { id, effort })
  expect(JSON.parse(fs.readFileSync(hubPath, 'utf8')).effort[id]).toBe(effort)
  expect(JSON.parse(fs.readFileSync(publicPath, 'utf8')).models.find((m) => m.id === id).effort).toBe(effort)
  expect(fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : null).toBe(configBefore)
  const hubBefore = fs.readFileSync(hubPath, 'utf8')
  const publicBefore = fs.readFileSync(publicPath, 'utf8')
  expect((await handlers['models:hubSetEffort']({}, { id, effort: 'unsupported' })).success).toBe(false)
  expect(fs.readFileSync(hubPath, 'utf8')).toBe(hubBefore)
  expect(fs.readFileSync(publicPath, 'utf8')).toBe(publicBefore)
  const rename = fs.renameSync
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (to === publicPath) {
      const error = new Error('test write denied')
      error.code = 'EACCES'
      throw error
    }
    return rename(from, to)
  })
  expect((await handlers['models:hubSetEffort']({}, { id, effort: 'low' })).success).toBe(false)
  expect(fs.readFileSync(hubPath, 'utf8')).toBe(hubBefore)
  expect(fs.readFileSync(publicPath, 'utf8')).toBe(publicBefore)
  expect(fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : null).toBe(configBefore)
})
