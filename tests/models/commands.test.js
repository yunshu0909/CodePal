/**
 * @vitest-environment node
 *
 * 模型接入 · 终端命令（4-test-cases.md 模块 F 的命令部分）
 *
 * 负责：
 * - 命令文件内容、单引号转义、权限、不覆盖别人的文件
 * - 每家稳定入口 codepal-<供应商>（@first）与改名、移除时的同步
 * - 命令指向的 CodePal 路径失效时报 stale
 *
 * @module tests/models/commands.test
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { makeSandbox, readReport, REPO, KEY } from './helpers'

const require = createRequire(import.meta.url)
const store = require('../../electron/modules/models/store.js')
const commands = require('../../electron/modules/models/commands.js')

const APP = '/Applications/CodePal.app/Contents/MacOS/CodePal'
const CLIP = '/Applications/CodePal.app/Contents/Resources/app.asar.unpacked/electron/modules/models/cli.cjs'
let sb
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')

beforeEach(() => {
  sb = makeSandbox()
  process.env.CODEPAL_MODELS_HOME = sb.models
  process.env.CODEPAL_BIN_DIR = sb.bin
  store.setKey('deepseek', KEY)
})
afterEach(() => {
  delete process.env.CODEPAL_MODELS_HOME
  delete process.env.CODEPAL_BIN_DIR
  sb.cleanup()
})

describe('模块 F · 终端命令', () => {
  it('TC-F01 命令内容、引号与权限', () => {
    const r = commands.installCommands({ appExecPath: APP, cliPath: CLIP })
    expect(r.installed.sort()).toEqual(['codepal-deepseek', 'codepal-deepseek-flash'])
    const f = path.join(sb.bin, 'codepal-deepseek-flash')
    const p = path.join(sb.bin, 'codepal-deepseek')
    expect(fs.statSync(f).mode & 0o777).toBe(0o755)
    expect(fs.statSync(p).mode & 0o777).toBe(0o755)
    expect(fs.statSync(sb.bin).mode & 0o777).toBe(0o755)
    const lines = fs.readFileSync(f, 'utf8').split('\n')
    expect(lines[0]).toBe('#!/bin/sh')
    expect(lines[1].startsWith(commands.GENERATED_MARK)).toBe(true)
    expect(lines[2]).toBe(`ELECTRON_RUN_AS_NODE=1 exec '${APP}' '${CLIP}' launch deepseek deepseek-flash -- "$@"`)
    expect(fs.readFileSync(f, 'utf8')).not.toContain('sk-test')
    expect(fs.readFileSync(p, 'utf8').split('\n')[2]).toBe(`ELECTRON_RUN_AS_NODE=1 exec '${APP}' '${CLIP}' launch deepseek @first -- "$@"`)
    expect(store.readConfig().commandsInstalled).toBe(true)
  })

  it('TC-F02 不覆盖别人的同名文件', () => {
    fs.mkdirSync(sb.bin, { recursive: true })
    const f = path.join(sb.bin, 'codepal-deepseek-flash')
    fs.writeFileSync(f, '#!/bin/sh\necho mine\n')
    const before = sha(f)
    // 报错里的目录按显示规则写：在家目录下写成 ~ 开头（真实环境是 ~/.local/bin）。
    // 临时目录可能在家目录下（例如合并后复查把临时目录放在代码仓里），所以按同一规则算预期，不写死绝对路径
    const home = os.homedir()
    const shown = sb.bin.startsWith(home + path.sep) ? '~' + sb.bin.slice(home.length) : sb.bin
    expect(() => commands.installCommands({ appExecPath: APP, cliPath: CLIP })).toThrow(expect.objectContaining({ code: 'occupied', message: `安装失败：${shown}/codepal-deepseek-flash 已被别的程序占用` }))
    expect(sha(f)).toBe(before)
  })

  it('TC-F03 / F04 移除模型删命令，新加模型自动生成', () => {
    commands.installCommands({ appExecPath: APP, cliPath: CLIP })
    store.addModel('deepseek', 'deepseek-v4-pro')
    commands.syncCommands()
    expect(fs.statSync(path.join(sb.bin, 'codepal-deepseek-v4-pro')).mode & 0o777).toBe(0o755)
    const flashBefore = sha(path.join(sb.bin, 'codepal-deepseek-flash'))
    store.removeModel('deepseek', 'deepseek-v4-pro')
    commands.syncCommands()
    expect(fs.existsSync(path.join(sb.bin, 'codepal-deepseek-v4-pro'))).toBe(false)
    expect(sha(path.join(sb.bin, 'codepal-deepseek-flash'))).toBe(flashBefore)
  })

  it('没装过命令时 sync 不写任何文件', () => {
    commands.syncCommands()
    expect(fs.existsSync(sb.bin)).toBe(false)
  })

  it('TC-F07 已安装命令时改名：删旧命令、生成新命令', () => {
    commands.installCommands({ appExecPath: APP, cliPath: CLIP })
    store.updateModel('deepseek', 'deepseek-flash', { name: 'deepseek-v4-pro' })
    commands.syncCommands()
    expect(fs.existsSync(path.join(sb.bin, 'codepal-deepseek-flash'))).toBe(false)
    expect(fs.readFileSync(path.join(sb.bin, 'codepal-deepseek-v4-pro'), 'utf8')).toContain('launch deepseek deepseek-v4-pro')
  })

  it('TC-F08 命令指向的 CodePal 路径不存在时报 stale，重装后恢复', () => {
    commands.installCommands({ appExecPath: '/nonexistent/CodePal', cliPath: CLIP })
    let st = commands.commandsState({ pathEnv: sb.bin })
    expect(st.stale).toBe(true)
    expect(st.missing).toContain('deepseek-flash')
    commands.installCommands({ appExecPath: process.execPath, cliPath: path.join(REPO, 'electron/modules/models/cli.cjs') })
    st = commands.commandsState({ pathEnv: sb.bin })
    expect(st.stale).toBe(false)
    expect(st.missing).toEqual([])
  })

  it('commandsState：没安装时列出缺命令的模型；onPath 看 PATH 里有没有命令目录', () => {
    const st = commands.commandsState({ pathEnv: '/usr/bin:/bin' })
    expect(st).toMatchObject({ installed: false, missing: ['deepseek-flash'], onPath: false })
    expect(commands.commandsState({ pathEnv: `/usr/bin:${sb.bin}` }).onPath).toBe(true)
  })

  it('TC-F12 路径里的 $() 与反引号不会被执行', () => {
    const weird = path.join(sb.root, "a$(touch pwned)`b'c")
    fs.mkdirSync(weird)
    fs.cpSync(path.join(REPO, 'electron/modules/models'), weird, { recursive: true })
    commands.installCommands({ appExecPath: process.execPath, cliPath: path.join(weird, 'cli.cjs') })
    const r = spawnSync(path.join(sb.bin, 'codepal-deepseek-flash'), ['--version'], { cwd: sb.root, encoding: 'utf8', env: { ...sb.env, FAKE_CLAUDE_MODE: 'version' } })
    expect(r.stdout).toBe('2.1.283 (Claude Code)\n')
    expect(r.status).toBe(0)
    expect(fs.existsSync(path.join(sb.root, 'pwned'))).toBe(false)
  }, 20000)

  it('TC-F13 每家稳定入口用列表第一个模型，改名后照常', () => {
    store.updateModel('deepseek', 'deepseek-flash', { name: 'deepseek-v4-flash' })
    store.addModel('deepseek', 'deepseek-v4-pro')
    const cli = path.join(REPO, 'electron/modules/models/cli.cjs')
    commands.installCommands({ appExecPath: process.execPath, cliPath: cli })
    const entry = path.join(sb.bin, 'codepal-deepseek')
    const r1 = path.join(sb.root, 'r1.json')
    spawnSync(entry, ['--print'], { input: 'a', encoding: 'utf8', env: { ...sb.env, FAKE_CLAUDE_MODE: 'success', FAKE_CLAUDE_REPORT: r1 } })
    expect(readReport(r1).env.ANTHROPIC_MODEL).toBe('deepseek-v4-flash')
    const before = sha(entry)
    store.updateModel('deepseek', 'deepseek-v4-flash', { name: 'deepseek-flash' })
    commands.syncCommands()
    expect(sha(entry)).toBe(before)
    const r2 = path.join(sb.root, 'r2.json')
    spawnSync(entry, ['--print'], { input: 'b', encoding: 'utf8', env: { ...sb.env, FAKE_CLAUDE_MODE: 'success', FAKE_CLAUDE_REPORT: r2 } })
    expect(readReport(r2).env.ANTHROPIC_MODEL).toBe('deepseek-flash')
  }, 20000)

  it('同名文件读不了（权限）时当别人的，不覆盖（Codex 审核 P1）', () => {
    fs.mkdirSync(sb.bin, { recursive: true })
    const f = path.join(sb.bin, 'codepal-deepseek-flash')
    fs.writeFileSync(f, '#!/bin/sh\n# 由 CodePal 生成：看起来像，但读不了\n')
    const before = sha(f)
    fs.chmodSync(f, 0o000)
    try {
      expect(() => commands.installCommands({ appExecPath: APP, cliPath: CLIP })).toThrow(expect.objectContaining({ code: 'occupied' }))
    } finally {
      fs.chmodSync(f, 0o644)
    }
    expect(sha(f)).toBe(before)
  })

  it('只缺每家稳定入口时 missingEntries 报出来（Codex 审核 P2）', () => {
    commands.installCommands({ appExecPath: process.execPath, cliPath: path.join(REPO, 'electron/modules/models/cli.cjs') })
    fs.rmSync(path.join(sb.bin, 'codepal-deepseek'))
    const st = commands.commandsState({ pathEnv: sb.bin })
    expect(st.missing).toEqual([])
    expect(st.missingEntries).toEqual(['deepseek'])
  })

  it('shellQuote 处理单引号', () => {
    expect(commands.shellQuote("a'b")).toBe("'a'\\''b'")
  })
})
