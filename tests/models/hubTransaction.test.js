/** @vitest-environment node
 * v2.1.16 · 模型汇总保存失败时整体退回（TC-115）
 * 首次复制接入强度与这次保存算一件事：保存没成功，hub.json 回到操作前的字节，原本没有就仍然没有
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { makeSandbox, KEY } from './helpers'

const require = createRequire(import.meta.url)
const store = require('../../electron/modules/models/store.js')
const { createModelHub } = require('../../electron/modules/models/hub.js')
let sb
const file = (name) => path.join(sb.models, name)
const hub = () => createModelHub({ homeDir: sb.home, env: sb.env, locateClaude: () => null, locateCodex: () => null })
const OLD_HUB = JSON.stringify({ schemaVersion: 1, initializedAt: '2026-10-04T04:00:00.000Z', reviewEnabled: { 'deepseek:deepseek-flash': true }, effort: {} })

function denyPublicRename() {
  const rename = fs.renameSync
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (to === file('review-models.json')) {
      const e = new Error('test write denied')
      e.code = 'EACCES'
      throw e
    }
    return rename(from, to)
  })
}

beforeEach(() => {
  sb = makeSandbox()
  for (const [k, v] of Object.entries(sb.env)) vi.stubEnv(k, v)
  store.setKey('deepseek', KEY)
  store.writeStatus('deepseek', 'deepseek-flash', { ok: true, source: 'test' })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  sb.cleanup()
})

it('TC-115 还没补抄过的 hub.json：非法强度、开关或强度保存时清单写失败，hub.json 都逐字节不变', () => {
  fs.writeFileSync(file('hub.json'), OLD_HUB)
  const config = fs.readFileSync(file('models.json'), 'utf8')
  expect(() => hub().setEffort({ id: 'deepseek:deepseek-flash', effort: 'ultra' })).toThrow('思考强度不对')
  expect(fs.readFileSync(file('hub.json'), 'utf8')).toBe(OLD_HUB)
  denyPublicRename()
  expect(() => hub().setEffort({ id: 'deepseek:deepseek-flash', effort: 'low' })).toThrow('test write denied')
  expect(fs.readFileSync(file('hub.json'), 'utf8')).toBe(OLD_HUB)
  expect(() => hub().setEnabled({ id: 'deepseek:deepseek-flash', enabled: false })).toThrow('test write denied')
  expect(fs.readFileSync(file('hub.json'), 'utf8')).toBe(OLD_HUB)
  expect(fs.readFileSync(file('models.json'), 'utf8')).toBe(config)
  expect(fs.existsSync(file('review-models.json'))).toBe(false)
})

it('TC-115 原本没有 hub.json：保存失败后仍然没有；找不到的模型也不留下文件', () => {
  expect(() => hub().setEffort({ id: 'deepseek:deepseek-flash', effort: 'ultra' })).toThrow('思考强度不对')
  expect(fs.existsSync(file('hub.json'))).toBe(false)
  expect(() => hub().setEnabled({ id: 'deepseek:nope', enabled: true })).toThrow('没有这个模型')
  expect(fs.existsSync(file('hub.json'))).toBe(false)
  denyPublicRename()
  expect(() => hub().setEffort({ id: 'deepseek:deepseek-flash', effort: 'low' })).toThrow('test write denied')
  expect(fs.existsSync(file('hub.json'))).toBe(false)
  vi.restoreAllMocks()
  expect(hub().setEffort({ id: 'deepseek:deepseek-flash', effort: 'low' })).toEqual({ id: 'deepseek:deepseek-flash', effort: 'low' })
  expect(JSON.parse(fs.readFileSync(file('hub.json'), 'utf8')).effort['deepseek:deepseek-flash']).toBe('low')
})
