/**
 * @vitest-environment node
 *
 * 模型接入 · 在终端里用 · 代码审核（formal.G4 第 2 轮）提出的问题的回归测试
 *
 * 负责：
 * - 点「加入」时重新判断一次登录 shell（不沿用确认前 1 秒内的结果），按这次读到的 ZDOTDIR 算要写的文件，
 *   和确认框里的不一样就不写（后-13-例6）
 * - 点「加入」时判断不了，沿用上一次判断到的 ZDOTDIR，不退回 CodePal 自己的环境（后-13、A-102）
 *
 * 判断结果用注入的替身控制；临时 HOME，从 models:* 接口触发。
 *
 * @module tests/models/terminalReview2.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { makeSandbox, REPO, KEY } from './helpers'

const require = createRequire(import.meta.url)
const { registerModelsHandlers } = require('../../electron/modules/models/ipc.js')
const store = require('../../electron/modules/models/store.js')
const commands = require('../../electron/modules/models/commands.js')

const CLIP = path.join(REPO, 'electron/modules/models/cli.cjs')
const LINE = 'export PATH="$HOME/.local/bin:$PATH"'
let sb
let handlers
let api
let savedZdotdir
const call = (ch, arg) => handlers[ch]({}, arg)

/** 注册接口；不给 zdotdir，按登录 shell 读到的来；reprobeMs 不给就用默认的 1 秒 */
function register(loginEnv, extra = {}) {
  handlers = {}
  api = registerModelsHandlers({
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn } },
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: vi.fn() } }),
    cliPath: CLIP,
    appExecPath: process.execPath,
    shellOptions: { shell: '/bin/zsh', home: sb.home, binDir: sb.bin, ...extra },
    loginEnv,
  })
}

beforeEach(() => {
  sb = makeSandbox()
  sb.bin = path.join(sb.home, '.local', 'bin')
  fs.mkdirSync(sb.bin, { recursive: true })
  sb.env.CODEPAL_BIN_DIR = sb.bin
  for (const [k, v] of Object.entries(sb.env)) process.env[k] = v
  savedZdotdir = process.env.ZDOTDIR
  delete process.env.ZDOTDIR
  store.setKey('zhipu-api', KEY)
  commands.installCommands({ appExecPath: process.execPath, cliPath: CLIP })
})
afterEach(() => {
  api?.stop()
  if (savedZdotdir !== undefined) process.env.ZDOTDIR = savedZdotdir
  for (const k of Object.keys(sb.env)) if (k !== 'PATH' && k !== 'HOME') delete process.env[k]
  sb.cleanup()
})

describe('点「加入」时重新判断要写的文件（后-13）', () => {
  it('TC-015 G4-2 确认框打开后 ZDOTDIR 变了（1 秒内点「加入」）→ 按新判断的结果，不一样就不写', async () => {
    const dirA = path.join(sb.home, '.config', 'a')
    const dirB = path.join(sb.home, '.config', 'b')
    fs.mkdirSync(dirA, { recursive: true })
    fs.mkdirSync(dirB, { recursive: true })
    let zdotdir = dirA
    register(async () => ({ status: 'ok', path: '/usr/bin', codepal: null, zdotdir }))
    const before = (await call('models:list')).data.commands
    expect(before.profile).toBe('~/.config/a/.zprofile')
    zdotdir = dirB
    const r = await call('models:addToPath', { expectedProfile: before.profile, expectedIdentity: before.profileIdentity })
    expect(r.success).toBe(false)
    expect(r.error).toMatchObject({ code: 'target_changed', profile: '~/.config/b/.zprofile' })
    expect(fs.existsSync(path.join(dirA, '.zprofile'))).toBe(false)
    expect(fs.existsSync(path.join(dirB, '.zprofile'))).toBe(false)
  })

  it('TC-015 G4-2 点「加入」时判断不了 → 沿用上次判断到的 ZDOTDIR，写进 $ZDOTDIR/.zprofile', async () => {
    const dirA = path.join(sb.home, '.config', 'a')
    fs.mkdirSync(dirA, { recursive: true })
    let ok = true
    register(async () => (ok ? { status: 'ok', path: '/usr/bin', codepal: null, zdotdir: dirA } : { status: 'unknown' }), { reprobeMs: 0 })
    const before = (await call('models:list')).data.commands
    expect(before.profile).toBe('~/.config/a/.zprofile')
    ok = false
    const r = await call('models:addToPath', { expectedProfile: before.profile, expectedIdentity: before.profileIdentity })
    expect(r.success).toBe(true)
    expect(r.data).toMatchObject({ profile: '~/.config/a/.zprofile', added: true, pathStatus: 'unknown' })
    expect(fs.readFileSync(path.join(dirA, '.zprofile'), 'utf8')).toContain(LINE)
    expect(fs.existsSync(path.join(sb.home, '.zprofile'))).toBe(false)
  })
})
