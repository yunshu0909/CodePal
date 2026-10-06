/** @vitest-environment node
 * v2.1.17：给 dev 的公开文件从 review-models.json 换成审核配置 review-config.json（后-44）；
 * 只放审核需要的字段，不放本机命令路径与计费类别（后-49、后-51），接入模型带 provider
 */
import { afterEach, beforeEach, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { makeSandbox, KEY, waitFor } from './helpers'
const require = createRequire(import.meta.url)
const {
  registerModelsHandlers,
} = require('../../electron/modules/models/ipc.js')
const store = require('../../electron/modules/models/store.js')
const commands = require('../../electron/modules/models/commands.js')
let sb, original, handlers, lifecycle
const read = (name) =>
  JSON.parse(fs.readFileSync(path.join(sb.models, name), 'utf8'))
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
})
afterEach(() => {
  lifecycle?.stop()
  for (const [k, v] of Object.entries(original)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  sb.cleanup()
})
it('SC-009 TC-058 关闭即退出给 dev 的审核配置，偏好保留且无凭证', async () => {
  await call('models:hubList')
  expect(read('review-config.json').models).toHaveLength(1)
  const result = await call('models:hubSetEnabled', {
    id: 'deepseek:deepseek-flash',
    enabled: false,
  })
  expect(result.success).toBe(true)
  expect(read('review-config.json')).toMatchObject({
    schemaVersion: 1,
    models: [],
  })
  expect(read('hub.json').reviewEnabled['deepseek:deepseek-flash']).toBe(false)
  await call('models:hubSetEnabled', {
    id: 'deepseek:deepseek-flash',
    enabled: true,
  })
  const snapshot = read('review-config.json')
  expect(snapshot.models[0]).toEqual({
    id: 'deepseek:deepseek-flash',
    family: 'deepseek',
    runner: 'codepal',
    provider: 'deepseek',
    model: 'deepseek-flash',
    displayName: 'deepseek-flash',
    effort: 'max',
  })
  expect(snapshot.generator).toBe(
    `CodePal ${require('../../package.json').version}`,
  )
  expect(Number.isNaN(Date.parse(snapshot.generatedAt))).toBe(false)
  expect(JSON.stringify(snapshot)).not.toContain(KEY)
})
it('同家厂商身份来自真实预设；装了终端命令也不把本机路径写进审核配置；仅已测通且开启可用', async () => {
  await call('models:hubList')
  for (const id of ['zhipu-api', 'zhipu-coding']) {
    store.setKey(id, 'fake-plan-key')
    store.writeStatus(id, 'glm-5.3', { ok: true, source: 'test' })
  }
  await call('models:hubList')
  for (const id of ['zhipu-api', 'zhipu-coding'])
    await call('models:hubSetEnabled', { id: `${id}:glm-5.3`, enabled: true })
  await call('models:installCommands')
  const models = read('review-config.json').models
  expect(models.map((m) => m.provider)).toEqual([
    'deepseek',
    'zhipu-api',
    'zhipu-coding',
  ])
  expect(models.slice(1).map((m) => m.family)).toEqual(['zhipu', 'zhipu'])
  for (const m of models) {
    expect(m.command).toBeUndefined()
    expect(m.billing).toBeUndefined()
  }
  expect(JSON.stringify(read('review-config.json'))).not.toContain(sb.bin)
  store.writeStatus('zhipu-api', 'glm-5.3', { ok: false, source: 'test' })
  // 状态文件变化后主进程自己重新生成（打开页面只读）
  expect(await waitFor(() => read('review-config.json').models.length === 2)).toBe(true)
  expect(read('review-config.json').models.map((m) => m.provider)).toEqual([
    'deepseek',
    'zhipu-coding',
  ])
})
it('旧status仅顶层ok兼容；lastTest失败不能被审核成功冒充测通', async () => {
  await call('models:hubList')
  const status = path.join(store.statusDir(), 'deepseek__deepseek-flash.json')
  fs.writeFileSync(status, JSON.stringify({ ok: true, source: 'review' }))
  await call('models:hubList')
  expect(read('review-config.json').models).toHaveLength(1)
  store.writeStatus('deepseek', 'deepseek-flash', { ok: false, source: 'test' })
  store.writeStatus('deepseek', 'deepseek-flash', {
    ok: true,
    source: 'review',
  })
  // 状态文件变化后主进程自己重新生成（打开页面只读）
  expect(await waitFor(() => read('review-config.json').models.length === 0)).toBe(true)
})
