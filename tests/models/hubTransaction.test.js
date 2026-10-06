/** @vitest-environment node
 * v2.1.16 · 模型汇总保存失败时整体退回（TC-115）；v2.1.17 起：
 * - 保存两步（先写 hub.json，再生成给 dev 的审核配置 review-config.json），第二步失败 hub.json 回到这次保存前的字节
 * - 第一次打开（没有 hub.json，或旧版 hub.json 没有顺序）写初始开关与顺序是单独的一步（A-016），不随这次保存失败撤回
 * - 文件错误翻成「配置目录没有写入权限」
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
const OLD_HUB = JSON.stringify({ schemaVersion: 1, initializedAt: '2026-10-04T04:00:00.000Z', reviewEnabled: { 'deepseek:deepseek-flash': true }, effort: {}, order: ['deepseek:deepseek-flash'] })
const DENIED = '配置目录没有写入权限，检查权限后重试'

function denyPublicRename() {
  const rename = fs.renameSync
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (to === file('review-config.json')) {
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

it('TC-115 还没补抄过的 hub.json：非法强度、开关或强度保存时审核配置写失败，hub.json 都逐字节不变', () => {
  fs.writeFileSync(file('hub.json'), OLD_HUB)
  const config = fs.readFileSync(file('models.json'), 'utf8')
  expect(() => hub().setEffort({ id: 'deepseek:deepseek-flash', effort: 'ultra' })).toThrow('思考强度不对')
  expect(fs.readFileSync(file('hub.json'), 'utf8')).toBe(OLD_HUB)
  denyPublicRename()
  expect(() => hub().setEffort({ id: 'deepseek:deepseek-flash', effort: 'low' })).toThrow(DENIED)
  expect(fs.readFileSync(file('hub.json'), 'utf8')).toBe(OLD_HUB)
  expect(() => hub().setEnabled({ id: 'deepseek:deepseek-flash', enabled: false })).toThrow(DENIED)
  expect(fs.readFileSync(file('hub.json'), 'utf8')).toBe(OLD_HUB)
  expect(fs.readFileSync(file('models.json'), 'utf8')).toBe(config)
  expect(fs.existsSync(file('review-config.json'))).toBe(false)
})

it('TC-115 原本没有 hub.json：第一次打开写下初始设置；之后非法输入、找不到的模型、写失败都不改它', () => {
  expect(() => hub().setEffort({ id: 'deepseek:deepseek-flash', effort: 'ultra' })).toThrow('思考强度不对')
  const initial = fs.readFileSync(file('hub.json'), 'utf8')
  expect(JSON.parse(initial)).toMatchObject({ reviewEnabled: { 'deepseek:deepseek-flash': true }, effort: {}, order: ['deepseek:deepseek-flash'] })
  expect(() => hub().setEnabled({ id: 'deepseek:nope', enabled: true })).toThrow('没有这个模型')
  expect(fs.readFileSync(file('hub.json'), 'utf8')).toBe(initial)
  denyPublicRename()
  expect(() => hub().setEffort({ id: 'deepseek:deepseek-flash', effort: 'low' })).toThrow(DENIED)
  expect(fs.readFileSync(file('hub.json'), 'utf8')).toBe(initial)
  vi.restoreAllMocks()
  expect(hub().setEffort({ id: 'deepseek:deepseek-flash', effort: 'low' })).toEqual({ id: 'deepseek:deepseek-flash', effort: 'low' })
  expect(JSON.parse(fs.readFileSync(file('hub.json'), 'utf8')).effort['deepseek:deepseek-flash']).toBe('low')
})
