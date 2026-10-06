/** @vitest-environment node
 * v2.1.17：给 dev 的公开文件换成审核配置 review-config.json；页面读取不写设置，接入模型首次出现时抄等级改在
 * 启动对账与模型接入事件后做（A-014、后-08）
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { makeSandbox, KEY } from './helpers'
const require = createRequire(import.meta.url)
const {
  registerModelsHandlers,
} = require('../../electron/modules/models/ipc.js')
const store = require('../../electron/modules/models/store.js')
let sb, original, handlers, lifecycle
const file = (name) => path.join(sb.models, name)
const read = (name) => JSON.parse(fs.readFileSync(file(name), 'utf8'))
function open() {
  handlers = {}
  lifecycle = registerModelsHandlers({
    ipcMain: {
      handle: (ch, fn) => {
        handlers[ch] = fn
      },
    },
    getMainWindow: () => null,
    loginPath: () => sb.bin,
    hubOptions: {
      homeDir: sb.home,
      locateClaude: () => null,
      locateCodex: () => null,
    },
  })
}
async function call(ch, args) {
  expect(typeof handlers[ch]).toBe('function')
  return await handlers[ch]({}, args)
}
beforeEach(() => {
  sb = makeSandbox()
  original = Object.fromEntries(
    Object.keys(sb.env).map((k) => [k, process.env[k]]),
  )
  Object.assign(process.env, sb.env)
  store.setKey('deepseek', KEY)
  store.writeStatus('deepseek', 'deepseek-flash', { ok: true, source: 'test' })
  open()
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
it('SC-007 TC-056 保存清单失败恢复旧偏好和旧快照；真实错误返回原文', async () => {
  await call('models:hubList')
  const before = fs.readFileSync(file('hub.json'), 'utf8')
  const publicBefore = fs.readFileSync(file('review-config.json'), 'utf8')
  denyPublicRename()
  const result = await call('models:hubSetEnabled', {
    id: 'deepseek:deepseek-flash',
    enabled: false,
  })
  expect(result).toMatchObject({
    success: false,
    error: {
      code: 'write_denied',
      message: '配置目录没有写入权限，检查权限后重试',
    },
  })
  expect(fs.readFileSync(file('hub.json'), 'utf8')).toBe(before)
  expect(fs.readFileSync(file('review-config.json'), 'utf8')).toBe(publicBefore)
  expect(fs.readdirSync(sb.models).some((n) => n.endsWith('.tmp'))).toBe(false)
})
it('SC-011 TC-060 合法全关闭不是首次状态，重启不自动开启；0600/0644', async () => {
  expect(
    (
      await call('models:hubSetEnabled', {
        id: 'deepseek:deepseek-flash',
        enabled: false,
      })
    ).success,
  ).toBe(true)
  expect(read('review-config.json').models).toEqual([])
  const initializedAt = read('hub.json').initializedAt
  lifecycle.stop()
  open()
  await call('models:hubList')
  expect(read('hub.json')).toMatchObject({
    schemaVersion: 1,
    initializedAt,
    reviewEnabled: { 'deepseek:deepseek-flash': false },
  })
  expect(read('review-config.json').models).toEqual([])
  expect(fs.statSync(file('hub.json')).mode & 0o777).toBe(0o600)
  expect(fs.statSync(file('review-config.json')).mode & 0o777).toBe(0o644)
})
it('TC-101 汇总改接入模型强度只写hub.json；公开写失败逐字节恢复hub.json与清单', async () => {
  await call('models:hubList')
  const hubBefore = fs.readFileSync(file('hub.json'), 'utf8')
  const configBefore = fs.readFileSync(file('models.json'), 'utf8')
  const publicBefore = fs.readFileSync(file('review-config.json'), 'utf8')
  denyPublicRename()
  const result = await call('models:hubSetEffort', {
    id: 'deepseek:deepseek-flash',
    effort: 'low',
  })
  expect(result.success).toBe(false)
  expect(fs.readFileSync(file('hub.json'), 'utf8')).toBe(hubBefore)
  expect(fs.readFileSync(file('models.json'), 'utf8')).toBe(configBefore)
  expect(fs.readFileSync(file('review-config.json'), 'utf8')).toBe(publicBefore)
  vi.restoreAllMocks()
  expect(
    (
      await call('models:hubSetEffort', {
        id: 'deepseek:deepseek-flash',
        effort: 'low',
      })
    ).success,
  ).toBe(true)
  expect(fs.readFileSync(file('models.json'), 'utf8')).toBe(configBefore)
  expect(read('hub.json').effort['deepseek:deepseek-flash']).toBe('low')
  expect(read('review-config.json').models[0].effort).toBe('low')
})
it('坏hub不覆盖；修好后可重读，异常形状也算坏文件', async () => {
  for (const contents of [
    '{broken',
    '{"schemaVersion":1,"reviewEnabled":null,"effort":{}}',
    '[]',
  ]) {
    fs.writeFileSync(file('hub.json'), contents)
    expect(await call('models:hubList')).toMatchObject({
      success: false,
      error: { code: 'HUB_FILE_INVALID' },
    })
    expect(fs.readFileSync(file('hub.json'), 'utf8')).toBe(contents)
  }
  fs.rmSync(file('hub.json'))
  expect((await call('models:hubList')).success).toBe(true)
})

it('TC-101 第三方强度写hub.json并更新清单，models.json不变；非法值保持所有原文件', async () => {
  await call('models:hubList')
  const configBefore = fs.readFileSync(file('models.json'), 'utf8')
  expect((await call('models:hubSetEffort', { id: 'deepseek:deepseek-flash', effort: 'low' })).success).toBe(true)
  expect(fs.readFileSync(file('models.json'), 'utf8')).toBe(configBefore)
  expect(store.readConfig().providers.deepseek.models[0].effort).toBe('max')
  expect(read('hub.json').effort['deepseek:deepseek-flash']).toBe('low')
  expect(read('review-config.json').models.find((m) => m.id === 'deepseek:deepseek-flash').effort).toBe('low')
  const before = Object.fromEntries(['hub.json', 'models.json', 'review-config.json'].map((name) => [name, fs.readFileSync(file(name), 'utf8')]))
  expect((await call('models:hubSetEffort', { id: 'deepseek:deepseek-flash', effort: 'ultra' })).success).toBe(false)
  for (const [name, contents] of Object.entries(before)) expect(fs.readFileSync(file(name), 'utf8')).toBe(contents)
})

it('TC-102 首次拆分把接入现值抄进hub.json，审核清单值不变；之后接入改强度，汇总与清单不跟', async () => {
  // 模拟升级前：汇总还没见过这个模型，接入页的强度是 high
  lifecycle.stop()
  fs.rmSync(file('hub.json'), { force: true })
  store.updateModel('deepseek', 'deepseek-flash', { effort: 'high' })
  open()
  const list = await call('models:hubList')
  const row = () => list.data.vendors.find((v) => v.id === 'deepseek').models[0]
  expect(row().effort).toBe('high')
  expect(read('hub.json').effort['deepseek:deepseek-flash']).toBe('high')
  expect(read('review-config.json').models.find((m) => m.id === 'deepseek:deepseek-flash').effort).toBe('high')
  const updated = await call('models:updateModel', { providerId: 'deepseek', modelId: 'deepseek-flash', patch: { effort: 'low' } })
  expect(updated.success).toBe(true)
  expect(store.readConfig().providers.deepseek.models[0].effort).toBe('low')
  expect(read('hub.json').effort['deepseek:deepseek-flash']).toBe('high')
  expect(read('review-config.json').models.find((m) => m.id === 'deepseek:deepseek-flash').effort).toBe('high')
  const again = await call('models:hubList')
  expect(again.data.vendors.find((v) => v.id === 'deepseek').models[0].effort).toBe('high')
})

it('TC-102 旧版本建的hub.json没有接入模型强度：补抄现值，已有开关保留', async () => {
  const initializedAt = '2026-10-04T04:00:00.000Z'
  fs.mkdirSync(sb.models, { recursive: true })
  fs.writeFileSync(file('hub.json'), JSON.stringify({ schemaVersion: 1, initializedAt, reviewEnabled: { 'deepseek:deepseek-flash': true }, effort: {} }))
  // 升级后第一次启动：启动对账补抄接入现值
  lifecycle.stop()
  open()
  expect((await call('models:hubList')).success).toBe(true)
  expect(read('hub.json')).toMatchObject({
    schemaVersion: 1,
    initializedAt,
    reviewEnabled: { 'deepseek:deepseek-flash': true },
    effort: { 'deepseek:deepseek-flash': 'max' },
  })
  expect(read('review-config.json').models.find((m) => m.id === 'deepseek:deepseek-flash').effort).toBe('max')
})

it('TC-113 启动时审核配置写不进去：hub.json 只补第一次的顺序与等级、models.json 不变，页面读取照常，规则页报写不进去', async () => {
  lifecycle.stop()
  const oldHub = JSON.stringify({ schemaVersion: 1, initializedAt: '2026-10-04T04:00:00.000Z', reviewEnabled: { 'deepseek:deepseek-flash': true }, effort: {} })
  fs.writeFileSync(file('hub.json'), oldHub)
  const configBefore = fs.readFileSync(file('models.json'), 'utf8')
  // 审核配置没了（或和设置对不上），启动时一定要重新生成，这时写不进去
  fs.rmSync(file('review-config.json'))
  denyPublicRename()
  open()
  expect((await call('models:hubList')).success).toBe(true)
  expect(read('hub.json')).toMatchObject({ reviewEnabled: { 'deepseek:deepseek-flash': true }, order: ['deepseek:deepseek-flash'], effort: { 'deepseek:deepseek-flash': 'max' } })
  expect(fs.readFileSync(file('models.json'), 'utf8')).toBe(configBefore)
  expect(fs.existsSync(file('review-config.json'))).toBe(false)
  expect((await call('models:rulesGet')).data.exportOk).toBe(false)
  vi.restoreAllMocks()
  expect((await call('models:configRepublish')).data).toEqual({ exportOk: true })
  expect(read('review-config.json').models.find((m) => m.id === 'deepseek:deepseek-flash').effort).toBe('max')
})
