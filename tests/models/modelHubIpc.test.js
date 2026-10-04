/** @vitest-environment node */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { makeSandbox, KEY, waitFor } from './helpers'
const require = createRequire(import.meta.url)
const {
  registerModelsHandlers,
} = require('../../electron/modules/models/ipc.js')
const store = require('../../electron/modules/models/store.js')
let sb, handlers, lifecycle, original
function open() {
  handlers = {}
  lifecycle = registerModelsHandlers({
    ipcMain: {
      handle: (name, fn) => {
        handlers[name] = fn
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
async function call(channel, args) {
  expect(typeof handlers[channel]).toBe('function')
  return await handlers[channel]({}, args)
}
const read = (file) =>
  JSON.parse(fs.readFileSync(path.join(sb.models, file), 'utf8'))
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
it('SC-005 TC-054 启用真实IPC、校验ID和boolean、同步清单且无凭证', async () => {
  const off = await call('models:hubSetEnabled', {
    id: 'deepseek:deepseek-flash',
    enabled: false,
  })
  expect(off).toEqual({
    success: true,
    data: { id: 'deepseek:deepseek-flash', enabled: false },
    error: null,
  })
  const result = await call('models:hubSetEnabled', {
    id: 'deepseek:deepseek-flash',
    enabled: true,
  })
  expect(result.success).toBe(true)
  expect(read('hub.json').reviewEnabled['deepseek:deepseek-flash']).toBe(true)
  expect(read('review-models.json').models.map((m) => m.id)).toEqual([
    'deepseek:deepseek-flash',
  ])
  for (const args of [
    { id: '../../outside', enabled: true },
    { id: 'deepseek:deepseek-flash', enabled: 'true' },
    { id: 'codex:unknown', enabled: true },
  ]) {
    expect((await call('models:hubSetEnabled', args)).success).toBe(false)
  }
  const list = await call('models:hubList')
  expect(list.success).toBe(true)
  expect(JSON.stringify(list)).not.toContain(KEY)
  expect(
    list.data.vendors.find((v) => v.id === 'deepseek').models[0].enabled,
  ).toBe(true)
})
it('SC-016 测试状态变化无窗口也更新清单；审核失败仍留在可用列表', async () => {
  await call('models:hubList')
  store.writeStatus('deepseek', 'deepseek-flash', {
    ok: false,
    reason: 'balance',
    source: 'review',
  })
  expect(
    await waitFor(() => read('review-models.json').models.length === 1),
  ).toBe(true)
  store.writeStatus('deepseek', 'deepseek-flash', {
    ok: false,
    reason: 'net',
    source: 'test',
  })
  expect(
    await waitFor(() => read('review-models.json').models.length === 0),
  ).toBe(true)
  store.writeStatus('deepseek', 'deepseek-flash', { ok: true, source: 'test' })
  expect(
    await waitFor(() => read('review-models.json').models.length === 1),
  ).toBe(true)
  expect(
    (await call('models:hubList')).data.vendors.find((v) => v.id === 'deepseek')
      .models[0].enabled,
  ).toBe(true)
})
it('接入增删改名、Key与命令安装后都同步公开快照；stop取消未决刷新', async () => {
  await call('models:hubList')
  await call('models:installCommands')
  expect(path.isAbsolute(read('review-models.json').models[0].command)).toBe(
    true,
  )
  await call('models:updateModel', {
    providerId: 'deepseek',
    modelId: 'deepseek-flash',
    patch: { name: 'deepseek-new' },
  })
  expect(read('review-models.json').models).toEqual([])
  store.writeStatus('deepseek', 'deepseek-new', { ok: true, source: 'test' })
  await call('models:hubList')
  await call('models:hubSetEnabled', {
    id: 'deepseek:deepseek-new',
    enabled: true,
  })
  await call('models:removeModel', {
    providerId: 'deepseek',
    modelId: 'deepseek-new',
  })
  expect(read('review-models.json').models).toEqual([])
  await call('models:setKey', { providerId: 'mimo-api', key: KEY })
  expect(read('review-models.json').models).toEqual([])
  const before = fs.readFileSync(
    path.join(sb.models, 'review-models.json'),
    'utf8',
  )
  lifecycle.stop()
  await new Promise((r) => setTimeout(r, 180))
  expect(
    fs.readFileSync(path.join(sb.models, 'review-models.json'), 'utf8'),
  ).toBe(before)
})
