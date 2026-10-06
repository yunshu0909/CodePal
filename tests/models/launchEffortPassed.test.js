/** @vitest-environment node
 * v2.1.17 · 所有接入渠道后台调用只认调用方传进来的思考等级（A-013、后-29）
 * - 后台模式：传了 --effort 就只用它（按模型能力校验，非法拒绝）；没传就不设，不再把模型接入里的档位塞进覆盖设置
 * - 终端交互模式照旧用模型接入的档位（终端手动用）
 * - 「测一下」由 CodePal 自己把模型接入的档位作为 --effort 传进去，有档位才传
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { makeSandbox, runCli, readReport, KEY } from './helpers'

const require = createRequire(import.meta.url)
const store = require('../../electron/modules/models/store.js')
const { buildLaunch } = require('../../electron/modules/models/launchEnv.js')
const { PRESETS } = require('../../electron/modules/models/presets.js')

let sb
beforeEach(() => {
  sb = makeSandbox()
  for (const [k, v] of Object.entries(sb.env)) vi.stubEnv(k, v)
})
afterEach(() => {
  vi.unstubAllEnvs()
  sb.cleanup()
})

const overlayOf = (args) => JSON.parse(args[args.indexOf('--settings') + 1])
const reportArgs = () => readReport(sb.report).argv
const launch = (mode, presetId, model, userArgs) =>
  buildLaunch({
    mode,
    preset: PRESETS[presetId],
    model,
    key: KEY,
    parentEnv: {},
    userArgs,
    modelsHome: sb.models,
  })
const deepseek = { name: 'deepseek-flash', effort: 'low', contextTokens: 1000000, maxOutputTokens: 128000 }
const m3 = { name: 'MiniMax-M3', effort: 'high', contextTokens: 204800, maxOutputTokens: 65536 }

it('SC-021 后台模式传了 --effort：只用传进来的等级，覆盖设置里不再带模型接入的档位', () => {
  const { args } = launch('print', 'deepseek', deepseek, ['--print', '--effort', 'max'])
  expect(overlayOf(args).env.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined()
  expect(args.slice(args.indexOf('--effort'), args.indexOf('--effort') + 2)).toEqual(['--effort', 'max'])
  const eq = launch('print', 'deepseek', deepseek, ['--print', '--effort=high'])
  expect(overlayOf(eq.args).env.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined()
  expect(eq.args).toContain('--effort=high')
})

it('SC-021 后台模式没传 --effort：不设任何等级', () => {
  const { args } = launch('print', 'deepseek', deepseek, ['--print', '--output-format', 'json'])
  expect(overlayOf(args).env.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined()
  expect(args.some((a) => a === '--effort' || a.startsWith('--effort='))).toBe(false)
})

it('SC-021 后台模式传了这个模型不支持的等级、或给没有档位的模型传等级：拒绝，不启动', () => {
  for (const [presetId, model, value] of [
    ['deepseek', deepseek, 'xhigh'],
    ['deepseek', deepseek, 'ultra'],
    ['minimax-plan', m3, 'high'],
  ]) {
    let error
    try {
      launch('print', presetId, model, ['--print', '--effort', value])
    } catch (caught) {
      error = caught
    }
    expect(error, `${presetId} ${value}`).toBeDefined()
    expect(error.code).toBe('invalid_input')
  }
  // 重复传两次也拒绝
  let twice
  try {
    launch('print', 'deepseek', deepseek, ['--print', '--effort', 'low', '--effort', 'max'])
  } catch (caught) {
    twice = caught
  }
  expect(twice?.code).toBe('invalid_input')
})

it('SC-021 终端交互模式照旧用模型接入的档位；没有档位的模型不设', () => {
  const { args } = launch('interactive', 'deepseek', deepseek, [])
  expect(overlayOf(args).env.CLAUDE_CODE_EFFORT_LEVEL).toBe('low')
  const none = launch('interactive', 'minimax-plan', m3, [])
  expect(overlayOf(none.args).env.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined()
})

it('SC-021 测一下由 CodePal 把模型接入的档位明确传进去；后台调用不传就不设', () => {
  store.setKey('deepseek', KEY)
  store.updateModel('deepseek', 'deepseek-flash', { effort: 'low' })
  expect(runCli(['launch', 'deepseek', 'deepseek-flash', '--test'], { env: sb.env }).status).toBe(0)
  let args = reportArgs()
  expect(overlayOf(args).env.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined()
  expect(args.slice(args.indexOf('--effort'), args.indexOf('--effort') + 2)).toEqual(['--effort', 'low'])

  expect(runCli(['launch', 'deepseek', 'deepseek-flash', '--', '--print', '--output-format', 'json'], { env: sb.env }).status).toBe(0)
  args = reportArgs()
  expect(overlayOf(args).env.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined()
  expect(args.includes('--effort')).toBe(false)

  expect(runCli(['launch', 'deepseek', 'deepseek-flash', '--', '--print', '--effort', 'max', '--output-format', 'json'], { env: sb.env }).status).toBe(0)
  args = reportArgs()
  expect(args.slice(args.indexOf('--effort'), args.indexOf('--effort') + 2)).toEqual(['--effort', 'max'])
  expect(overlayOf(args).env.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined()

  // 非法等级：命令行报错退出，不启动 claude
  const before = readReport(sb.report)
  const bad = runCli(['launch', 'deepseek', 'deepseek-flash', '--', '--print', '--effort', 'ultra'], { env: sb.env })
  expect(bad.status).not.toBe(0)
  expect(readReport(sb.report)).toEqual(before)
})
