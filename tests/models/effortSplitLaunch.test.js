/** @vitest-environment node
 * v2.1.16 · 强度拆分后，后台调用（-p）与「测一下」取强度的规则保持不变（TC-114）
 * 本任务不改 launchEnv：这两条路仍取模型接入（models.json）的强度；MiniMax 后台显式 --effort 仍按原规则覆盖
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

it('TC-114 汇总与接入强度不同时，后台调用和测一下仍用接入的强度；MiniMax 后台显式 --effort 仍覆盖', () => {
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
  expect(effortOf()).toBe('low')
  expect(runCli(['launch', 'deepseek', 'deepseek-flash', '--test'], { env: sb.env }).status).toBe(0)
  expect(effortOf()).toBe('low')
  expect(runCli(['launch', 'minimax-plan', flash, '--', '--print', '--output-format', 'json'], { env: sb.env }).status).toBe(0)
  expect(effortOf()).toBe('medium')
  expect(runCli(['launch', 'minimax-plan', flash, '--', '--print', '--effort', 'xhigh', '--output-format', 'json'], { env: sb.env }).status).toBe(0)
  expect(effortOf()).toBe('xhigh')
})
