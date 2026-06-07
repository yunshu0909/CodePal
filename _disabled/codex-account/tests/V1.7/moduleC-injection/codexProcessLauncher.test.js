/**
 * 模块 C · spawnCodex 注入 单元测试（mock spawn，不依赖真实 codex）
 *
 * 覆盖：
 * - TC-022（mock 版）spawnCodex 注入 CODEX_HOME 到 spawn env
 * - resolveCodexHome：active.json 缺失 / currentAccount=null / 目录不存在 / auth.json 不存在 各种错误
 * - spawnCodexAwait 捕获 stdout/code
 *
 * 注：真 Key 版 TC-022（依赖真实 codex CLI）会在 M3 真 Key 阶段手动验证，本文件用 mock spawn 验证注入逻辑。
 *
 * @module 自动化测试/V1.7/moduleC-injection/codexProcessLauncher.test
 */

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')

const { makeIsolatedRoot, buildV17, makeFakeAuth, installMockCodex } = require('../setup/testEnv')
const launcher = require('../../../electron/services/codexProcessLauncher')

describe('模块 C · codexProcessLauncher', () => {
  let env
  let restore

  beforeEach(async () => {
    env = makeIsolatedRoot()
    restore = env.apply()
  })

  afterEach(async () => {
    restore?.()
    await env.cleanup()
  })

  test('readActiveAccount 在 active.json 不存在时返 null', async () => {
    expect(await launcher.readActiveAccount()).toBeNull()
  })

  test('readActiveAccount 在 currentAccount=null 时返 null', async () => {
    await buildV17(env, { accounts: [], active: null })
    expect(await launcher.readActiveAccount()).toBeNull()
  })

  test('resolveCodexHome 没激活账号 → 抛 ActiveAccountMissingError', async () => {
    await buildV17(env, { accounts: [], active: null })
    await expect(launcher.resolveCodexHome()).rejects.toThrow('NO_ACTIVE_ACCOUNT')
  })

  test('resolveCodexHome 目录不存在 → 抛 ActiveAccountDirCorruptError', async () => {
    await buildV17(env, {
      shared: { configToml: '[profile]' },
      accounts: [{ name: 'A', auth: makeFakeAuth({ accountId: 'a' }) }],
      active: 'A',
    })
    // 删 A 的目录
    await fsp.rm(env.accountHomeDir('A'), { recursive: true, force: true })
    await expect(launcher.resolveCodexHome()).rejects.toThrow('ACTIVE_ACCOUNT_DIR_CORRUPT')
  })

  test('resolveCodexHome auth.json 不存在 → 抛 ActiveAccountDirCorruptError', async () => {
    await buildV17(env, {
      shared: { configToml: '[profile]' },
      accounts: [{ name: 'A', auth: makeFakeAuth({ accountId: 'a' }) }],
      active: 'A',
    })
    await fsp.unlink(path.join(env.accountHomeDir('A'), 'auth.json'))
    await expect(launcher.resolveCodexHome()).rejects.toThrow('ACTIVE_ACCOUNT_DIR_CORRUPT')
  })

  test('resolveCodexHome 正常返回 { codexHome, accountName }', async () => {
    await buildV17(env, {
      shared: { configToml: '[profile]' },
      accounts: [{ name: 'mywork', auth: makeFakeAuth({ accountId: 'a' }) }],
      active: 'mywork',
    })
    const result = await launcher.resolveCodexHome()
    expect(result.codexHome).toBe(env.accountHomeDir('mywork'))
    expect(result.accountName).toBe('mywork')
  })

  test('spawnCodex 注入 CODEX_HOME 到 spawn env（通过 mock spawn 函数）', async () => {
    await buildV17(env, {
      shared: { configToml: '[profile]' },
      accounts: [{ name: 'spawn-test', auth: makeFakeAuth({ accountId: 'a' }) }],
      active: 'spawn-test',
    })

    const spawnCalls = []
    const fakeSpawn = (cmd, args, opts) => {
      spawnCalls.push({ cmd, args, env: opts?.env, stdio: opts?.stdio })
      return { /* fake child */ pid: 12345 }
    }
    const result = await launcher.spawnCodex(['--help'], { spawn: fakeSpawn })
    expect(spawnCalls.length).toBe(1)
    expect(spawnCalls[0].cmd).toBe('codex')
    expect(spawnCalls[0].args).toEqual(['--help'])
    expect(spawnCalls[0].env.CODEX_HOME).toBe(env.accountHomeDir('spawn-test'))
    expect(result.codexHome).toBe(env.accountHomeDir('spawn-test'))
    expect(result.accountName).toBe('spawn-test')
  })

  test('TC-022（mock 版）spawnCodexAwait 真实 spawn 到 mock codex 二进制', async () => {
    await buildV17(env, {
      shared: { configToml: '[profile]' },
      accounts: [{ name: 'real-spawn', auth: makeFakeAuth({ accountId: 'a' }) }],
      active: 'real-spawn',
    })

    const mock = await installMockCodex(env, { exit: 0, stdout: 'codex 0.0.0-mock\n' })
    const prevPath = process.env.PATH
    process.env.PATH = mock.prependPath
    try {
      const result = await launcher.spawnCodexAwait(['--version'], { timeoutMs: 5000 })
      expect(result.code).toBe(0)
      expect(result.stdout).toContain('codex 0.0.0-mock')
      expect(result.codexHome).toBe(env.accountHomeDir('real-spawn'))
      // log 文件含正确 CODEX_HOME
      const log = JSON.parse(await fsp.readFile(mock.logFile, 'utf8'))
      expect(log.CODEX_HOME).toBe(env.accountHomeDir('real-spawn'))
      expect(log.args_json).toEqual(['--version'])
    } finally {
      process.env.PATH = prevPath
    }
  })

  test('extraEnv 注入额外环境变量（不覆盖 CODEX_HOME）', async () => {
    await buildV17(env, {
      shared: { configToml: '[profile]' },
      accounts: [{ name: 'extraenv', auth: makeFakeAuth({ accountId: 'a' }) }],
      active: 'extraenv',
    })
    const calls = []
    const fakeSpawn = (cmd, args, opts) => { calls.push({ env: opts.env }); return {} }
    await launcher.spawnCodex(['x'], { spawn: fakeSpawn, extraEnv: { MY_VAR: 'hello', CODEX_HOME: '/should-be-overridden' } })
    expect(calls[0].env.CODEX_HOME).toBe(env.accountHomeDir('extraenv')) // launcher 注入仍优先
    expect(calls[0].env.MY_VAR).toBe('hello')
  })
})
