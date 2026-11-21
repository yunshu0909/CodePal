/**
 * @vitest-environment node
 *
 * #99 模型接入进页不再卡住整个应用
 *
 * 负责：
 * - models:list 不等 `claude --version`：替身 claude 睡着时列表照样马上回来，主进程不卡
 * - models:claudeStatus 等到后台这次查完的结果
 * - 重开（重新注册处理器、同一个模型目录）先用上次存下的版本结果
 * - 换版本、卸载后指纹变了，不沿用旧结果
 * - 记录文件只存几项小字段，坏了当没有；重新检测期间旧的那次结果不写回
 *
 * @module tests/models/claudeCheckNoFreeze.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { makeSandbox, REPO } from './helpers'

const require = createRequire(import.meta.url)
const { registerModelsHandlers } = require('../../electron/modules/models/ipc.js')
const claudeCli = require('../../electron/modules/models/claudeCli.js')
const { createClaudeCheck } = require('../../electron/modules/models/claudeCheck.js')

const SLOW_MS = 1500

let sb
let api
let handlers
let fakeBin

/** 写一个会先睡一会再报版本的替身 claude；padding 让文件大小也跟着版本变 */
function writeFake(version, { sleepMs = SLOW_MS } = {}) {
  const sleep = (sleepMs / 1000).toFixed(2)
  // 写临时文件再改名：正在跑的旧替身读的还是旧文件（和真实升级换文件一样）
  const tmp = `${fakeBin}.tmp`
  fs.writeFileSync(tmp, `#!/bin/sh\n# ${version}\nsleep ${sleep}\nprintf '%s (Claude Code)\\n' '${version}'\n`, { mode: 0o755 })
  // 同一秒里重写也要让修改时间不同（有的文件系统只到秒）
  const t = Date.now() / 1000 + Math.random() * 100
  fs.utimesSync(tmp, t, t)
  fs.renameSync(tmp, fakeBin)
}

function register(extra = {}) {
  handlers = {}
  api = registerModelsHandlers({
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn } },
    getMainWindow: () => null,
    cliPath: path.join(REPO, 'electron/modules/models/cli.cjs'),
    appExecPath: process.execPath,
    loginPath: () => `/usr/bin:${sb.bin}`,
    ...extra,
  })
}

/** 主进程同步卡住 ms 毫秒（模拟同步等登录 shell） */
function blockFor(ms) {
  const end = Date.now() + ms
  while (Date.now() < end) { /* 卡住 */ }
}

const call = (ch, arg) => handlers[ch]({}, arg)

/** 跑 fn 期间每 20 毫秒看一次事件循环，返回 fn 的结果、用时和最大卡顿 */
async function watchLag(fn) {
  let last = Date.now()
  let maxLag = 0
  const timer = setInterval(() => {
    const now = Date.now()
    maxLag = Math.max(maxLag, now - last - 20)
    last = now
  }, 20)
  const t0 = Date.now()
  try {
    const value = await fn()
    const ms = Date.now() - t0
    // 让采样至少在操作之后再跑一次：同步卡住的那段要算进去
    await new Promise((resolve) => setTimeout(resolve, 60))
    return { value, ms, maxLag }
  } finally {
    clearInterval(timer)
  }
}

const recordFile = () => path.join(sb.models, 'claude-check.json')

beforeEach(() => {
  sb = makeSandbox()
  fakeBin = path.join(sb.root, 'claude')
  writeFake('2.1.300')
  for (const [k, v] of Object.entries(sb.env)) process.env[k] = v
  process.env.CODEPAL_CLAUDE_BIN = fakeBin
  register()
})

afterEach(() => {
  api.stop()
  for (const k of Object.keys(sb.env)) if (k !== 'PATH' && k !== 'HOME') delete process.env[k]
  sb.cleanup()
})

describe('#99 进模型接入不等 Claude Code 版本', () => {
  it('第一次进页：列表 0.3 秒内回来，版本那一处先空着，主进程不卡', async () => {
    const r = await watchLag(() => call('models:list'))
    expect(r.value.success).toBe(true)
    expect(r.value.data.providers.deepseek).toBeTruthy()
    expect(r.value.data.claudeCode).toBeNull()
    expect(r.value.data.claudeChecking).toBe(true)
    expect(r.ms).toBeLessThan(300)
    expect(r.maxLag).toBeLessThan(200)
    // 后台那次查的整个过程中主进程也不卡
    const during = await watchLag(() => call('models:claudeStatus'))
    expect(during.maxLag).toBeLessThan(200)
  }, 10000)

  it('登录 shell 慢（终端判断 0.65 秒）：列表照样 0.3 秒内回来，终端那一行再补', async () => {
    api.stop()
    register({ loginPath: undefined, loginEnv: () => new Promise((resolve) => setTimeout(() => resolve({ status: 'ok', path: `/usr/bin:${sb.bin}`, codepal: null }), 650)) })
    const r = await watchLag(() => call('models:list'))
    expect(r.ms).toBeLessThan(300)
    expect(r.value.data.providers.deepseek).toBeTruthy()
    expect(r.value.data.commands).toBeNull()
    expect(r.value.data.commandsChecking).toBe(true)
    const commands = await call('models:commandsStatus')
    expect(commands).toMatchObject({ success: true, data: { onPath: true } })
  }, 10000)

  it('models:claudeStatus 等到后台结果：从进页起 4 秒内补上', async () => {
    const r = await watchLag(async () => {
      await call('models:list')
      return call('models:claudeStatus')
    })
    expect(r.value).toMatchObject({ success: true, data: { found: true, version: '2.1.300', tooOld: false, required: '2.1.251' } })
    expect(r.ms).toBeLessThan(4000)
    expect(r.maxLag).toBeLessThan(200)
    // 查完后再进页直接带回结果，不再查
    const again = await call('models:list')
    expect(again.data.claudeCode).toMatchObject({ found: true, version: '2.1.300' })
    expect(again.data.claudeChecking).toBe(false)
  }, 10000)

  it('重开后先用上次的结果，不用等', async () => {
    await call('models:list')
    await call('models:claudeStatus')
    api.stop()
    register()
    const r = await watchLag(() => call('models:list'))
    expect(r.value.data.claudeCode).toMatchObject({ found: true, version: '2.1.300', tooOld: false })
    expect(r.ms).toBeLessThan(300)
    // 本次运行还没核过：后台再核一次，结果不变
    const status = await call('models:claudeStatus')
    expect(status.data).toMatchObject({ found: true, version: '2.1.300' })
  }, 15000)

  it('换了版本（升级或降到太旧）：不沿用旧结果，查完跟着变', async () => {
    await call('models:list')
    await call('models:claudeStatus')
    writeFake('2.1.200')
    const list = await call('models:list')
    expect(list.data.claudeCode).toBeNull()
    expect(list.data.claudeChecking).toBe(true)
    expect((await call('models:claudeStatus')).data).toMatchObject({ found: true, version: '2.1.200', tooOld: true })

    // 重开后也认得出：记录里是 2.1.200，再换成 2.1.310
    api.stop()
    writeFake('2.1.310')
    register()
    const reopened = await call('models:list')
    expect(reopened.data.claudeCode).toBeNull()
    expect((await call('models:claudeStatus')).data).toMatchObject({ found: true, version: '2.1.310', tooOld: false })
  }, 20000)

  it('卸载后：不沿用旧结果，查完是没找到', async () => {
    await call('models:list')
    await call('models:claudeStatus')
    fs.unlinkSync(fakeBin)
    const list = await call('models:list')
    expect(list.data.claudeCode).toBeNull()
    expect((await call('models:claudeStatus')).data).toMatchObject({ found: false })

    api.stop()
    register()
    expect((await call('models:list')).data.claudeCode).toBeNull()
  }, 15000)

  it('记录文件只存几项小字段；坏的记录当没有', async () => {
    await call('models:list')
    await call('models:claudeStatus')
    const saved = JSON.parse(fs.readFileSync(recordFile(), 'utf8'))
    expect(Object.keys(saved).sort()).toEqual(['at', 'bin', 'fingerprint', 'schema', 'version'])
    expect(saved.version).toBe('2.1.300')
    expect(saved.bin).toBe(fakeBin)

    api.stop()
    fs.writeFileSync(recordFile(), '{坏了')
    register()
    const list = await call('models:list')
    expect(list.success).toBe(true)
    expect(list.data.claudeCode).toBeNull()
    expect((await call('models:claudeStatus')).data).toMatchObject({ found: true, version: '2.1.300' })
  }, 15000)

  it('通道注销后还在跑的那次不写记录，环境换了也不写到别处（测试泄漏到真实目录的教训）', async () => {
    await call('models:list')
    api.stop()
    const elsewhere = path.join(sb.root, 'elsewhere')
    process.env.CODEPAL_MODELS_HOME = elsewhere
    await new Promise((resolve) => setTimeout(resolve, SLOW_MS + 500))
    expect(fs.existsSync(recordFile())).toBe(false)
    expect(fs.existsSync(path.join(elsewhere, 'claude-check.json'))).toBe(false)
    process.env.CODEPAL_MODELS_HOME = sb.models
    register()
  }, 10000)

  it('重新检测不卡主进程；重查期间旧的那次结果不写回', async () => {
    await call('models:list')
    // 第一次还在睡，这时换成新版本并点「重新检测」
    writeFake('2.1.320', { sleepMs: 300 })
    const r = await watchLag(() => call('models:recheckClaude'))
    expect(r.value.data).toMatchObject({ found: true, version: '2.1.320' })
    expect(r.maxLag).toBeLessThan(200)
    // 等最开始那次也结束，结果和记录都还是新的
    await new Promise((resolve) => setTimeout(resolve, SLOW_MS + 300))
    expect((await call('models:claudeStatus')).data).toMatchObject({ version: '2.1.320' })
    expect((await call('models:list')).data.claudeCode).toMatchObject({ version: '2.1.320' })
    expect(JSON.parse(fs.readFileSync(recordFile(), 'utf8')).version).toBe('2.1.320')
  }, 15000)

  it('重新检测作废正在跑的那次：等着的人马上拿到新结果，不用等旧的那次跑完', async () => {
    await call('models:list')
    const waiting = call('models:claudeStatus')
    writeFake('2.1.330', { sleepMs: 100 })
    const t0 = Date.now()
    const rechecked = await call('models:recheckClaude')
    const waited = await waiting
    expect(Date.now() - t0).toBeLessThan(SLOW_MS)
    expect(rechecked.data).toMatchObject({ version: '2.1.330' })
    expect(waited.data).toMatchObject({ version: '2.1.330' })
  }, 10000)

  it('重新检测时审核配置刷新不在主进程里同步问 shell（用这次查到的结果）', async () => {
    // 模拟只有登录 shell 才找得到的 claude：常见位置找不到，后台问 shell 找到替身
    const quick = vi.spyOn(claudeCli, 'locateClaudeQuick').mockReturnValue(null)
    const viaShell = vi.spyOn(claudeCli, 'locateClaudeAsync').mockResolvedValue(fakeBin)
    const hubLocate = vi.fn(() => { blockFor(350); return fakeBin })
    try {
      api.stop()
      writeFake('2.1.300', { sleepMs: 100 })
      register({ hubOptions: { locateClaude: hubLocate, locateCodex: () => null } })
      // 注册时的启动对账、刚建目录引起的状态目录通知都还没查过版本，照旧自己找；等它们过去再看重新检测这一下
      await new Promise((resolve) => setTimeout(resolve, 500))
      hubLocate.mockClear()
      const r = await watchLag(() => call('models:recheckClaude'))
      expect(r.value.data).toMatchObject({ found: true, version: '2.1.300' })
      expect(hubLocate).not.toHaveBeenCalled()
      expect(r.maxLag).toBeLessThan(200)
    } finally {
      quick.mockRestore()
      viaShell.mockRestore()
    }
  }, 10000)
})

describe('#99 只有登录 shell 找得到的 claude', () => {
  it('shell 里换了路径（旧文件还在）或刚装好：进页时后台再问一次 shell，结果跟着变', async () => {
    const quick = vi.spyOn(claudeCli, 'locateClaudeQuick').mockReturnValue(null)
    const viaShell = vi.spyOn(claudeCli, 'locateClaudeAsync').mockResolvedValue(null)
    const check = createClaudeCheck({ reverifyMs: 0 })
    try {
      expect(check.peek().info).toBeNull()
      expect(await check.status()).toMatchObject({ found: false })
      // 刚装好（只在 shell 的 PATH 上）
      writeFake('2.1.300', { sleepMs: 0 })
      viaShell.mockResolvedValue(fakeBin)
      expect(check.peek()).toMatchObject({ info: { found: false }, checking: true })
      expect(await check.status()).toMatchObject({ found: true, version: '2.1.300' })
      // shell 的 PATH 换到另一份新版本，旧文件还在
      const other = path.join(sb.root, 'claude-new')
      fs.writeFileSync(other, "#!/bin/sh\nprintf '2.1.340 (Claude Code)\\n'\n", { mode: 0o755 })
      viaShell.mockResolvedValue(other)
      expect(check.peek()).toMatchObject({ info: { version: '2.1.300' }, checking: true })
      expect(await check.status()).toMatchObject({ found: true, version: '2.1.340' })
    } finally {
      check.stop()
      quick.mockRestore()
      viaShell.mockRestore()
    }
  }, 10000)

  it('shell 没答上来（超时、出错）不当「没装」：审核配置照旧自己找；shell 正常答了没有才算确定', async () => {
    const quick = vi.spyOn(claudeCli, 'locateClaudeQuick').mockReturnValue(null)
    const viaShell = vi.spyOn(claudeCli, 'locateClaudeAsync').mockResolvedValue(undefined)
    const check = createClaudeCheck({ reverifyMs: 0 })
    try {
      expect(await check.status()).toMatchObject({ found: false })
      expect(check.knownBin()).toBeUndefined()
      viaShell.mockResolvedValue(null)
      expect(await check.recheck()).toMatchObject({ found: false })
      expect(check.knownBin()).toBeNull()
    } finally {
      check.stop()
      quick.mockRestore()
      viaShell.mockRestore()
    }
  }, 10000)

  it('版本命令偶发没读出版本号：文件没变也会在下次进页时再查', async () => {
    const flag = path.join(sb.root, 'ok-now')
    fs.writeFileSync(fakeBin, `#!/bin/sh\n[ -f '${flag}' ] || exit 1\nprintf '2.1.300 (Claude Code)\\n'\n`, { mode: 0o755 })
    const check = createClaudeCheck({ reverifyMs: 0 })
    try {
      check.peek()
      expect(await check.status()).toMatchObject({ found: true, version: null })
      fs.writeFileSync(flag, '')
      expect(check.peek().checking).toBe(true)
      expect(await check.status()).toMatchObject({ found: true, version: '2.1.300', tooOld: false })
    } finally {
      check.stop()
    }
  }, 10000)
})

describe('#99 退出时', () => {
  it('重新检测途中应用退出：不再刷新审核配置，不留下写锁', async () => {
    writeFake('2.1.300', { sleepMs: 500 })
    const pending = call('models:recheckClaude')
    await new Promise((resolve) => setTimeout(resolve, 100))
    api.stop()
    await pending
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(fs.existsSync(path.join(sb.models, '.write.lock'))).toBe(false)
    register()
  }, 10000)
})

