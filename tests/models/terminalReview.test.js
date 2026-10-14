/**
 * @vitest-environment node
 *
 * 模型接入 · 在终端里用 · 代码审核（formal.G4 第 1 轮）提出的问题的回归测试
 *
 * 负责：
 * - 写哪个文件跟着登录 shell 实际用的 ZDOTDIR（后-13、A-102）；确认框打开后文件身份变了就不写（后-13-例6）
 * - 测试结果变了，推给页面的消息带上新的命令状态（readyCount），顶上一行跟着变（后-11）
 * - 用户删掉的 codepal 总入口，之后的自动同步也不补回（后-16、后-17-例5）
 * - 命令文件写好后，旧命令删不掉照样算装好（后-08）
 * - 终端列表里没选中的行「● 可用」是绿色（定稿 T1）
 *
 * 都从真实入口触发（models:* 接口、选择程序导出的行渲染函数）；临时 HOME，真实 zsh。
 *
 * @module tests/models/terminalReview.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { makeSandbox, REPO, KEY } from './helpers'

const require = createRequire(import.meta.url)
const { registerModelsHandlers } = require('../../electron/modules/models/ipc.js')
const store = require('../../electron/modules/models/store.js')
const commands = require('../../electron/modules/models/commands.js')
const picker = require('../../electron/modules/models/picker.cjs')

const CLIP = path.join(REPO, 'electron/modules/models/cli.cjs')
let sb
let handlers
let api
let send
let savedZdotdir
const call = (ch, arg) => handlers[ch]({}, arg)

/** 注册接口；shellOptions 不带 zdotdir 时按登录 shell 实际读到的来 */
function register({ loginEnv, shellOptions = {} } = {}) {
  handlers = {}
  send = vi.fn()
  api = registerModelsHandlers({
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn } },
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send } }),
    cliPath: CLIP,
    appExecPath: process.execPath,
    shellOptions: { shell: '/bin/zsh', home: sb.home, binDir: sb.bin, reprobeMs: 0, ...shellOptions },
    ...(loginEnv ? { loginEnv } : {}),
  })
}
const install = () => commands.installCommands({ appExecPath: process.execPath, cliPath: CLIP })

beforeEach(() => {
  sb = makeSandbox()
  sb.bin = path.join(sb.home, '.local', 'bin')
  fs.mkdirSync(sb.bin, { recursive: true })
  sb.env.CODEPAL_BIN_DIR = sb.bin
  for (const [k, v] of Object.entries(sb.env)) process.env[k] = v
  // 本机开发环境可能带 ZDOTDIR；这里模拟从 Finder 打开的 CodePal（环境里没有 ZDOTDIR）
  savedZdotdir = process.env.ZDOTDIR
  delete process.env.ZDOTDIR
  store.setKey('zhipu-api', KEY)
})
afterEach(() => {
  api?.stop()
  if (savedZdotdir !== undefined) process.env.ZDOTDIR = savedZdotdir
  for (const k of Object.keys(sb.env)) if (k !== 'PATH' && k !== 'HOME') delete process.env[k]
  try { execFileSync('chflags', ['-R', 'nouchg', sb.root]) } catch {}
  sb.cleanup()
})

describe('写哪个文件（后-13、A-102）', () => {
  it('TC-015 G4 ~/.zshenv 里设了 ZDOTDIR、CodePal 自己的环境里没有 → 写 $ZDOTDIR/.zprofile，写完终端找得到', async () => {
    fs.writeFileSync(path.join(sb.home, '.zshenv'), 'export ZDOTDIR="$HOME/.config/zsh"\n')
    fs.mkdirSync(path.join(sb.home, '.config', 'zsh'), { recursive: true })
    register()
    install()
    const before = (await call('models:list')).data.commands
    expect(before).toMatchObject({ pathStatus: 'missing', profile: '~/.config/zsh/.zprofile' })
    const r = await call('models:addToPath', { expectedProfile: before.profile, expectedIdentity: before.profileIdentity })
    expect(r.success).toBe(true)
    expect(r.data).toMatchObject({ profile: '~/.config/zsh/.zprofile', added: true, pathStatus: 'found' })
    expect(fs.existsSync(path.join(sb.home, '.zprofile'))).toBe(false)
  })

  it('TC-015 G4 后-13-例6 确认框打开后 ~/.zprofile 被换成指向别处的链接（显示路径不变）→ 不写，返回 target_changed', async () => {
    register({ loginEnv: async () => ({ status: 'ok', path: '/usr/bin', codepal: null }), shellOptions: { zdotdir: null } })
    install()
    const before = (await call('models:list')).data.commands
    expect(typeof before.profileIdentity).toBe('string')
    const other = path.join(sb.root, 'elsewhere.zsh')
    fs.writeFileSync(other, '# 别处的文件\n')
    fs.symlinkSync(other, path.join(sb.home, '.zprofile'))
    const r = await call('models:addToPath', { expectedProfile: before.profile, expectedIdentity: before.profileIdentity })
    expect(r.success).toBe(false)
    expect(r.error.code).toBe('target_changed')
    expect(fs.readFileSync(other, 'utf8')).toBe('# 别处的文件\n')
  })
})

describe('测试结果变了，顶上一行跟着变（后-11）', () => {
  it('TC-008 G4 状态文件写回「可用」→ 推给页面的消息带上 readyCount 1', async () => {
    register({ loginEnv: async () => ({ status: 'ok', path: `${sb.bin}:/usr/bin`, codepal: null }), shellOptions: { zdotdir: null } })
    install()
    expect((await call('models:list')).data.commands.readyCount).toBe(0)
    store.writeStatus('zhipu-api', 'glm-5.3', { ok: true, source: 'test' })
    await vi.waitFor(() => {
      const pushed = send.mock.calls.filter(([ch]) => ch === 'models:changed').map(([, payload]) => payload)
      expect(pushed.some((p) => p.commands?.readyCount === 1)).toBe(true)
    }, { timeout: 3000, interval: 50 })
  })
})

describe('用户删掉的总入口不补回（后-16、后-17-例5）', () => {
  it('TC-001 G4 装过后删掉 codepal，再加模型触发同步 → codepal 仍然没有', async () => {
    register({ loginEnv: async () => ({ status: 'ok', path: `${sb.bin}:/usr/bin`, codepal: null }), shellOptions: { zdotdir: null } })
    install()
    fs.rmSync(path.join(sb.bin, 'codepal'))
    const r = await call('models:addModel', { providerId: 'zhipu-api', name: 'glm-5.3-air' })
    expect(r.success).toBe(true)
    expect(fs.existsSync(path.join(sb.bin, 'codepal'))).toBe(false)
    expect(fs.existsSync(path.join(sb.bin, 'codepal-zhipu-api--glm-5.3-air'))).toBe(true)
  })
})

describe('命令写好后的收尾失败不算装不上（后-08）', () => {
  it('TC-006 G4 不再需要的旧命令删不掉 → 照样返回成功', async () => {
    register({ loginEnv: async () => ({ status: 'ok', path: `${sb.bin}:/usr/bin`, codepal: null }), shellOptions: { zdotdir: null } })
    install()
    // 一个 CodePal 生成、但已经不需要的旧命令，且被锁住删不掉
    const old = path.join(sb.bin, 'codepal-zhipu-api--old-model')
    fs.copyFileSync(path.join(sb.bin, 'codepal-zhipu-api--glm-5.3'), old)
    execFileSync('chflags', ['uchg', old])
    const r = await call('models:installCommands')
    expect(r.success).toBe(true)
    expect(fs.existsSync(path.join(sb.bin, 'codepal-zhipu-api--glm-5.3'))).toBe(true)
  })
})

describe('终端列表的颜色（定稿 T1）', () => {
  it('TC-017 G4 没选中的行「● 可用」是绿色；选中行整行反显、不另加颜色', () => {
    const line = 'glm-5.3    智谱 API    ● 可用'
    expect(picker.rowOut(line, false)).toContain('\x1b[32m● 可用')
    expect(picker.rowOut(line, true)).toBe(`\x1b[7m${line}\x1b[0m`)
  })
})
