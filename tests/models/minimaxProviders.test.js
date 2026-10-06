/** @vitest-environment node
 * MiniMax: isolated storage, CLI, model capabilities and safe public discovery.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { makeSandbox, runCli, readReport, CLI } from './helpers'

const require = createRequire(import.meta.url)
const presets = require('../../electron/modules/models/presets.js')
const store = require('../../electron/modules/models/store.js')
const commands = require('../../electron/modules/models/commands.js')
const { buildLaunch } = require('../../electron/modules/models/launchEnv.js')
const { classifyResult } = require('../../electron/modules/models/classify.js')
const { createModelHub } = require('../../electron/modules/models/hub.js')
const api = 'minimax-api'
const plan = 'minimax-plan'
const m3 = 'MiniMax-M3'
const flash = 'MiniMax-M3.1-Flash-Preview'
const levels = ['low', 'medium', 'high', 'xhigh', 'max']
let sb

beforeEach(() => {
  sb = makeSandbox()
  for (const [key, value] of Object.entries(sb.env)) vi.stubEnv(key, value)
})
afterEach(() => { vi.unstubAllEnvs(); sb.cleanup() })

function configured(tc) {
  expect(presets.PRESETS[api], `MINIMAX_TC_${tc}`).toBeDefined()
  for (const id of [api, plan]) store.setKey(id, `fixture.${id}`)
  return store.readConfig().providers
}
function launch(id, model, userArgs = [], mode = 'print') {
  return buildLaunch({ mode, preset: presets.PRESETS[id], model, key: `fixture.${id}`, parentEnv: sb.env, userArgs, modelsHome: sb.models })
}
function hub() {
  return createModelHub({ homeDir: sb.home, env: sb.env, locateClaude: () => null, locateCodex: () => null })
}
function tested(id, modelId, ok = true) {
  store.writeStatus(id, modelId, { ok, source: 'test' })
}
function miniVendors(data) { return data.vendors.filter(v => v.id.startsWith('minimax-')) }
function json(file) { return JSON.parse(fs.readFileSync(path.join(sb.models, file), 'utf8')) }

it('TC-003 MINIMAX_TC_003 invalid input preserves both credentials and config', () => {
  configured('003')
  const before = fs.readFileSync(path.join(sb.models, 'models.json'))
  for (const id of [api, plan]) {
    for (const key of ['', ' ', 'fixture\nkey', 'fixture\tkey', 'fixture\0key']) {
      expect(() => store.setKey(id, key)).toThrow()
      expect(store.readKey(id)).toBe(`fixture.${id}`)
    }
  }
  expect(() => store.setKey('../other', 'fixture.other')).toThrow()
  expect(fs.readFileSync(path.join(sb.models, 'models.json'))).toEqual(before)
})

it('TC-004 MINIMAX_TC_004 key replacement preserves old channels, models and states', () => {
  const providers = configured('004')
  for (const id of Object.keys(presets.PRESETS).filter(id => !id.startsWith('minimax-'))) store.setKey(id, 'sk-fixture-old')
  tested(plan, flash)
  const model = providers[api].models[0]
  store.updateModel(api, model.id, { contextTokens: 500000 })
  const other = JSON.stringify(store.readConfig().providers[plan])
  const old = Object.fromEntries(Object.entries(store.readConfig().providers).filter(([id]) => !id.startsWith('minimax-')))
  store.setKey(api, 'fixture.replacement')
  const next = store.readConfig()
  expect(next.providers[api].models).toHaveLength(1)
  expect(next.providers[api].models[0]).toMatchObject({ uid: model.uid, contextTokens: 500000 })
  expect(JSON.stringify(next.providers[plan])).toBe(other)
  expect(store.readKey(plan)).toBe('fixture.minimax-plan')
  expect(store.readStatuses()[`${plan}__${flash}`].lastTest.ok).toBe(true)
  for (const [id, provider] of Object.entries(old)) expect(next.providers[id]).toEqual(provider)
})

it('TC-005 MINIMAX_TC_005 isolated commands launch both modes without global changes', () => {
  const providers = configured('005')
  commands.installCommands({ appExecPath: process.execPath, cliPath: CLI })
  const settings = path.join(sb.home, '.claude', 'settings.json')
  fs.mkdirSync(path.dirname(settings), { recursive: true })
  fs.writeFileSync(settings, '{"alwaysThinkingEnabled":true}')
  const parent = { ...sb.env, ANTHROPIC_AUTH_TOKEN: 'fixture.parent', CLAUDE_CODE_OAUTH_TOKEN: 'fixture.oauth', ANTHROPIC_BASE_URL: 'https://wrong.invalid' }
  for (const id of [api, plan]) {
    const model = providers[id].models[0]
    for (const mode of ['interactive', 'print']) {
      const result = buildLaunch({ mode, preset: presets.PRESETS[id], model, key: `fixture.${id}`, parentEnv: parent, userArgs: [], modelsHome: sb.models })
      expect(result.env.ANTHROPIC_BASE_URL).toBe('https://api.minimax.cn/anthropic')
      expect(result.env.ANTHROPIC_API_KEY).toBe(`fixture.${id}`)
      expect(result.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
      expect(result.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
      expect(result.env.ANTHROPIC_MODEL).toBe(model.name)
      expect(result.args.join(' ')).not.toContain(`fixture.${id}`)
      if (mode === 'interactive') expect(result.env.HOME).toBe(sb.home)
      else expect(result.env.CLAUDE_CONFIG_DIR).toBe(path.join(sb.models, 'claude-home'))
    }
    const file = path.join(sb.bin, `codepal-${id}--${model.id}`)
    expect(fs.readFileSync(file, 'utf8')).toContain(`launch ${id} ${model.id}`)
    expect(runCli(['launch', id, '@first', '--', '--print', '--output-format', 'json'], { env: parent }).status).toBe(0)
    expect(readReport(sb.report).env.ANTHROPIC_MODEL).toBe(model.name)
  }
  expect(fs.readFileSync(settings, 'utf8')).toBe('{"alwaysThinkingEnabled":true}')
  expect(parent.ANTHROPIC_AUTH_TOKEN).toBe('fixture.parent')
})

it('TC-006 MINIMAX_TC_006 capabilities follow model, casing and rename across channels', () => {
  configured('006')
  for (const id of [api, plan]) {
    const preset = presets.PRESETS[id]
    for (const name of [m3, m3.toLowerCase(), flash, flash.toLowerCase()]) {
      const isFlash = name.toLowerCase() === flash.toLowerCase()
      expect(presets.modelDefaults(preset, name)).toMatchObject({ effort: isFlash ? 'max' : null, contextTokens: 1000000, maxOutputTokens: 128000 })
      expect(presets.modelCapabilities(preset, name).efforts).toEqual(isFlash ? levels : [])
      const output = JSON.parse(launch(id, { name, ...presets.modelDefaults(preset, name) }, [], 'interactive').args[1])
      expect(output.alwaysThinkingEnabled).toBe(isFlash)
      if (isFlash) expect(output.env.CLAUDE_CODE_EFFORT_LEVEL).toBe('max')
      else {
        expect(output.env).not.toHaveProperty('CLAUDE_CODE_EFFORT_LEVEL')
        expect(output).not.toHaveProperty('effortLevel')
      }
    }
    expect(presets.modelCapabilities(preset, 'custom-model').efforts).toEqual([])
  }
  const edited = store.updateModel(plan, flash, { name: 'MiniMax-M3', contextTokens: 500000, maxOutputTokens: 16000 })
  expect(edited).toMatchObject({ name: m3, effort: null, contextTokens: 500000, maxOutputTokens: 16000 })
  expect(store.updateModel(plan, m3, { name: flash }).effort).toBe('max')
})

it('TC-007 MINIMAX_TC_007 invalid effort and reserved overrides reject without writes', () => {
  const providers = configured('007')
  const before = fs.readFileSync(path.join(sb.models, 'models.json'))
  expect(() => store.updateModel(api, m3, { effort: 'high' })).toThrow('思考强度不对')
  expect(() => store.updateModel(plan, flash, { effort: 'ultra' })).toThrow('思考强度不对')
  expect(() => store.updateModel(plan, flash, { maxOutputTokens: 128001 })).toThrow()
  expect(fs.readFileSync(path.join(sb.models, 'models.json'))).toEqual(before)
  for (const value of ['', 'none', 'ultra']) expect(() => launch(plan, providers[plan].models[0], ['--effort', value])).toThrow('思考强度不对')
  for (const value of levels) {
    expect(() => launch(api, providers[api].models[0], ['--effort', value])).toThrow('思考强度不对')
    const output = launch(plan, providers[plan].models[0], [`--effort=${value}`])
    // v2.1.17：后台只认传入的等级，原样交给 claude，不再写进覆盖设置
    expect(JSON.parse(output.args[1]).env.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined()
    expect(output.args).toContain(`--effort=${value}`)
  }
  for (const mode of ['interactive', 'print']) expect(() => launch(plan, providers[plan].models[0], ['--model=other'], mode)).toThrow()
  expect(() => launch(plan, providers[plan].models[0], ['--effort', 'low'], 'interactive')).toThrow()
  store.setKey('deepseek', 'sk-fixture-old')
  expect(store.updateModel('deepseek', 'deepseek-flash', { effort: 'high' }).effort).toBe('high')
  expect(() => store.updateModel('deepseek', 'deepseek-flash', { effort: 'medium' })).toThrow()
})

it('TC-008 MINIMAX_TC_008 test and review statuses stay independent across channels', () => {
  configured('008')
  for (const [id, name] of [[api, m3], [plan, flash]]) {
    expect(runCli(['launch', id, name, '--test'], { env: { ...sb.env, CODEPAL_RUN_ID: 'fixture-run' } }).status).toBe(0)
    expect(store.readStatuses()[`${id}__${name}`]).toMatchObject({ source: 'test', runId: 'fixture-run', ok: true, lastTest: { ok: true } })
    expect(runCli(['launch', id, name, '--', '--print', '--output-format', 'json'], { env: sb.env }).status).toBe(0)
    expect(store.readStatuses()[`${id}__${name}`]).toMatchObject({ source: 'review', ok: true, lastTest: { ok: true } })
  }
})

it('TC-009 MINIMAX_TC_009 real failures preserve categories and never borrow another key', () => {
  configured('009')
  const failures = [
    ['API Error: 401 invalid api key', 'key'],
    ['API Error: 403 model permission denied', 'other'],
    ['API Error: 402 subscription quota exhausted', 'other'],
    ['API Error: 429 rate limit exceeded', 'other'],
    ['API Error: 402 insufficient balance', 'balance'],
  ]
  for (const id of [api, plan]) {
    for (const [text, reason] of failures) {
      const result = { exitCode: 1, stdout: JSON.stringify({ type: 'result', result: text, is_error: true }), stderr: '', timedOut: false }
      expect(classifyResult(result, id)).toMatchObject({ ok: false, reason })
      for (const old of Object.keys(presets.PRESETS).filter(id => !id.startsWith('minimax-'))) expect(classifyResult(result, old)).toEqual(classifyResult(result))
    }
    for (const result of [
      { exitCode: 0, stdout: JSON.stringify({ type: 'result', subtype: 'success', result: '', thinking: 'only thinking' }), stderr: '' },
      { exitCode: 1, stdout: '', stderr: 'Connection error.' },
      { exitCode: null, stdout: '', stderr: '', timedOut: true },
    ]) expect(classifyResult(result, id).ok).toBe(false)
  }
  const mock = path.join(sb.root, 'quota-cli.mjs')
  fs.writeFileSync(mock, '#!/usr/bin/env node\nif(process.argv.includes("--version")){console.log("2.1.288 (Claude Code)")}else{console.log(JSON.stringify({type:"result",subtype:"error",is_error:true,result:"API Error: 402 subscription quota exhausted"}));process.exitCode=1}\n', { mode: 0o700 })
  tested(api, m3)
  const before = fs.readFileSync(path.join(sb.models, 'status', `${api}__${m3}.json`))
  const result = runCli(['launch', plan, flash, '--test'], { env: { ...sb.env, CODEPAL_CLAUDE_BIN: mock } })
  expect(result.status).toBe(1)
  expect(store.readStatuses()[`${plan}__${flash}`]).toMatchObject({ ok: false, reason: 'other' })
  expect(fs.readFileSync(path.join(sb.models, 'status', `${api}__${m3}.json`))).toEqual(before)
})

it('TC-010 MINIMAX_TC_010 later failed review cannot erase successful test availability', () => {
  configured('010')
  tested(plan, flash)
  const at = store.readStatuses()[`${plan}__${flash}`].lastTest.at
  runCli(['launch', plan, flash, '--', '--print', '--output-format', 'json'], { env: { ...sb.env, FAKE_CLAUDE_MODE: 'api401' } })
  expect(store.readStatuses()[`${plan}__${flash}`]).toMatchObject({ source: 'review', ok: false, lastTest: { ok: true, at } })
  expect(hub().list().vendors.find(vendor => vendor.id === plan).models).toHaveLength(1)
})

it('TC-103 MINIMAX_TC_011 hub effort and access effort are stored separately', () => {
  configured('011')
  tested(api, m3)
  tested(plan, flash)
  const h = hub()
  expect(miniVendors(h.list()).map(v => v.id)).toEqual([api, plan])
  expect(miniVendors(h.list())[0].models[0]).toMatchObject({ effort: null, efforts: [] })
  expect(miniVendors(h.list())[1].models[0]).toMatchObject({ effort: 'max', efforts: levels })
  h.setEnabled({ id: `${api}:${m3}`, enabled: true })
  h.setEnabled({ id: `${plan}:${flash}`, enabled: true })
  h.setEffort({ id: `${plan}:${flash}`, effort: 'medium' })
  expect(store.readConfig().providers[plan].models[0].effort).toBe('max')
  expect(store.readConfig().providers[api].models[0].effort).toBeNull()
  const prefs = json('hub.json')
  expect(prefs.effort[`${plan}:${flash}`]).toBe('medium')
  expect(prefs.effort).not.toHaveProperty(`${api}:${m3}`)
  const reloaded = miniVendors(hub().list())
  expect(reloaded[1].models[0]).toMatchObject({ enabled: true, effort: 'medium' })
  expect(reloaded[0].models[0]).toMatchObject({ enabled: true, effort: null, efforts: [] })
  const review = json('review-config.json').models
  expect(review.find(m => m.id === `${plan}:${flash}`).effort).toBe('medium')
  expect(review.find(m => m.id === `${api}:${m3}`).effort).toBeNull()
})

it('TC-012 MINIMAX_TC_012 untested or unconfigured providers are absent from hub', () => {
  expect(presets.PRESETS[api], 'MINIMAX_TC_012').toBeDefined()
  expect(miniVendors(hub().list())).toEqual([])
  configured('012')
  expect(miniVendors(hub().list())).toEqual([])
  tested(plan, flash, false)
  expect(miniVendors(hub().list())).toEqual([])
  tested(api, m3)
  expect(miniVendors(hub().list()).map(v => v.id)).toEqual([api])
})

it('TC-013 MINIMAX_TC_013 invalid and disappeared hub rows cannot mutate another source', () => {
  configured('013')
  tested(api, m3)
  tested(plan, flash)
  const h = hub()
  h.list()
  const before = fs.readFileSync(path.join(sb.models, 'models.json'))
  expect(() => h.setEffort({ id: `${api}:${m3}`, effort: 'high' })).toThrow()
  expect(() => h.setEffort({ id: `${plan}:${flash}`, effort: 'none' })).toThrow()
  expect(fs.readFileSync(path.join(sb.models, 'models.json'))).toEqual(before)
  store.removeModel(plan, flash)
  expect(() => h.setEnabled({ id: `${plan}:${flash}`, enabled: true })).toThrow()
  expect(store.readConfig().providers[api].models[0].name).toBe(m3)
})

it('TC-014 MINIMAX_TC_014 safe review config has distinct identities', () => {
  configured('014')
  tested(api, m3)
  tested(plan, flash)
  commands.installCommands({ appExecPath: process.execPath, cliPath: CLI })
  const h = hub()
  h.setEnabled({ id: `${api}:${m3}`, enabled: true })
  h.setEnabled({ id: `${plan}:${flash}`, enabled: true })
  // v2.1.17：给 dev 的审核配置只放审核需要的字段；两个渠道靠 provider 区分，不写本机命令路径与计费类别
  const snapshot = json('review-config.json')
  expect(snapshot.models).toHaveLength(2)
  expect(snapshot.models[0]).toMatchObject({ id: `${api}:${m3}`, family: 'minimax', provider: api, effort: null })
  expect(snapshot.models[1]).toMatchObject({ id: `${plan}:${flash}`, family: 'minimax', provider: plan })
  for (const model of snapshot.models) expect(Object.keys(model).sort()).toEqual(['id','family','runner','provider','model','displayName','effort'].sort())
  expect(JSON.stringify(snapshot)).not.toContain('fixture.')
  expect(JSON.stringify(snapshot)).not.toContain('secrets')
  expect(fs.statSync(path.join(sb.models, 'review-config.json')).mode & 0o777).toBe(0o644)
})

it('TC-015 MINIMAX_TC_015 public discovery excludes disabled or missing-key models', () => {
  configured('015')
  tested(api, m3)
  tested(plan, flash)
  const h = hub()
  h.reconcile()
  expect(miniVendors(h.list())).toHaveLength(2)
  expect(json('review-config.json').models).toEqual([])
  h.setEnabled({ id: `${api}:${m3}`, enabled: true })
  h.setEnabled({ id: `${plan}:${flash}`, enabled: true })
  expect(json('review-config.json').models.every(model => model.command === undefined)).toBe(true)
  fs.rmSync(path.join(sb.models, 'secrets', `${api}.key`))
  h.refreshQuietly()
  expect(miniVendors(h.refresh()).map(v => v.id)).toEqual([plan])
  expect(json('review-config.json').models.map(m => m.id)).toEqual([`${plan}:${flash}`])
})

it('TC-017 MINIMAX_TC_017 no-key CLI stays local, leaves other channel untouched', () => {
  expect(presets.PRESETS[api], 'MINIMAX_TC_017').toBeDefined()
  store.setKey(plan, 'fixture.plan-only')
  const before = fs.readFileSync(path.join(sb.models, 'models.json'))
  const result = runCli(['launch', api, '@first', '--', '--print', '--output-format', 'json'], { env: sb.env })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('还没填 Key')
  expect(readReport(sb.report)).toBeNull()
  expect(store.readStatuses()).toEqual({})
  expect(fs.readFileSync(path.join(sb.models, 'models.json'))).toEqual(before)
})
