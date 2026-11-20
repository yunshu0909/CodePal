/**
 * @vitest-environment node
 *
 * 模型接入 · 后台模式去掉「模型名认不出」诊断行（问题池 #90）
 *
 * 负责：
 * - 用 Node 跑真实 cli.cjs + 替身 claude（替身按 Claude Code 2.1.325 原文写 [claude-code:unrecognized_model] 行）
 * - 只去掉 CodePal 这次配的模型名那一行；别的模型名的同类行、其他标准错误照常透传，顺序不变
 * - 分块到达也认得出；标准输出、退出码不变；「测一下」的失败原因不是这行
 * - 其余字节原样透传（不做编码转换）；已能确定不是要去掉的那行时立即透传，不等换行
 *
 * @module tests/models/unrecognizedModelLine.test
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { makeSandbox, runCli, spawnCli, KEY, CLI } from './helpers'

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

  it('其余字节原样透传，不是 UTF-8 的内容也不被改写', () => {
    const r = spawnSync(process.execPath, [CLI, ...L, ...PRINT], { env: env({ FAKE_CLAUDE_MODE: 'unrecognized-bytes' }), input: 'hi\n', timeout: 30000 })
    expect([...r.stderr]).toEqual([0x63, 0x61, 0x66, 0xe9, 0x0a, 0xff, 0xfe, 0x0a])
    expect(r.status).toBe(0)
  })

  it('别的模型名的整行先到、换行晚到：不等换行就透传', async () => {
    const child = spawnCli([...L, ...PRINT], { env: env({ FAKE_CLAUDE_MODE: 'unrecognized-late-newline' }) })
    const start = Date.now()
    let seenAt = null
    let text = ''
    child.stderr.on('data', (c) => {
      text += c.toString('utf8')
      if (seenAt === null && text.includes('some-typo-model')) seenAt = Date.now() - start
    })
    const code = await new Promise((resolve) => child.on('close', resolve))
    const doneAt = Date.now() - start
    expect(code).toBe(0)
    expect(text).toBe(`${MARK} {"model":"some-typo-model","query_source":"sdk"}\n`)
    expect(seenAt).not.toBeNull()
    expect(doneAt - seenAt).toBeGreaterThan(1000)
  })
})
