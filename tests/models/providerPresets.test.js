/** @vitest-environment node
 * 五渠道预设与凭证隔离。
 * @module tests/models/providerPresets.test
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { makeSandbox, CLI } from './helpers'
const require = createRequire(import.meta.url)
const { PRESETS } = require('../../electron/modules/models/presets.js')
const store = require('../../electron/modules/models/store.js')
const { registerModelsHandlers } = require('../../electron/modules/models/ipc.js')
const cases = [
  ['mimo-api', 'https://api.xiaomimimo.com/anthropic', 'ANTHROPIC_AUTH_TOKEN', 'mimo-v2.6-pro', 128000, ['high']],
  ['zhipu-api', 'https://open.bigmodel.cn/api/anthropic', 'ANTHROPIC_API_KEY', 'glm-5.3', 128000, ['low', 'high', 'max']],
  ['kimi-api', 'https://api.moonshot.cn/anthropic', 'ANTHROPIC_AUTH_TOKEN', 'kimi-k3', 32768, ['low', 'high', 'max']],
  ['zhipu-coding', 'https://open.bigmodel.cn/api/anthropic', 'ANTHROPIC_API_KEY', 'glm-5.3', 128000, ['low', 'high', 'max']],
  ['kimi-coding', 'https://api.kimi.com/coding/', 'ANTHROPIC_API_KEY', 'kimi-for-coding', 32768, ['low', 'high', 'max']],
]
let sb
beforeEach(() => {
  sb = makeSandbox()
  for (const [k, v] of Object.entries(sb.env)) vi.stubEnv(k, v)
})
afterEach(() => { vi.unstubAllEnvs(); sb.cleanup() })
describe('TC-001 FIVE_PROVIDERS', () => {
  it.each(cases)('%s 官方预设和独立 Key', (id, baseUrl, authEnv, defaultModel, maxOutputTokens, efforts) => {
    expect(PRESETS[id], 'FIVE_PROVIDERS').toBeDefined()
    expect(PRESETS[id]).toMatchObject({ baseUrl, authEnv, defaultModel, efforts })
    const key = id === 'mimo-api' ? 'sk-fixture-mimo' : `fixture.${id}`
    store.setKey(id, key)
    const model = store.readConfig().providers[id].models[0]
    expect(model).toMatchObject({ name: defaultModel, effort: 'high', contextTokens: 1048576, maxOutputTokens })
    expect(store.readKey(id)).toBe(key)
    expect(fs.statSync(path.join(sb.models, 'secrets', `${id}.key`)).mode & 0o777).toBe(0o600)
    for (const invalid of ['', ' ', `${key}\t`, `${key}\n`, `${key}\0`, `${key}\x7f`]) {
      expect(() => store.setKey(id, invalid)).toThrow()
      expect(store.readKey(id)).toBe(key)
    }
    if (id === 'mimo-api') expect(() => store.setKey(id, 'wrong-prefix')).toThrow()
  })
  it('所有 Key 互不覆盖，IPC 只回状态', async () => {
    expect(Object.keys(PRESETS), 'FIVE_PROVIDERS').toHaveLength(8)
    const handlers = {}
    const api = registerModelsHandlers({ ipcMain: { handle: (ch, fn) => { handlers[ch] = fn } }, getMainWindow: () => null, cliPath: CLI, appExecPath: process.execPath, loginPath: () => sb.bin })
    const keys = cases.map(([id]) => id === 'mimo-api' ? 'sk-fixture-mimo' : `fixture.${id}`)
    try {
      for (const [i, [id]] of cases.entries()) {
        const result = await handlers['models:setKey']({}, { providerId: id, key: keys[i] })
        expect(result.success).toBe(true)
        expect(JSON.stringify(result)).not.toContain(keys[i])
      }
      const result = await handlers['models:list']({})
      expect(Object.keys(result.data.providers)).toHaveLength(8)
      for (const [i, [id]] of cases.entries()) {
        expect(store.readKey(id)).toBe(keys[i])
        expect(JSON.stringify(result)).not.toContain(keys[i])
      }
    } finally { api.stop() }
  })
})


it('TC-001 MINIMAX_TC_001 MiniMax default models use separate private keys and IPC metadata', () => {
  expect(PRESETS['minimax-api'], 'MINIMAX_TC_001').toBeDefined()
  expect(Object.keys(PRESETS)).toEqual(['deepseek','mimo-api','zhipu-api','kimi-api','zhipu-coding','kimi-coding','minimax-api','minimax-plan'])
  for (const [id, name, effort] of [['minimax-api','MiniMax-M3',null],['minimax-plan','MiniMax-M3.1-Flash-Preview','max']]) {
    store.setKey(id, `fixture.${id}`)
    expect(store.readConfig().providers[id].models[0]).toMatchObject({name, effort, contextTokens:1000000,maxOutputTokens:128000})
    expect(store.readKey(id)).toBe(`fixture.${id}`)
    expect(fs.statSync(path.join(sb.models,'secrets',`${id}.key`)).mode & 0o777).toBe(0o600)
    expect(JSON.stringify(store.readConfig())).not.toContain(`fixture.${id}`)
  }
})
