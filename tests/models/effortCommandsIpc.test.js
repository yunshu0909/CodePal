/**
 * @vitest-environment node
 *
 * 模型接入 · 每个模型的可选档位、终端命令指向哪个 CodePal（v2.1.16）
 *
 * 负责：
 * - TC-104 models:list 每个模型带主进程按模型算出的 efforts
 * - TC-106 commandsState 认出命令指向别的 CodePal，并给出它的版本与位置
 * - TC-107 models:list / 安装命令后，页面拿到的 commands 带上 otherApp
 * - TC-109 安装命令改用当前路径、平时同步沿用记下的路径（保持现状）
 * - TC-111 用户遇到的故障：命令指向旧版报「不认识的供应商」，点安装命令后同一个命令能启动
 *
 * @module tests/models/effortCommandsIpc.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { makeSandbox, readReport, CLI, KEY } from './helpers'

const require = createRequire(import.meta.url)
const store = require('../../electron/modules/models/store.js')
const commands = require('../../electron/modules/models/commands.js')
const { registerModelsHandlers } = require('../../electron/modules/models/ipc.js')

let sb

/** 在沙盒里摆一个打包版 CodePal：可执行文件 + Info.plist（version 为 null 时不写 plist） */
function packagedApp(name, version) {
  const app = path.join(sb.root, `${name}.app`)
  const exec = path.join(app, 'Contents', 'MacOS', 'CodePal')
  const cli = path.join(app, 'Contents', 'Resources', 'app.asar.unpacked', 'electron', 'modules', 'models', 'cli.cjs')
  fs.mkdirSync(path.dirname(exec), { recursive: true })
  fs.mkdirSync(path.dirname(cli), { recursive: true })
  fs.writeFileSync(exec, '#!/bin/sh\n')
  fs.writeFileSync(cli, '')
  if (version !== null) {
    fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0"><dict>',
      '<key>CFBundleName</key><string>CodePal</string>',
      `<key>CFBundleShortVersionString</key>\n  <string>${version}</string>`,
      '</dict></plist>',
    ].join('\n'))
  }
  return { app, appExecPath: exec, cliPath: cli }
}

/** 在沙盒里摆一个开发版 CodePal：node_modules 里的 Electron + 代码目录的 package.json */
function devCheckout(name, version) {
  const root = path.join(sb.root, name)
  const exec = path.join(root, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
  const cli = path.join(root, 'electron', 'modules', 'models', 'cli.cjs')
  fs.mkdirSync(path.dirname(exec), { recursive: true })
  fs.mkdirSync(path.dirname(cli), { recursive: true })
  fs.writeFileSync(exec, '#!/bin/sh\n')
  fs.writeFileSync(cli, '')
  // Electron 自己的 Info.plist 写的是 Electron 版本，不能当成 CodePal 版本
  fs.writeFileSync(path.join(root, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'Info.plist'),
    '<plist><dict><key>CFBundleShortVersionString</key><string>39.0.0</string></dict></plist>')
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'skill-manager', version }))
  return { root, appExecPath: exec, cliPath: cli }
}

const pathsOf = (target) => ({ appExecPath: target.appExecPath, cliPath: target.cliPath })
const execLine = (name) => fs.readFileSync(path.join(sb.bin, name), 'utf8').split('\n')[2]

beforeEach(() => {
  sb = makeSandbox()
  for (const [k, v] of Object.entries(sb.env)) vi.stubEnv(k, v)
  store.setKey('deepseek', KEY)
})
afterEach(() => {
  vi.unstubAllEnvs()
  sb.cleanup()
})

describe('TC-104 每个模型的可选档位由主进程按模型给出', () => {
  it('TC-104 models:list 带 efforts：DeepSeek 三档、M Plan Flash 五档、M3 为空', async () => {
    store.setKey('minimax-api', 'fixture.minimax-api')
    store.setKey('minimax-plan', 'fixture.minimax-plan')
    const handlers = {}
    const lifecycle = registerModelsHandlers({
      ipcMain: { handle: (ch, fn) => { handlers[ch] = fn } },
      getMainWindow: () => null,
      loginPath: () => sb.bin,
      hubOptions: { homeDir: sb.home, env: sb.env, locateClaude: () => null, locateCodex: () => null },
    })
    try {
      const res = await handlers['models:list']({})
      expect(res.success).toBe(true)
      const { providers } = res.data
      expect(providers.deepseek.models[0].efforts).toEqual(['low', 'high', 'max'])
      expect(providers['minimax-plan'].models[0]).toMatchObject({ name: 'MiniMax-M3.1-Flash-Preview', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] })
      expect(providers['minimax-api'].models[0]).toMatchObject({ name: 'MiniMax-M3', efforts: [] })
    } finally {
      lifecycle.stop()
    }
  })
})

describe('TC-106 命令状态认出指向别的 CodePal', () => {
  it('TC-106 指向别的打包版：给出它 Info.plist 的版本和 .app 位置', () => {
    const old = packagedApp('Old', '2.1.1')
    const current = packagedApp('Current', '2.1.16')
    commands.installCommands(pathsOf(old))
    const st = commands.commandsState({ pathEnv: sb.bin, current: pathsOf(current) })
    expect(st.otherApp).toEqual({ version: '2.1.1', location: old.app, dev: false })
    // 命令文件都在、路径也存在，原来的判断不变
    expect(st).toMatchObject({ installed: true, missing: [], missingEntries: [], stale: false })
  })

  it('TC-106 指向开发版：版本取代码目录的 package.json，不取 Electron 自己的版本', () => {
    const dev = devCheckout('dev', '2.1.14')
    const current = packagedApp('Current', '2.1.16')
    commands.installCommands(pathsOf(dev))
    expect(commands.commandsState({ pathEnv: sb.bin, current: pathsOf(current) }).otherApp).toEqual({ version: '2.1.14', location: dev.root, dev: true })
  })

  it('TC-106 两条路径只要有一条和当前不同就算别的；都相同才算当前这个', () => {
    const current = packagedApp('Current', '2.1.16')
    const other = packagedApp('Other', '2.1.1')
    commands.installCommands({ appExecPath: current.appExecPath, cliPath: other.cliPath })
    expect(commands.commandsState({ pathEnv: sb.bin, current: pathsOf(current) }).otherApp).toEqual({ version: '2.1.1', location: other.app, dev: false })
    commands.installCommands({ appExecPath: other.appExecPath, cliPath: current.cliPath })
    expect(commands.commandsState({ pathEnv: sb.bin, current: pathsOf(current) }).otherApp).toMatchObject({ location: current.app, dev: false })
    commands.installCommands(pathsOf(current))
    expect(commands.commandsState({ pathEnv: sb.bin, current: pathsOf(current) }).otherApp).toBeNull()
  })

  it('TC-106 读不到版本时只给位置', () => {
    const old = packagedApp('NoPlist', null)
    const current = packagedApp('Current', '2.1.16')
    commands.installCommands(pathsOf(old))
    expect(commands.commandsState({ pathEnv: sb.bin, current: pathsOf(current) }).otherApp).toEqual({ version: null, location: old.app, dev: false })
  })

  it('TC-106 指向当前这个、没装过命令、不传当前路径：都没有 otherApp', () => {
    const current = packagedApp('Current', '2.1.16')
    expect(commands.commandsState({ pathEnv: sb.bin, current: pathsOf(current) }).otherApp).toBeNull()
    commands.installCommands(pathsOf(current))
    expect(commands.commandsState({ pathEnv: sb.bin, current: pathsOf(current) }).otherApp).toBeNull()
    const old = packagedApp('Old', '2.1.1')
    commands.installCommands(pathsOf(old))
    const legacy = commands.commandsState({ pathEnv: sb.bin })
    expect(legacy.otherApp).toBeNull()
    expect(legacy).toMatchObject({ installed: true, missing: [], missingEntries: [], stale: false })
  })
})

describe('TC-107 页面数据带上指向信息', () => {
  it('TC-107 models:list 按主进程自己的路径带出 otherApp；点安装命令后消失', async () => {
    const old = packagedApp('Old', '2.1.1')
    const current = packagedApp('Current', '2.1.16')
    commands.installCommands(pathsOf(old))
    const handlers = {}
    const lifecycle = registerModelsHandlers({
      ipcMain: { handle: (ch, fn) => { handlers[ch] = fn } },
      getMainWindow: () => null,
      loginPath: () => sb.bin,
      appExecPath: current.appExecPath,
      cliPath: current.cliPath,
      hubOptions: { homeDir: sb.home, env: sb.env, locateClaude: () => null, locateCodex: () => null },
    })
    try {
      const before = await handlers['models:list']({})
      expect(before.data.commands.otherApp).toEqual({ version: '2.1.1', location: old.app, dev: false })
      expect((await handlers['models:installCommands']({})).success).toBe(true)
      expect(execLine('codepal-deepseek-flash')).toContain(`'${current.appExecPath}'`)
      const after = await handlers['models:list']({})
      expect(after.data.commands.otherApp).toBeNull()
    } finally {
      lifecycle.stop()
    }
  })
})

describe('TC-109 安装与同步规则保持', () => {
  it('TC-109 安装命令用当前路径重写全部命令；平时同步沿用记下的路径，不静默切换', () => {
    const old = packagedApp('Old', '2.1.1')
    const current = packagedApp('Current', '2.1.16')
    commands.installCommands(pathsOf(old))
    store.addModel('deepseek', 'deepseek-v4-pro')
    commands.syncCommands()
    expect(execLine('codepal-deepseek-v4-pro')).toContain(`'${old.appExecPath}'`)
    commands.installCommands(pathsOf(current))
    for (const name of ['codepal-deepseek', 'codepal-deepseek-flash', 'codepal-deepseek-v4-pro']) {
      expect(execLine(name)).toContain(`'${current.appExecPath}' '${current.cliPath}'`)
    }
    expect(store.readConfig().commandPaths).toEqual(pathsOf(current))
  })
})

describe('TC-111 用户遇到的终端启动失败', () => {
  it('TC-111 指向旧版的 MiniMax 命令报不认识；点安装命令后同一个命令能启动，强度用接入页的', async () => {
    const plan = 'minimax-plan'
    const flash = 'MiniMax-M3.1-Flash-Preview'
    const command = path.join(sb.bin, `codepal-${plan}--${flash}`)
    store.setKey(plan, `fixture.${plan}`)
    store.updateModel(plan, flash, { effort: 'medium' })
    store.writeStatus(plan, flash, { ok: true, source: 'test' })
    // 旧版引擎：只认得 DeepSeek 的命令行，复现 2.1.1 的报错
    const oldRoot = path.join(sb.root, 'old')
    const oldCli = path.join(oldRoot, 'electron', 'modules', 'models', 'cli.cjs')
    fs.mkdirSync(path.dirname(oldCli), { recursive: true })
    fs.writeFileSync(oldCli, "const id = process.argv[3]\nif (id !== 'deepseek') { process.stderr.write('不认识的供应商：' + id + '\\n'); process.exit(2) }\n")
    fs.writeFileSync(path.join(oldRoot, 'package.json'), JSON.stringify({ version: '2.1.1' }))
    commands.installCommands({ appExecPath: process.execPath, cliPath: oldCli })
    const before = spawnSync('/bin/sh', [command], { env: sb.env, encoding: 'utf8', input: '' })
    expect(before.status).toBe(2)
    expect(before.stderr).toContain(`不认识的供应商：${plan}`)

    const handlers = {}
    const lifecycle = registerModelsHandlers({
      ipcMain: { handle: (ch, fn) => { handlers[ch] = fn } },
      getMainWindow: () => null,
      loginPath: () => sb.bin,
      appExecPath: process.execPath,
      cliPath: CLI,
      hubOptions: { homeDir: sb.home, env: sb.env, locateClaude: () => null, locateCodex: () => null },
    })
    try {
      expect((await handlers['models:list']({})).data.commands.otherApp).toEqual({ version: '2.1.1', location: oldRoot, dev: true })
      expect((await handlers['models:installCommands']({})).success).toBe(true)
      // 审核用的强度在汇总里改成别的，不影响终端
      expect((await handlers['models:hubSetEffort']({}, { id: `${plan}:${flash}`, effort: 'low' })).success).toBe(true)
    } finally {
      lifecycle.stop()
    }
    const after = spawnSync('/bin/sh', [command], { env: sb.env, encoding: 'utf8', input: '' })
    expect(after.stderr).not.toContain('不认识的供应商')
    expect(after.status).toBe(0)
    const report = readReport(sb.report)
    expect(report.env.ANTHROPIC_MODEL).toBe(flash)
    const settings = JSON.parse(report.argv[report.argv.indexOf('--settings') + 1])
    expect(settings.env.CLAUDE_CODE_EFFORT_LEVEL).toBe('medium')
  })
})
