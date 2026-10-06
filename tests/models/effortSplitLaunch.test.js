/** @vitest-environment node
 * v2.1.16 · 强度拆分（TC-114）；v2.1.17 起（A-013、后-29）：后台调用（-p）只认调用方传进来的 --effort，
 * 不传就不设；「测一下」由 CodePal 把模型接入（models.json）的档位作为 --effort 传进去；汇总页的审核等级不进启动参数
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { makeSandbox, runCli, readReport, KEY } from './helpers'

const require = createRequire(import.meta.url)
const store = require('../../electron/modules/models/store.js')
const { createModelHub } = require('../../electron/modules/models/hub.js')
let sb

beforeEach(() => {
  sb = makeSandbox()
  for (const [k, v] of Object.entries(sb.env)) vi.stubEnv(k, v)
})
afterEach(() => { vi.unstubAllEnvs(); sb.cleanup() })

const effortOf = () => {
  const argv = readReport(sb.report).argv
  return JSON.parse(argv[argv.indexOf('--settings') + 1]).env.CLAUDE_CODE_EFFORT_LEVEL
}
const passedEffort = () => {
  const argv = readReport(sb.report).argv
  const at = argv.indexOf('--effort')
  return at === -1 ? undefined : argv[at + 1]
}

it('TC-114 汇总与接入强度不同时：后台调用只认传入的、不传不设；测一下传模型接入的强度；汇总的审核等级不进启动参数', () => {
  store.setKey('deepseek', KEY)
  store.setKey('minimax-plan', 'fixture.minimax-plan')
  const flash = 'MiniMax-M3.1-Flash-Preview'
  for (const [id, model] of [['deepseek', 'deepseek-flash'], ['minimax-plan', flash]]) store.writeStatus(id, model, { ok: true, source: 'test' })
  const hub = createModelHub({ homeDir: sb.home, env: sb.env, locateClaude: () => null, locateCodex: () => null })
  hub.list()
  // 先在汇总改审核强度，再在接入页改终端强度：两边最后不同
  hub.setEffort({ id: 'deepseek:deepseek-flash', effort: 'max' })
  hub.setEffort({ id: `minimax-plan:${flash}`, effort: 'high' })
  store.updateModel('deepseek', 'deepseek-flash', { effort: 'low' })
  store.updateModel('minimax-plan', flash, { effort: 'medium' })

  expect(runCli(['launch', 'deepseek', 'deepseek-flash', '--', '--print', '--output-format', 'json'], { env: sb.env }).status).toBe(0)
  expect(effortOf()).toBeUndefined()
  expect(passedEffort()).toBeUndefined()
  expect(runCli(['launch', 'deepseek', 'deepseek-flash', '--test'], { env: sb.env }).status).toBe(0)
  expect(effortOf()).toBeUndefined()
  expect(passedEffort()).toBe('low')
  expect(runCli(['launch', 'minimax-plan', flash, '--', '--print', '--output-format', 'json'], { env: sb.env }).status).toBe(0)
  expect(effortOf()).toBeUndefined()
  expect(passedEffort()).toBeUndefined()
  expect(runCli(['launch', 'minimax-plan', flash, '--', '--print', '--effort', 'xhigh', '--output-format', 'json'], { env: sb.env }).status).toBe(0)
  expect(effortOf()).toBeUndefined()
  expect(passedEffort()).toBe('xhigh')
})
