/**
 * @vitest-environment node
 *
 * 模型接入 · 在终端里用 · 主进程接口（specs/v2.1.22-在终端里用/4-test-cases.md）
 *
 * 负责：
 * - models:list 带回「在终端里用」需要的状态：终端找不找得到（found / missing / unknown）、shell、要写的文件、总入口
 * - models:addToPath：确认时核对目标、写入、重新判断，返回给页面选 Toast（后-13、后-15，真话表 真-07、真-10、真-12）
 * - 判断的排队与防抖（后-12-例5、例7）、进入页面只读与升级补入口（后-16、后-17）
 * - 用临时 HOME 与真实 zsh；判断结果可注入（模拟判断不了）
 *
 * @module tests/models/terminalIpc.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { makeSandbox, REPO, KEY } from './helpers'

const require = createRequire(import.meta.url)
// 新模块；先红时这里找不到
const shellProfile = require('../../electron/modules/models/shellProfile.js')
const { registerModelsHandlers } = require('../../electron/modules/models/ipc.js')
const store = require('../../electron/modules/models/store.js')
const commands = require('../../electron/modules/models/commands.js')

const CLIP = path.join(REPO, 'electron/modules/models/cli.cjs')
const LINE = 'export PATH="$HOME/.local/bin:$PATH"'
let sb
let handlers
let api
const call = (ch, arg) => handlers[ch]({}, arg)
const zprofile = () => path.join(sb.home, '.zprofile')

/** 注册接口；loginEnv 不传时用真实 zsh 读临时 HOME 的启动文件 */
function register({ shell = '/bin/zsh', loginEnv, reprobeMs = 1000 } = {}) {
  handlers = {}
  api = registerModelsHandlers({
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn } },
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: vi.fn() } }),
    cliPath: CLIP,
    appExecPath: process.execPath,
    shellOptions: { shell, home: sb.home, zdotdir: null, binDir: sb.bin, reprobeMs },
    ...(loginEnv ? { loginEnv } : {}),
  })
}

beforeEach(() => {
  sb = makeSandbox()
  // 命令目录放在临时 HOME 的 ~/.local/bin：加入 PATH 写的是 $HOME/.local/bin，这样真实 zsh 才判断得出「找得到」
  sb.bin = path.join(sb.home, '.local', 'bin')
  fs.mkdirSync(sb.bin, { recursive: true })
  sb.env.CODEPAL_BIN_DIR = sb.bin
  for (const [k, v] of Object.entries(sb.env)) process.env[k] = v
  store.setKey('zhipu-api', KEY)
  store.writeStatus('zhipu-api', 'glm-5.3', { ok: true, source: 'test' })
})
afterEach(() => {
  api?.stop()
  for (const k of Object.keys(sb.env)) if (k !== 'PATH' && k !== 'HOME') delete process.env[k]
  try { fs.chmodSync(sb.home, 0o755) } catch {}
  sb.cleanup()
})

describe('models:addToPath 与之后的提示（后-15）', () => {
  it('TC-011 后-15-例1 正常 ~/.zprofile → 写好、重新判断找得到；真-07 出现', async () => {
    register()
    commands.installCommands({ appExecPath: process.execPath, cliPath: CLIP })
    const before = await call('models:list')
    expect(before.data.commands.pathStatus).toBe('missing')
    expect(before.data.commands.profile).toBe('~/.zprofile')
    const r = await call('models:addToPath', { expectedProfile: '~/.zprofile' })
    expect(r.success).toBe(true)
    expect(r.data).toMatchObject({ profile: '~/.zprofile', added: true, pathStatus: 'found' })
    expect(fs.readFileSync(zprofile(), 'utf8')).toContain(LINE)
    expect(r.data.commands.pathStatus).toBe('found')
  })

  it('TC-011 后-15-例2 ~/.zshrc 改写了 PATH → 写好了但仍找不到；真-10 出现', async () => {
    fs.writeFileSync(path.join(sb.home, '.zshrc'), 'export PATH=/usr/bin:/bin\n')
    register()
    commands.installCommands({ appExecPath: process.execPath, cliPath: CLIP })
    const r = await call('models:addToPath', { expectedProfile: '~/.zprofile' })
    expect(r.success).toBe(true)
    expect(r.data).toMatchObject({ added: true, pathStatus: 'missing' })
  })

  it('TC-011 后-15-例3 写好了但判断不了 → pathStatus unknown；真-12 出现', async () => {
    let n = 0
    register({ loginEnv: async () => (n++ === 0 ? { status: 'ok', path: '/usr/bin:/bin', codepal: null } : { status: 'unknown' }) })
    commands.installCommands({ appExecPath: process.execPath, cliPath: CLIP })
    await call('models:list')
    const r = await call('models:addToPath', { expectedProfile: '~/.zprofile' })
    expect(r.data).toMatchObject({ added: true, pathStatus: 'unknown' })
  })

  it('TC-012 真-12 消失：重新判断找得到时不是 unknown', async () => {
    register({ loginEnv: async () => ({ status: 'ok', path: `${sb.bin}:/usr/bin`, codepal: path.join(sb.bin, 'codepal') }) })
    commands.installCommands({ appExecPath: process.execPath, cliPath: CLIP })
    const r = await call('models:addToPath', { expectedProfile: '~/.zprofile' })
    expect(r.data.pathStatus).toBe('found')
  })

  it('TC-013 真-07 消失：写不进 → 返回 write_denied，没有成功结果', async () => {
    register()
    commands.installCommands({ appExecPath: process.execPath, cliPath: CLIP })
    fs.writeFileSync(zprofile(), '# ro\n')
    fs.chmodSync(zprofile(), 0o444)
    fs.chmodSync(sb.home, 0o555)
    const r = await call('models:addToPath', { expectedProfile: '~/.zprofile' })
    fs.chmodSync(sb.home, 0o755)
    expect(r.success).toBe(false)
    expect(r.error.code).toBe('write_denied')
    expect(r.error.message).toBe('没能写入 ~/.zprofile：没有写入权限，检查这个文件的权限后再试')
  })

  it('TC-016 真-10 消失：终端找得到时不会是 missing', async () => {
    fs.writeFileSync(zprofile(), `export PATH="${sb.bin}:$PATH"\n`)
    register()
    commands.installCommands({ appExecPath: process.execPath, cliPath: CLIP })
    const r = await call('models:list')
    expect(r.data.commands.pathStatus).toBe('found')
  })
})

describe('写哪个文件由主程序决定（后-13）', () => {
  it('TC-015 bash 只有 ~/.profile → list 带回 ~/.profile；fish → 没有目标', async () => {
    fs.writeFileSync(path.join(sb.home, '.profile'), '')
    register({ shell: '/bin/bash' })
    expect((await call('models:list')).data.commands).toMatchObject({ shell: 'bash', profile: '~/.profile' })
    api.stop()
    register({ shell: '/opt/homebrew/bin/fish', loginEnv: async () => ({ status: 'ok', path: '/usr/bin', codepal: null }) })
    const fish = await call('models:list')
    expect(fish.data.commands).toMatchObject({ shell: 'other', profile: null })
    const r = await call('models:addToPath', { expectedProfile: '~/.zprofile' })
    expect(r.error.code).toBe('unsupported_shell')
  })

  it('TC-015 后-13-例6 确认时目标变了 → 不写，返回 target_changed 和新目标', async () => {
    register()
    fs.writeFileSync(path.join(sb.home, '.bash_profile'), '')
    const r = await call('models:addToPath', { expectedProfile: '~/.bash_profile' })
    expect(r.success).toBe(false)
    expect(r.error.code).toBe('target_changed')
    expect(r.error.profile).toBe('~/.zprofile')
    expect(fs.existsSync(zprofile())).toBe(false)
  })
})

describe('判断的排队与刷新（后-12）', () => {
  it('TC-014 后-12-例7 1 秒内反复进入 5 次 → 只启动一次判断', async () => {
    const probe = vi.fn(async () => ({ status: 'ok', path: '/usr/bin', codepal: null }))
    register({ loginEnv: probe })
    await Promise.all([1, 2, 3, 4, 5].map(() => call('models:list')))
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('TC-014 后-12-例5 手动加好 PATH 后再进入 → 重新判断，不再是差一步', async () => {
    let fixed = false
    register({ loginEnv: async () => ({ status: 'ok', path: fixed ? `${sb.bin}:/usr/bin` : '/usr/bin', codepal: null }), reprobeMs: 0 })
    commands.installCommands({ appExecPath: process.execPath, cliPath: CLIP })
    expect((await call('models:list')).data.commands.pathStatus).toBe('missing')
    fixed = true
    expect((await call('models:list')).data.commands.pathStatus).toBe('found')
  })

  it('TC-014 后-12-例3 判断不了 → unknown，不记住，下次再判断；后-12-例8 展开区写完整路径（onPath false）', async () => {
    const probe = vi.fn(async () => ({ status: 'unknown' }))
    register({ loginEnv: probe, reprobeMs: 0 })
    const first = (await call('models:list')).data.commands
    expect(first.pathStatus).toBe('unknown')
    expect(first.onPath).toBe(false)
    await call('models:list')
    expect(probe).toHaveBeenCalledTimes(2)
  })
})

describe('进入页面只读；升级后补入口（后-16、后-17）', () => {
  it('TC-001 后-16-例1 你自己删了 codepal，再进入 → 不补回，状态是缺（未安装）', async () => {
    register({ loginEnv: async () => ({ status: 'ok', path: `${sb.bin}:/usr/bin`, codepal: null }) })
    commands.installCommands({ appExecPath: process.execPath, cliPath: CLIP })
    fs.rmSync(path.join(sb.bin, 'codepal'))
    const r = await call('models:list')
    expect(r.data.commands.entry).toBe('missing')
    expect(fs.existsSync(path.join(sb.bin, 'codepal'))).toBe(false)
  })

  it('TC-023 后-17-例1（按补充记录 002 改读）以前装过、从没写过总入口 → 进入页面补上，按实际情况重新算', async () => {
    register({ loginEnv: async () => ({ status: 'ok', path: `${sb.bin}:/usr/bin`, codepal: null }) })
    commands.installCommands({ appExecPath: process.execPath, cliPath: CLIP })
    fs.rmSync(path.join(sb.bin, 'codepal'))
    const cfgFile = path.join(sb.models, 'models.json')
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
    delete cfg.entryInstalled
    fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n')
    const r = await call('models:list')
    expect(fs.existsSync(path.join(sb.bin, 'codepal'))).toBe(true)
    expect(r.data.commands).toMatchObject({ entry: 'ok', pathStatus: 'found' })
  })

  /** 模拟旧版装过：命令都在、没有总入口、配置里没有写过总入口的记录 */
  const installOld = () => {
    commands.installCommands({ appExecPath: process.execPath, cliPath: CLIP })
    fs.rmSync(path.join(sb.bin, 'codepal'))
    const cfgFile = path.join(sb.models, 'models.json')
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
    delete cfg.entryInstalled
    fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n')
  }

  it('TC-023 后-17-例3 升级后补上 codepal，按实际情况显示：找得到 → 已装好要素齐；找不到 → 差一步', async () => {
    register({ loginEnv: async () => ({ status: 'ok', path: `${sb.bin}:/usr/bin`, codepal: path.join(sb.bin, 'codepal') }) })
    installOld()
    const found = await call('models:list')
    expect(fs.existsSync(path.join(sb.bin, 'codepal'))).toBe(true)
    expect(found.data.commands).toMatchObject({ entry: 'ok', pathStatus: 'found', readyCount: 1 })
    api.stop()
    register({ loginEnv: async () => ({ status: 'ok', path: '/usr/bin', codepal: null }) })
    installOld()
    const missing = await call('models:list')
    expect(missing.data.commands).toMatchObject({ entry: 'ok', pathStatus: 'missing' })
  })

  it('TC-023 后-17-例4 升级后 ~/.local/bin/codepal 是别的程序 → 不写、不覆盖，名字被占', async () => {
    register({ loginEnv: async () => ({ status: 'ok', path: `${sb.bin}:/usr/bin`, codepal: path.join(sb.bin, 'codepal') }) })
    installOld()
    fs.writeFileSync(path.join(sb.bin, 'codepal'), '#!/bin/sh\necho mine\n', { mode: 0o755 })
    const r = await call('models:list')
    expect(fs.readFileSync(path.join(sb.bin, 'codepal'), 'utf8')).toBe('#!/bin/sh\necho mine\n')
    expect(r.data.commands.entry).toBe('taken')
  })

  it('TC-023 后-17-例5 写过总入口、后来被你删掉 → 进入页面不补回，状态是缺', async () => {
    register({ loginEnv: async () => ({ status: 'ok', path: `${sb.bin}:/usr/bin`, codepal: null }) })
    commands.installCommands({ appExecPath: process.execPath, cliPath: CLIP })
    fs.rmSync(path.join(sb.bin, 'codepal'))
    const r = await call('models:list')
    expect(fs.existsSync(path.join(sb.bin, 'codepal'))).toBe(false)
    expect(r.data.commands.entry).toBe('missing')
  })

  it('TC-006 后-08-例3 安装与同步一个接一个：装好后加模型，命令随之同步', async () => {
    register({ loginEnv: async () => ({ status: 'ok', path: `${sb.bin}:/usr/bin`, codepal: null }) })
    await call('models:installCommands')
    await call('models:addModel', { providerId: 'zhipu-api', name: 'glm-5.3-air' })
    expect(fs.existsSync(path.join(sb.bin, 'codepal-zhipu-api--glm-5.3-air'))).toBe(true)
    expect(fs.existsSync(path.join(sb.bin, 'codepal'))).toBe(true)
  })

  it('TC-023 readyCount：只数测过能用、命令在的模型', async () => {
    register({ loginEnv: async () => ({ status: 'ok', path: `${sb.bin}:/usr/bin`, codepal: null }) })
    commands.installCommands({ appExecPath: process.execPath, cliPath: CLIP })
    expect((await call('models:list')).data.commands.readyCount).toBe(1)
    expect(shellProfile.PATH_LINE).toBe(LINE)
  })
})
