/**
 * @vitest-environment node
 *
 * 模型接入 · 主进程接口（4-test-cases.md 模块 A、D、F 的接口部分）
 *
 * 负责：
 * - models:* 通道的返回形状 { success, data, error: { code, message } }
 * - Key 只写不回读、非法 Key 不落盘、配置坏了不改写、Key 读不到
 * - 测一下经命令行跑替身并读回状态；超时；状态目录变化推 models:changed
 *
 * @module tests/models/ipc.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { makeSandbox, waitFor, alive, readReport, REPO, KEY } from './helpers'

const require = createRequire(import.meta.url)
const { registerModelsHandlers } = require('../../electron/modules/models/ipc.js')
const store = require('../../electron/modules/models/store.js')

let sb
let handlers
let send
let api
const call = (ch, arg) => handlers[ch]({}, arg)

beforeEach(() => {
  sb = makeSandbox()
  for (const [k, v] of Object.entries(sb.env)) process.env[k] = v
  handlers = {}
  send = vi.fn()
  api = registerModelsHandlers({
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn } },
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send } }),
    cliPath: path.join(REPO, 'electron/modules/models/cli.cjs'),
    appExecPath: process.execPath,
    loginPath: () => `/usr/bin:${sb.bin}`,
  })
})
afterEach(() => {
  api.stop()
  for (const k of Object.keys(sb.env)) if (k !== 'PATH' && k !== 'HOME') delete process.env[k]
  delete process.env.FAKE_CLAUDE_MODE
  delete process.env.CODEPAL_TEST_TIMEOUT_MS
  sb.cleanup()
})

describe('models:* 接口', () => {
  it('注册了十六个通道（v2.1.17 加顺序、审核规则与审核配置重试）', () => {
    expect(Object.keys(handlers).sort()).toEqual(['models:addModel', 'models:configRepublish', 'models:hubList', 'models:hubSetEffort', 'models:hubSetEnabled', 'models:hubSetOrder', 'models:installCommands', 'models:list', 'models:recheckClaude', 'models:removeModel', 'models:rulesGet', 'models:rulesReset', 'models:rulesSet', 'models:setKey', 'models:test', 'models:updateModel'])
  })

  it('TC-A04 Key 不以 sk- 开头返回 invalid_input 且不写文件', async () => {
    const r = await call('models:setKey', { providerId: 'deepseek', key: 'ab-123' })
    expect(r).toMatchObject({ success: false, error: { code: 'invalid_input', message: 'DeepSeek 的 Key 以 sk- 开头' } })
    expect(fs.existsSync(path.join(sb.models, 'secrets', 'deepseek.key'))).toBe(false)
  })

  it('TC-A05 Key 含换行返回 invalid_input', async () => {
    const r = await call('models:setKey', { providerId: 'deepseek', key: 'sk-abc\ndef' })
    expect(r.error.code).toBe('invalid_input')
    expect(fs.existsSync(path.join(sb.models, 'secrets', 'deepseek.key'))).toBe(false)
  })

  it('TC-A06 models:list 不返回 Key，只有 keySet', async () => {
    await call('models:setKey', { providerId: 'deepseek', key: KEY })
    const r = await call('models:list')
    expect(r.success).toBe(true)
    expect(JSON.stringify(r)).not.toContain(KEY)
    expect(r.data.providers.deepseek.keySet).toBe(true)
    expect(r.data.providers.deepseek.models[0]).toMatchObject({ id: 'deepseek-flash', lastResult: null })
    expect(r.data.claudeCode).toMatchObject({ found: true, version: '2.1.283', tooOld: false, required: '2.1.251' })
    expect(r.data.commands).toMatchObject({ installed: false, missing: ['deepseek-flash'], onPath: true })
  })

  it('写操作顺带返回终端命令状态（没装过命令时新模型缺命令）', async () => {
    const r = await call('models:setKey', { providerId: 'deepseek', key: KEY })
    expect(r.data.commands).toMatchObject({ installed: false, missing: ['deepseek-flash'] })
    const r2 = await call('models:addModel', { providerId: 'deepseek', name: 'deepseek-v4-pro' })
    expect(r2.data.commands.missing).toEqual(['deepseek-flash', 'deepseek-v4-pro'])
    const r3 = await call('models:updateModel', { providerId: 'deepseek', modelId: 'deepseek-v4-pro', patch: { effort: 'high' } })
    expect(r3.data).toMatchObject({ model: { id: 'deepseek-v4-pro', effort: 'high' }, commands: { installed: false } })
  })

  it('没填 Key 时 list 也返回每家（keySet false、没有模型）', async () => {
    const r = await call('models:list')
    expect(r.data.providers.deepseek).toEqual({ keySet: false, keyReadable: false, models: [] })
  })

  it('TC-A08 配置坏了 list 返回 read_failed 且不改写', async () => {
    fs.mkdirSync(sb.models, { recursive: true })
    fs.writeFileSync(path.join(sb.models, 'models.json'), '{broken')
    const r = await call('models:list')
    expect(r).toMatchObject({ success: false, error: { code: 'read_failed' } })
    expect(fs.readFileSync(path.join(sb.models, 'models.json'), 'utf8')).toBe('{broken')
  })

  it('TC-A09 Key 文件丢失时 keyReadable false', async () => {
    await call('models:setKey', { providerId: 'deepseek', key: KEY })
    fs.rmSync(path.join(sb.models, 'secrets', 'deepseek.key'))
    const r = await call('models:list')
    expect(r.data.providers.deepseek).toMatchObject({ keySet: true, keyReadable: false })
  })

  it('TC-D08 测一下成功写状态并返回 lastResult', async () => {
    await call('models:setKey', { providerId: 'deepseek', key: KEY })
    process.env.FAKE_CLAUDE_MODE = 'success'
    const r = await call('models:test', { providerId: 'deepseek', modelId: 'deepseek-flash' })
    expect(r).toMatchObject({ success: true, data: { lastResult: { ok: true, source: 'test' } } })
    expect(fs.statSync(path.join(sb.models, 'status', 'deepseek__deepseek-flash.json')).mode & 0o777).toBe(0o600)
  })

  it('TC-D06 测一下超时判 net 且替身结束', async () => {
    await call('models:setKey', { providerId: 'deepseek', key: KEY })
    process.env.FAKE_CLAUDE_MODE = 'hang'
    process.env.CODEPAL_TEST_TIMEOUT_MS = '2000'
    const t0 = Date.now()
    const r = await call('models:test', { providerId: 'deepseek', modelId: 'deepseek-flash' })
    const ms = Date.now() - t0
    expect(ms).toBeGreaterThanOrEqual(1500)
    expect(ms).toBeLessThan(8000)
    expect(r.data.lastResult).toMatchObject({ ok: false, reason: 'net' })
    expect(await waitFor(() => !alive(readReport(sb.report).pid), 3000)).toBe(true)
  })

  it('TC-F09 接口侧模型名校验', async () => {
    await call('models:setKey', { providerId: 'deepseek', key: KEY })
    for (const name of ['../evil', 'a b', 'a;rm -rf ~', 'a'.repeat(65)]) {
      expect((await call('models:addModel', { providerId: 'deepseek', name })).error.code).toBe('invalid_input')
    }
    expect((await call('models:addModel', { providerId: 'deepseek', name: 'DeepSeek-Flash' })).error.code).toBe('duplicate')
    expect((await call('models:addModel', { providerId: 'deepseek', name: 'MiniMax-M2' })).success).toBe(true)
    for (const name of ['deepseek', 'DeepSeek']) {
      expect((await call('models:addModel', { providerId: 'deepseek', name })).error).toEqual({ code: 'invalid_input', message: '不能和供应商同名' })
    }
    expect((await call('models:updateModel', { providerId: 'deepseek', modelId: 'deepseek-flash', patch: { name: 'deepseek' } })).error.code).toBe('invalid_input')
  })

  it('TC-F04 / F07 装过命令后，加模型与改名自动同步命令', async () => {
    await call('models:setKey', { providerId: 'deepseek', key: KEY })
    expect((await call('models:installCommands')).data.installed.sort()).toEqual(['codepal-deepseek', 'codepal-deepseek-flash'])
    await call('models:addModel', { providerId: 'deepseek', name: 'deepseek-v4-pro' })
    expect(fs.existsSync(path.join(sb.bin, 'codepal-deepseek-v4-pro'))).toBe(true)
    await call('models:updateModel', { providerId: 'deepseek', modelId: 'deepseek-v4-pro', patch: { name: 'deepseek-v4-pro-2' } })
    expect(fs.existsSync(path.join(sb.bin, 'codepal-deepseek-v4-pro'))).toBe(false)
    expect(fs.existsSync(path.join(sb.bin, 'codepal-deepseek-v4-pro-2'))).toBe(true)
    await call('models:removeModel', { providerId: 'deepseek', modelId: 'deepseek-v4-pro-2' })
    expect(fs.existsSync(path.join(sb.bin, 'codepal-deepseek-v4-pro-2'))).toBe(false)
  })

  it('TC-F02 命令被占用时返回 occupied', async () => {
    await call('models:setKey', { providerId: 'deepseek', key: KEY })
    fs.mkdirSync(sb.bin, { recursive: true })
    fs.writeFileSync(path.join(sb.bin, 'codepal-deepseek'), '#!/bin/sh\necho mine\n')
    const r = await call('models:installCommands')
    expect(r).toMatchObject({ success: false, error: { code: 'occupied' } })
  })

  it('命令目录不可写时返回 write_denied 与安装失败文案', async () => {
    await call('models:setKey', { providerId: 'deepseek', key: KEY })
    fs.mkdirSync(sb.bin, { recursive: true })
    fs.chmodSync(sb.bin, 0o500)
    try {
      const r = await call('models:installCommands')
      expect(r).toMatchObject({ success: false, error: { code: 'write_denied', message: '安装失败：~/.local/bin 没有写入权限，检查权限后重试' } })
    } finally {
      fs.chmodSync(sb.bin, 0o700)
    }
  })

  it('TC-F10 命令行写状态后主进程推 models:changed', async () => {
    await call('models:setKey', { providerId: 'deepseek', key: KEY })
    process.env.FAKE_CLAUDE_MODE = 'api402'
    const { spawnSync } = await import('node:child_process')
    spawnSync(process.execPath, [path.join(REPO, 'electron/modules/models/cli.cjs'), 'launch', 'deepseek', 'deepseek-flash', '--', '--print', '--output-format', 'json'], { input: 'r', env: { ...process.env } })
    expect(await waitFor(() => send.mock.calls.some((c) => c[0] === 'models:changed'), 3000)).toBe(true)
    const payload = send.mock.calls.find((c) => c[0] === 'models:changed')[1]
    expect(payload).toMatchObject({ providerId: 'deepseek', modelId: 'deepseek-flash', lastResult: { ok: false, reason: 'balance', source: 'review' } })
  })

  it('测一下没跑起来时不把旧的成功结果当这次结果（Codex 审核 P1）', async () => {
    await call('models:setKey', { providerId: 'deepseek', key: KEY })
    store.writeStatus('deepseek', 'deepseek-flash', { ok: true, source: 'review' })
    process.env.CODEPAL_CLAUDE_BIN = path.join(sb.root, 'no-such-claude')
    const r = await call('models:test', { providerId: 'deepseek', modelId: 'deepseek-flash' })
    expect(r).toMatchObject({ success: false, error: { code: 'test_failed', message: '没找到 Claude Code' } })
  })

  it('模型名带 __ 时推送的 modelId 完整（Codex 审核 P2）', async () => {
    await call('models:setKey', { providerId: 'deepseek', key: KEY })
    await call('models:addModel', { providerId: 'deepseek', name: 'foo__bar' })
    store.writeStatus('deepseek', 'foo__bar', { ok: false, reason: 'net', source: 'review' })
    expect(await waitFor(() => send.mock.calls.some((c) => c[0] === 'models:changed'), 3000)).toBe(true)
    expect(send.mock.calls.find((c) => c[0] === 'models:changed')[1]).toMatchObject({ providerId: 'deepseek', modelId: 'foo__bar' })
  })

  it('调用期间模型被移除后同名重加，旧调用的结果不写回（Codex 审核 P2）', async () => {
    await call('models:setKey', { providerId: 'deepseek', key: KEY })
    await call('models:addModel', { providerId: 'deepseek', name: 'deepseek-v4-pro' })
    process.env.FAKE_CLAUDE_MODE = 'hang'
    process.env.CODEPAL_TEST_TIMEOUT_MS = '1500'
    const pending = call('models:test', { providerId: 'deepseek', modelId: 'deepseek-v4-pro' })
    // 等替身真的起来（命令行已经按旧模型启动了 claude），再移除；机器忙时固定等待不可靠
    expect(await waitFor(() => fs.existsSync(sb.report), 5000)).toBe(true)
    await call('models:removeModel', { providerId: 'deepseek', modelId: 'deepseek-v4-pro' })
    await call('models:addModel', { providerId: 'deepseek', name: 'deepseek-v4-pro' })
    const r = await pending
    expect(r.error.code).toBe('test_failed')
    expect(fs.existsSync(path.join(sb.models, 'status', 'deepseek__deepseek-v4-pro.json'))).toBe(false)
  }, 20000)

  it('旧配置（档位 xhigh、输出上限 384,000）照常读取、展示与启动（Codex 审核第 3 轮 P2）', async () => {
    await call('models:setKey', { providerId: 'deepseek', key: KEY })
    const cfg = store.readConfig()
    Object.assign(cfg.providers.deepseek.models[0], { effort: 'xhigh', maxOutputTokens: 384000 })
    store.writeConfig(cfg)
    const list = await call('models:list')
    expect(list.data.providers.deepseek.models[0]).toMatchObject({ effort: 'xhigh', maxOutputTokens: 384000 })
    const { spawnSync } = await import('node:child_process')
    const r = spawnSync(process.execPath, [path.join(REPO, 'electron/modules/models/cli.cjs'), 'launch', 'deepseek', 'deepseek-flash', '--', '--print'], { input: 'hi', env: { ...process.env, FAKE_CLAUDE_MODE: 'success' } })
    expect(r.status).toBe(0)
    const report = readReport(sb.report)
    // v2.1.17：后台调用只认传入的等级，不传就不设；旧档位只在终端手动用时照常（见 providerLegacy）
    const legacyEnv = JSON.parse(report.argv[report.argv.indexOf('--settings') + 1]).env
    expect(legacyEnv).toMatchObject({ CLAUDE_CODE_MAX_OUTPUT_TOKENS: '384000' })
    expect(legacyEnv.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined()
    // 只改别的参数不受旧值拦截
    expect((await call('models:updateModel', { providerId: 'deepseek', modelId: 'deepseek-flash', patch: { contextTokens: 500000 } })).success).toBe(true)
  })

  it('TC-F11 改名、调参后下一次启动真的用新值', async () => {
    await call('models:setKey', { providerId: 'deepseek', key: KEY })
    expect((await call('models:updateModel', { providerId: 'deepseek', modelId: 'deepseek-flash', patch: { name: 'deepseek-v4-pro' } })).success).toBe(true)
    expect((await call('models:updateModel', { providerId: 'deepseek', modelId: 'deepseek-v4-pro', patch: { effort: 'high' } })).success).toBe(true)
    const { spawnSync } = await import('node:child_process')
    const r = spawnSync(process.execPath, [path.join(REPO, 'electron/modules/models/cli.cjs'), 'launch', 'deepseek', 'deepseek-v4-pro', '--test'], { env: { ...process.env, FAKE_CLAUDE_MODE: 'success' } })
    expect(r.status).toBe(0)
    const report = readReport(sb.report)
    expect(report.env.ANTHROPIC_MODEL).toBe('deepseek-v4-pro')
    // 测一下由 CodePal 把模型接入里调过的档位作为 --effort 传入（v2.1.17）
    expect(report.argv.slice(report.argv.indexOf('--effort'), report.argv.indexOf('--effort') + 2)).toEqual(['--effort', 'high'])
  })

  it('recheckClaude 返回当前检测结果', async () => {
    expect((await call('models:recheckClaude')).data).toMatchObject({ found: true, version: '2.1.283' })
  })
})


it('SC-017 TC-066 未测通不列第三方，接入列表仍保留未测模型', async () => {
  await call('models:setKey', { providerId: 'deepseek', key: KEY })
  expect(typeof handlers['models:hubList']).toBe('function')
  const hub = await call('models:hubList')
  expect(hub.success).toBe(true)
  expect(hub.data.vendors.some(v => v.id === 'deepseek')).toBe(false)
  expect((await call('models:list')).data.providers.deepseek.models).toHaveLength(1)
})
