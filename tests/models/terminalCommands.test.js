/**
 * @vitest-environment node
 *
 * 模型接入 · 在终端里用 · codepal 总入口的安装、更新与状态（specs/v2.1.22-在终端里用/4-test-cases.md）
 *
 * 负责：
 * - 「安装命令 / 更新命令」顺带写 codepal 总入口（后-08、后-10），名字被占时不覆盖（后-09）
 * - 以前装过、升级后只缺总入口时自动补上（后-17、A-101）
 * - 命令状态里的 entry 字段（真话表 真-03、真-04、真-05）
 * - 全部在临时目录里跑（CODEPAL_MODELS_HOME / CODEPAL_BIN_DIR），不碰真实文件
 *
 * @module tests/models/terminalCommands.test
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { makeSandbox, KEY } from './helpers'

const require = createRequire(import.meta.url)
// 新模块：选择程序与 shell 判断；先红时这里找不到
require('../../electron/modules/models/shellProfile.js')
const store = require('../../electron/modules/models/store.js')
const commands = require('../../electron/modules/models/commands.js')

// 「当前的 CodePal」要是一个真实存在的可执行文件：命令指向的程序不存在会被当成坏了（显示未安装）。
// 用跑测试的 Node 本身，任何机器上都在（不能用 /Applications 里装的 App，CI 机器上没有）
const APP = process.execPath
const DIR = '/Applications/CodePal.app/Contents/Resources/app.asar.unpacked/electron/modules/models'
const CLIP = `${DIR}/cli.cjs`
const PICKER = `${DIR}/picker.cjs`
const OLD_APP = '/Applications/CodePal 2.1.1.app/Contents/MacOS/CodePal'
const OLD_CLIP = '/Applications/CodePal 2.1.1.app/Contents/Resources/app.asar.unpacked/electron/modules/models/cli.cjs'
let sb
const entry = () => path.join(sb.bin, 'codepal')
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')

beforeEach(() => {
  sb = makeSandbox()
  process.env.CODEPAL_MODELS_HOME = sb.models
  process.env.CODEPAL_BIN_DIR = sb.bin
  store.setKey('deepseek', KEY)
  store.setKey('zhipu-api', KEY)
  store.addModel('zhipu-api', 'glm-5.3-flash')
})
afterEach(() => {
  delete process.env.CODEPAL_MODELS_HOME
  delete process.env.CODEPAL_BIN_DIR
  try { fs.chmodSync(sb.bin, 0o755) } catch {}
  sb.cleanup()
})

describe('安装命令顺带写 codepal 总入口（后-08）', () => {
  it('TC-006 后-08-例1 两家 3 个模型 → 单模型命令、每家入口和 codepal 都写好', () => {
    const r = commands.installCommands({ appExecPath: APP, cliPath: CLIP })
    expect(r.installed.sort()).toEqual([
      'codepal-deepseek', 'codepal-deepseek-flash', 'codepal-zhipu-api', 'codepal-zhipu-api--glm-5.3', 'codepal-zhipu-api--glm-5.3-flash',
    ])
    expect(r.entry).toBe('written')
    const lines = fs.readFileSync(entry(), 'utf8').split('\n')
    expect(lines[0]).toBe('#!/bin/sh')
    expect(lines[1].startsWith(commands.GENERATED_MARK)).toBe(true)
    expect(fs.readFileSync(entry(), 'utf8')).toContain(`'${APP}' '${PICKER}'`)
    expect(fs.readFileSync(entry(), 'utf8')).toContain('exec "$choice" "$@"')
    expect(fs.readFileSync(entry(), 'utf8')).not.toContain('sk-test')
    expect(fs.statSync(entry()).mode & 0o777).toBe(0o755)
    expect(commands.commandsState({ pathEnv: sb.bin, current: { appExecPath: APP, cliPath: CLIP } }).entry).toBe('ok')
  })

  it('TC-006 后-08-例2 ~/.local/bin 不可写 → 一个文件都不写，报写入失败', () => {
    fs.mkdirSync(sb.bin, { recursive: true })
    fs.chmodSync(sb.bin, 0o555)
    let err
    try { commands.installCommands({ appExecPath: APP, cliPath: CLIP }) } catch (e) { err = e }
    expect(['EACCES', 'EPERM']).toContain(err?.code)
    expect(fs.readdirSync(sb.bin)).toEqual([])
  })

  it('TC-006 后-08-例3 安装后改模型名触发同步 → 命令与配置一致，总入口还在', () => {
    commands.installCommands({ appExecPath: APP, cliPath: CLIP })
    store.updateModel('zhipu-api', 'glm-5.3-flash', { name: 'glm-5.3-air' })
    commands.syncCommands()
    expect(fs.existsSync(path.join(sb.bin, 'codepal-zhipu-api--glm-5.3-air'))).toBe(true)
    expect(fs.existsSync(path.join(sb.bin, 'codepal-zhipu-api--glm-5.3-flash'))).toBe(false)
    expect(fs.existsSync(entry())).toBe(true)
    expect(commands.commandsState({ pathEnv: sb.bin, current: { appExecPath: APP, cliPath: CLIP } }).missing).toEqual([])
  })

  it('TC-006 真-03 消失：装好之后不再是「未安装」（没有缺的命令、总入口在）', () => {
    const before = commands.commandsState({ pathEnv: sb.bin, current: { appExecPath: APP, cliPath: CLIP } })
    expect(before.installed).toBe(false)
    commands.installCommands({ appExecPath: APP, cliPath: CLIP })
    const after = commands.commandsState({ pathEnv: sb.bin, current: { appExecPath: APP, cliPath: CLIP } })
    expect(after.installed).toBe(true)
    expect(after.missing).toEqual([])
    expect(after.entry).toBe('ok')
  })
})

describe('名字被占（后-09）', () => {
  it('TC-010 后-09-例1 ~/.local/bin/codepal 是别人的脚本 → 原样不动，单模型命令照装；真-05 出现', () => {
    fs.mkdirSync(sb.bin, { recursive: true })
    fs.writeFileSync(entry(), '#!/bin/sh\necho mine\n', { mode: 0o755 })
    const before = sha(entry())
    const r = commands.installCommands({ appExecPath: APP, cliPath: CLIP })
    expect(r.entry).toBe('taken')
    expect(sha(entry())).toBe(before)
    expect(fs.existsSync(path.join(sb.bin, 'codepal-zhipu-api--glm-5.3'))).toBe(true)
    expect(commands.commandsState({ pathEnv: sb.bin, current: { appExecPath: APP, cliPath: CLIP } }).entry).toBe('taken')
  })

  it('TC-010 后-09 同步也不覆盖、不删除别人的 codepal', () => {
    commands.installCommands({ appExecPath: APP, cliPath: CLIP })
    fs.writeFileSync(entry(), '#!/bin/sh\necho mine\n', { mode: 0o755 })
    store.addModel('deepseek', 'deepseek-v4-pro')
    commands.syncCommands()
    expect(fs.readFileSync(entry(), 'utf8')).toBe('#!/bin/sh\necho mine\n')
  })
})

describe('更新命令（后-10）', () => {
  it('TC-023 后-10-例1 命令连着 2.1.1 → 在新版里更新后全部改连当前 CodePal；真-04 出现与消失', () => {
    // 另一个 CodePal 要真实存在（不存在的会被当成命令坏了、显示未安装）
    const oldApp = path.join(sb.root, OLD_APP)
    const oldCli = path.join(sb.root, OLD_CLIP)
    fs.mkdirSync(path.dirname(oldApp), { recursive: true })
    fs.writeFileSync(oldApp, '#!/bin/sh\n', { mode: 0o755 })
    commands.installCommands({ appExecPath: oldApp, cliPath: oldCli })
    const before = commands.commandsState({ pathEnv: sb.bin, current: { appExecPath: APP, cliPath: CLIP } })
    expect(before.otherApp).not.toBeNull()
    commands.installCommands({ appExecPath: APP, cliPath: CLIP })
    const after = commands.commandsState({ pathEnv: sb.bin, current: { appExecPath: APP, cliPath: CLIP } })
    expect(after.otherApp).toBeNull()
    expect(fs.readFileSync(entry(), 'utf8')).toContain(`'${PICKER}'`)
  })
})

describe('升级后自动补上 codepal（后-17、A-101）', () => {
  /** 模拟旧版装过的样子：单模型命令都在，没有总入口，配置里也没有写过总入口的记录 */
  const installOld = () => {
    commands.installCommands({ appExecPath: APP, cliPath: CLIP })
    fs.rmSync(entry())
    const cfgFile = path.join(sb.models, 'models.json')
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
    delete cfg.entryInstalled
    fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n')
  }

  it('TC-023 后-17-例1 以前装过、升级后只缺 codepal → 进入页面时补上，再按实际情况算状态', () => {
    installOld()
    expect(commands.commandsState({ pathEnv: sb.bin, current: { appExecPath: APP, cliPath: CLIP } }).entry).toBe('missing')
    const r = commands.ensureEntry()
    expect(r.status).toBe('written')
    expect(fs.existsSync(entry())).toBe(true)
    expect(commands.commandsState({ pathEnv: sb.bin, current: { appExecPath: APP, cliPath: CLIP } }).entry).toBe('ok')
  })

  it('TC-023 后-17-例2 补的时候 ~/.local/bin 不可写 → 不抛错，照实返回失败，状态仍是缺', () => {
    installOld()
    fs.chmodSync(sb.bin, 0o555)
    const r = commands.ensureEntry()
    expect(r.status).toBe('failed')
    expect(fs.existsSync(entry())).toBe(false)
  })

  it('TC-023 后-17 写过总入口、后来被你自己删掉 → 不自动补回（按实际显示未安装，后-16）', () => {
    commands.installCommands({ appExecPath: APP, cliPath: CLIP })
    fs.rmSync(entry())
    expect(commands.ensureEntry().status).toBe('skipped')
    expect(fs.existsSync(entry())).toBe(false)
  })

  it('TC-023 后-17 从没装过命令时不补；名字被占时不补', () => {
    expect(commands.ensureEntry().status).toBe('skipped')
    installOld()
    fs.writeFileSync(entry(), '#!/bin/sh\necho mine\n', { mode: 0o755 })
    expect(commands.ensureEntry().status).toBe('skipped')
    expect(fs.readFileSync(entry(), 'utf8')).toBe('#!/bin/sh\necho mine\n')
  })
})
