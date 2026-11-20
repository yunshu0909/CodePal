/**
 * @vitest-environment node
 *
 * 模型接入 · 后台模式去掉「模型名认不出」诊断行（问题池 #90）
 *
 * 负责：
 * - 用 Node 跑真实 cli.cjs + 替身 claude（替身按 Claude Code 2.1.325 原文写 [claude-code:unrecognized_model] 行）
 * - 只去掉 CodePal 这次配的模型名那一行；别的模型名的同类行、其他标准错误照常透传，顺序不变
 * - 分块到达也认得出；标准输出、退出码不变；「测一下」的失败原因不是这行
 *
 * @module tests/models/unrecognizedModelLine.test
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { makeSandbox, runCli, KEY } from './helpers'

const require = createRequire(import.meta.url)
const store = require('../../electron/modules/models/store.js')

const MARK = '[claude-code:unrecognized_model]'
const SUCCESS = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'CODEPAL_OK', session_id: 's1', num_turns: 1, modelUsage: { 'deepseek-flash': {} } })
const L = ['launch', 'deepseek', 'deepseek-flash']
const PRINT = ['--', '--print', '--output-format', 'json']

let sb
beforeEach(() => {
  sb = makeSandbox()
  process.env.CODEPAL_MODELS_HOME = sb.models
  store.setKey('deepseek', KEY)
})
afterEach(() => {
  delete process.env.CODEPAL_MODELS_HOME
  sb.cleanup()
})

const env = (extra = {}) => ({ ...sb.env, ...extra })

describe('#90 后台模式不再透传这次模型名的 unrecognized_model 行', () => {
  it('这次模型名的那行不出现；其他标准错误照常、顺序不变；标准输出与退出码不变', () => {
    const r = runCli([...L, ...PRINT], { env: env({ FAKE_CLAUDE_MODE: 'unrecognized' }), input: 'hi\n' })
    expect(r.stderr).not.toContain('"model":"deepseek-flash"')
    expect(r.stderr).toBe(`before line\n${MARK} {"model":"some-typo-model","query_source":"agent:helper"}\nafter line\n`)
    expect(r.stdout).toBe(SUCCESS)
    expect(r.status).toBe(0)
  })

  it('一行被拆成几块、隔一会儿才写完也照样去掉；不是这行的结尾照常透传', () => {
    const r = runCli([...L, ...PRINT], { env: env({ FAKE_CLAUDE_MODE: 'unrecognized-split' }), input: 'hi\n' })
    expect(r.stderr).not.toContain('unrecognized_model')
    expect(r.stderr).not.toContain('[claude-co')
    expect(r.stderr).toBe('tail without newline')
    expect(r.stdout).toBe(SUCCESS)
    expect(r.status).toBe(0)
  })

  it('「测一下」时只留下这行就失败：页面看到的原因不是这行', () => {
    runCli([...L, '--test'], { env: env({ FAKE_CLAUDE_MODE: 'unrecognized-fail', CODEPAL_RUN_ID: 'run-90' }) })
    const status = JSON.parse(fs.readFileSync(path.join(sb.models, 'status', 'deepseek__deepseek-flash.json'), 'utf8'))
    expect(status.ok).toBe(false)
    // 改前会显示这行（Key 打码规则把它截成「[claude-code:***] …」）；改后只剩退出码
    expect(status.message).toBe('退出码 1')
  })

  it('别家（智谱 API）走同一条路，同样去掉', () => {
    store.setKey('zhipu-api', 'fixture-launch.zhipu-api')
    const name = store.readConfig().providers['zhipu-api'].models[0].name
    const r = runCli(['launch', 'zhipu-api', '@first', ...PRINT], { env: env({ FAKE_CLAUDE_MODE: 'unrecognized' }), input: 'hi\n' })
    expect(r.stderr).not.toContain(`"model":"${name}"`)
    expect(r.stderr).toContain('before line\n')
    expect(r.stderr).toContain('after line\n')
    expect(r.status).toBe(0)
  })
})
