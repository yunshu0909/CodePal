/** @vitest-environment node
 * 使用隔离目录与真实 CLI 验证子进程参数和状态。
 * @module tests/models/providerLaunch.test
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { makeSandbox, runCli, readReport } from './helpers'
const require = createRequire(import.meta.url)
const { PRESETS } = require('../../electron/modules/models/presets.js')
const { buildLaunch } = require('../../electron/modules/models/launchEnv.js')
const store = require('../../electron/modules/models/store.js')
const ids = ['mimo-api', 'zhipu-api', 'kimi-api', 'zhipu-coding', 'kimi-coding']
let sb
beforeEach(() => {
  sb = makeSandbox()
  for (const [k, v] of Object.entries(sb.env)) vi.stubEnv(k, v)
})
afterEach(() => { vi.unstubAllEnvs(); sb.cleanup() })
describe('TC-003 CHANNEL_LAUNCH', () => {
  it.each(ids)('%s 默认与编辑参数进入真实 CLI 子进程；凭证不外泄', id => {
    expect(PRESETS[id], 'CHANNEL_LAUNCH').toBeDefined()
    const preset = PRESETS[id]
    const key = id === 'mimo-api' ? 'sk-fixture-launch' : `fixture-launch.${id}`
    store.setKey(id, key)
    const parent = {
      ...sb.env,
      ANTHROPIC_API_KEY: 'parent-api-secret', ANTHROPIC_AUTH_TOKEN: 'parent-auth-secret',
      CLAUDE_CODE_OAUTH_TOKEN: 'parent-oauth-secret', ANTHROPIC_BASE_URL: 'https://wrong.invalid',
      ANTHROPIC_MODEL: 'wrong', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'wrong', ANTHROPIC_SMALL_FAST_MODEL: 'wrong',
      HTTP_USER_AGENT: 'spoof', ANTHROPIC_CUSTOM_HEADERS: 'spoof', CLAUDE_CODE_DISABLE_THINKING: '1',
    }
    const original = { ...parent }
    const settings = path.join(sb.home, '.claude', 'settings.json')
    fs.mkdirSync(path.dirname(settings), { recursive: true })
    const globalSettings = '{"alwaysThinkingEnabled":false,"env":{"ANTHROPIC_MODEL":"global-original"}}'
    fs.writeFileSync(settings, globalSettings)
    let model = store.readConfig().providers[id].models[0]
    for (const edited of [false, true]) {
      if (edited) model = store.updateModel(id, model.id, { name: 'custom-model', contextTokens: 500000, maxOutputTokens: 16000, effort: 'high' })
      for (const mode of ['interactive', 'print']) {
        const launch = buildLaunch({ mode, preset, model, key, parentEnv: parent, userArgs: [], modelsHome: sb.models })
        expect(launch.env[preset.authEnv]).toBe(key)
        expect(launch.env[preset.authEnv === 'ANTHROPIC_API_KEY' ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY']).toBeUndefined()
        expect(launch.args.join(' ')).not.toContain(key)
        const overlay = JSON.parse(launch.args[1])
        expect(overlay.env).toMatchObject({ CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(model.contextTokens), CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(model.maxOutputTokens) })
        // v2.1.17：终端交互用模型接入的档位；后台只认传入的等级，没传不设
        expect(overlay.env.CLAUDE_CODE_EFFORT_LEVEL).toBe(mode === 'interactive' ? model.effort : undefined)
        if (id.startsWith('zhipu')) expect(overlay.alwaysThinkingEnabled).toBe(true)
      }
      for (const fakeMode of ['success', 'api401']) {
        const result = runCli(['launch', id, '@first', '--', '--print', '--output-format', 'json'], { env: { ...parent, FAKE_CLAUDE_MODE: fakeMode }, input: 'fixture' })
        expect(result.status).toBe(fakeMode === 'success' ? 0 : 1)
        const report = readReport(sb.report)
        expect(report.env.ANTHROPIC_BASE_URL).toBe(preset.baseUrl)
        expect(report.env.ANTHROPIC_MODEL).toBe(model.name)
        expect(report.envNames).toContain(preset.authEnv)
        for (const excluded of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_SMALL_FAST_MODEL', 'HTTP_USER_AGENT', 'ANTHROPIC_CUSTOM_HEADERS', 'CLAUDE_CODE_DISABLE_THINKING']) expect(report.envNames).not.toContain(excluded)
        for (const name of ['ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']) expect(report.env[name]).toBe(model.name)
        if (preset.authEnv === 'ANTHROPIC_AUTH_TOKEN') expect(report.tokenSha256).toBe(crypto.createHash('sha256').update(key).digest('hex'))
        const overlay = JSON.parse(report.argv[report.argv.indexOf('--settings') + 1])
        expect(overlay.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe(String(model.maxOutputTokens))
        const statuses = store.readStatuses()
        expect(statuses[`${id}__${model.id}`]).toMatchObject({ ok: fakeMode === 'success', reason: fakeMode === 'success' ? null : 'key' })
        expect(JSON.stringify({ result, report, statuses })).not.toContain(key)
      }
    }
    expect(parent).toEqual(original)
    expect(fs.readFileSync(settings, 'utf8')).toBe(globalSettings)
  })
  it('相同 GLM 模型的状态按 API 和套餐分开', () => {
    expect(PRESETS['zhipu-api'], 'CHANNEL_LAUNCH').toBeDefined()
    for (const [id, mode] of [['zhipu-api', 'success'], ['zhipu-coding', 'api401']]) {
      store.setKey(id, `fixture.${id}`)
      runCli(['launch', id, '@first', '--', '--print', '--output-format', 'json'], { env: { ...sb.env, FAKE_CLAUDE_MODE: mode } })
    }
    expect(store.readStatuses()['zhipu-api__glm-5.3'].ok).toBe(true)
    expect(store.readStatuses()['zhipu-coding__glm-5.3']).toMatchObject({ ok: false, reason: 'key' })
  })
})
