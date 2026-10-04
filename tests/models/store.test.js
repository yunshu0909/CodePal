/**
 * @vitest-environment node
 *
 * 模型接入 · 存储与 Key（specs/第三方模型接入/4-test-cases.md 模块 A 的存储层部分）
 *
 * 负责：
 * - 目录与文件权限、Key 独立存放且不进配置、首次存 Key 自动加预设默认模型
 * - 模型名校验（F09 主进程侧的规则在这里实现）
 *
 * @module tests/models/store.test
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { makeSandbox, KEY } from './helpers'

const require = createRequire(import.meta.url)
const store = require('../../electron/modules/models/store.js')

let sb
beforeEach(() => {
  sb = makeSandbox()
  process.env.CODEPAL_MODELS_HOME = sb.models
})
afterEach(() => {
  delete process.env.CODEPAL_MODELS_HOME
  sb.cleanup()
})

const mode = (p) => fs.statSync(p).mode & 0o777

describe('模块 A · 存储', () => {
  it('TC-A01 首次写入后 models 目录 0700、models.json 0600', () => {
    store.writeConfig({ schemaVersion: 1, providers: {} })
    expect(mode(sb.models)).toBe(0o700)
    expect(mode(path.join(sb.models, 'models.json'))).toBe(0o600)
  })

  it('TC-A02 保存 Key 后 models.json 不含 Key 原文', () => {
    expect(store.setKey('deepseek', KEY)).toEqual({ keySet: true })
    const text = fs.readFileSync(path.join(sb.models, 'models.json'), 'utf8')
    expect(text).not.toContain(KEY)
    expect(text).not.toContain('0123456789abcdef')
  })

  it('TC-A03 Key 写进 secrets/deepseek.key 且权限 0600', () => {
    store.setKey('deepseek', KEY)
    const file = path.join(sb.models, 'secrets', 'deepseek.key')
    expect(fs.readFileSync(file, 'utf8')).toBe(KEY)
    expect(mode(file)).toBe(0o600)
    expect(mode(path.join(sb.models, 'secrets'))).toBe(0o700)
  })

  it('TC-A07 首次保存 Key 自动加入且只加入预设默认模型 deepseek-flash', () => {
    store.setKey('deepseek', KEY)
    const models = store.readConfig().providers.deepseek.models
    expect(models).toHaveLength(1)
    expect(models[0]).toMatchObject({ id: 'deepseek-flash', name: 'deepseek-flash', effort: 'max', contextTokens: 1000000, maxOutputTokens: 128000 })
  })

  it('更换 Key 不重复加模型', () => {
    store.setKey('deepseek', KEY)
    store.setKey('deepseek', 'sk-another-1234567890')
    expect(store.readConfig().providers.deepseek.models).toHaveLength(1)
    expect(store.readKey('deepseek')).toBe('sk-another-1234567890')
  })

  it('配置损坏时 readConfig 抛 read_failed 且不改写文件', () => {
    fs.mkdirSync(sb.models, { recursive: true })
    fs.writeFileSync(path.join(sb.models, 'models.json'), '{broken')
    expect(() => store.readConfig()).toThrow(expect.objectContaining({ code: 'read_failed' }))
    expect(fs.readFileSync(path.join(sb.models, 'models.json'), 'utf8')).toBe('{broken')
  })

  it('Key 文件丢失时 keyState 为 keySet true、keyReadable false', () => {
    store.setKey('deepseek', KEY)
    fs.rmSync(path.join(sb.models, 'secrets', 'deepseek.key'))
    expect(store.keyState('deepseek')).toEqual({ keySet: true, keyReadable: false })
  })

  it('状态文件写入 0600 并能读回', () => {
    store.writeStatus('deepseek', 'deepseek-flash', { ok: true, reason: null, message: null, source: 'test' })
    const file = path.join(sb.models, 'status', 'deepseek__deepseek-flash.json')
    expect(mode(file)).toBe(0o600)
    const all = store.readStatuses()
    expect(all['deepseek__deepseek-flash']).toMatchObject({ ok: true, source: 'test' })
    expect(typeof all['deepseek__deepseek-flash'].at).toBe('string')
  })
})

describe('模型名规则（PRD US-06，TC-F09 的主进程规则）', () => {
  beforeEach(() => store.setKey('deepseek', KEY))

  it.each(['../evil', 'a b', 'a;rm -rf ~', 'a'.repeat(65), ''])('非法名 %j 被拒绝', (name) => {
    expect(() => store.addModel('deepseek', name)).toThrow(expect.objectContaining({ code: 'invalid_input' }))
  })

  it('与已有模型只差大小写算重名', () => {
    expect(() => store.addModel('deepseek', 'DeepSeek-Flash')).toThrow(expect.objectContaining({ code: 'duplicate' }))
  })

  it('允许大写字母', () => {
    store.addModel('deepseek', 'MiniMax-M2')
    expect(store.readConfig().providers.deepseek.models.map((m) => m.name)).toContain('MiniMax-M2')
  })

  it.each(['deepseek', 'DeepSeek'])('与供应商同名 %j 被拒绝，文案「不能和供应商同名」', (name) => {
    expect(() => store.addModel('deepseek', name)).toThrow(expect.objectContaining({ code: 'invalid_input', message: '不能和供应商同名' }))
  })

  it('改名为供应商名同样被拒绝', () => {
    expect(() => store.updateModel('deepseek', 'deepseek-flash', { name: 'deepseek' })).toThrow(expect.objectContaining({ code: 'invalid_input' }))
    expect(store.readConfig().providers.deepseek.models[0].name).toBe('deepseek-flash')
  })

  it('新模型参数用预设默认值，改名即换 id', () => {
    store.addModel('deepseek', 'deepseek-v4-pro')
    const updated = store.updateModel('deepseek', 'deepseek-v4-pro', { name: 'deepseek-v4-pro-2' })
    expect(updated).toMatchObject({ id: 'deepseek-v4-pro-2', name: 'deepseek-v4-pro-2', effort: 'max' })
  })

  it('上限必须是正整数', () => {
    expect(() => store.updateModel('deepseek', 'deepseek-flash', { contextTokens: 0 })).toThrow(expect.objectContaining({ code: 'invalid_input' }))
    expect(store.updateModel('deepseek', 'deepseek-flash', { contextTokens: 1048576 })).toMatchObject({ contextTokens: 1048576 })
  })

  it('移除模型同时删掉它的状态文件', () => {
    store.addModel('deepseek', 'deepseek-v4-pro')
    store.writeStatus('deepseek', 'deepseek-v4-pro', { ok: true, source: 'test' })
    store.removeModel('deepseek', 'deepseek-v4-pro')
    expect(store.readConfig().providers.deepseek.models.map((m) => m.id)).toEqual(['deepseek-flash'])
    expect(fs.existsSync(path.join(sb.models, 'status', 'deepseek__deepseek-v4-pro.json'))).toBe(false)
    expect(store.readKey('deepseek')).toBe(KEY)
  })

  it('改名 A→B→A 后旧实例不算当前模型（Codex 审核第 2 轮 P2）', () => {
    const before = store.readConfig().providers.deepseek.models[0]
    store.updateModel('deepseek', 'deepseek-flash', { name: 'deepseek-v4-pro' })
    store.updateModel('deepseek', 'deepseek-v4-pro', { name: 'deepseek-flash' })
    expect(store.isCurrentModel('deepseek', before)).toBe(false)
    expect(store.isCurrentModel('deepseek', store.readConfig().providers.deepseek.models[0])).toBe(true)
  })

  it('输出上限最多 128,000；思考强度只收这家的三档（2026-09-27 实测后收紧）', () => {
    expect(() => store.updateModel('deepseek', 'deepseek-flash', { maxOutputTokens: 128001 })).toThrow(expect.objectContaining({ code: 'invalid_input', message: '最多 128,000' }))
    expect(store.updateModel('deepseek', 'deepseek-flash', { maxOutputTokens: 128000 })).toMatchObject({ maxOutputTokens: 128000 })
    for (const effort of ['medium', 'xhigh']) {
      expect(() => store.updateModel('deepseek', 'deepseek-flash', { effort })).toThrow(expect.objectContaining({ code: 'invalid_input' }))
    }
    expect(store.updateModel('deepseek', 'deepseek-flash', { effort: 'low' })).toMatchObject({ effort: 'low' })
  })
})


it('SC-016 TC-065 lastTest只有test更新，审核保留；保留现行顶层与runId', () => {
  const pass = store.writeStatus('deepseek', 'deepseek-flash', { ok: true, source: 'test', runId: 'test-run-1' })
  expect(pass.lastTest).toMatchObject({ ok: true, reason: null, at: pass.at })
  const review = store.writeStatus('deepseek', 'deepseek-flash', { ok: false, reason: 'balance', source: 'review', runId: 'review-run-2' })
  expect(review).toMatchObject({ ok: false, source: 'review', runId: 'review-run-2', lastTest: pass.lastTest })
  const fail = store.writeStatus('deepseek', 'deepseek-flash', { ok: false, reason: 'net', source: 'test' })
  expect(fail.lastTest).toMatchObject({ ok: false, reason: 'net', at: fail.at })
  const recovery = store.writeStatus('deepseek', 'deepseek-flash', { ok: true, source: 'review' })
  expect(recovery.lastTest).toEqual(fail.lastTest)
})
