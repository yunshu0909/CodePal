/**
 * V1.7 测试地基冒烟 (TC-地基-001)
 *
 * 验证 M0 测试地基自身正确：
 * - CODEX_SWITCHER_HOME 环境变量被 codexAccountService 正确读取
 * - makeIsolatedRoot 产生的目录独立、apply/restore 工作
 * - buildLegacyV16 / buildV17 fixture 结构符合预期
 * - mock codex 能记录 spawn env
 *
 * 这是所有 V1.7 用例的资格地基，本测试不过则全流程停。
 *
 * @module 自动化测试/V1.7/setup/testEnv.smoke.test
 */

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const accountService = require('../../../electron/services/codexAccountService')
const {
  makeIsolatedRoot,
  buildLegacyV16,
  buildV17,
  makeFakeAuth,
  makeFakeJwt,
  installMockCodex,
} = require('./testEnv')

const I = accountService.__INTERNAL__

describe('M0 · 测试地基冒烟', () => {
  let env
  let restore

  beforeEach(() => {
    env = makeIsolatedRoot()
    restore = env.apply()
  })

  afterEach(async () => {
    restore?.()
    await env.cleanup()
  })

  test('CODEX_SWITCHER_HOME 优先级链：env > __setHomeDir > os.homedir', () => {
    // env 已注入
    expect(I.getStoreDir()).toBe(env.switcherDir)
    expect(I.getSharedCodexDir()).toBe(path.join(env.switcherDir, 'shared', '.codex'))
    expect(I.getAccountHomeDir('myacct')).toBe(path.join(env.switcherDir, 'accounts', 'myacct', '.codex'))
    expect(I.getActiveJsonFile()).toBe(path.join(env.switcherDir, 'active.json'))
    // .codex 走 env 的父目录
    expect(I.getAuthFile()).toBe(path.join(env.root, '.codex', 'auth.json'))
  })

  test('env 解除后回到 __setHomeDir / os.homedir', () => {
    restore()
    restore = null
    expect(process.env.CODEX_SWITCHER_HOME).toBeUndefined()
    // 走 _homeDir（默认 os.homedir，不会污染本测试 root）
    const storeDir = I.getStoreDir()
    expect(storeDir.startsWith(env.root)).toBe(false)
    expect(storeDir.endsWith('.codex-switcher')).toBe(true)
  })

  test('buildLegacyV16 构造完整 V1.6 旧目录', async () => {
    await buildLegacyV16(env, {
      liveAuth: makeFakeAuth({ accountId: 'fake-acct-live', refreshToken: 'fake-rt-live' }),
      slots: [
        { name: 'work', auth: makeFakeAuth({ accountId: 'fake-acct-work', refreshToken: 'fake-rt-work' }) },
        { name: 'personal', auth: makeFakeAuth({ accountId: 'fake-acct-pers', refreshToken: 'fake-rt-pers' }) },
      ],
      current: 'work',
      shared: {
        configToml: '[profile]\nmodel = "gpt-4"',
        skills: [{ name: 'demo-skill' }],
      },
    })

    expect(fs.existsSync(path.join(env.codexDir, 'auth.json'))).toBe(true)
    expect(fs.existsSync(path.join(env.codexDir, 'config.toml'))).toBe(true)
    expect(fs.existsSync(path.join(env.codexDir, 'skills', 'demo-skill', 'SKILL.md'))).toBe(true)
    expect(fs.existsSync(path.join(env.switcherDir, 'accounts', 'work.json'))).toBe(true)
    expect(fs.existsSync(path.join(env.switcherDir, 'accounts', 'personal.json'))).toBe(true)
    expect(fs.readFileSync(path.join(env.switcherDir, 'current'), 'utf8')).toBe('work')

    const live = JSON.parse(await fsp.readFile(path.join(env.codexDir, 'auth.json'), 'utf8'))
    expect(live.tokens.account_id).toBe('fake-acct-live')
    expect(live.tokens.refresh_token).toBe('fake-rt-live')
  })

  test('buildV17 构造完整 V1.7 结构 + symlink 必建/可选', async () => {
    await buildV17(env, {
      shared: {
        configToml: '[profile]',
        hasSkillsDir: true,
        hasSessionsDir: true,
        hasLogsDir: true,
        // 不建 mcp_config.json
      },
      accounts: [
        { name: 'A', auth: makeFakeAuth({ accountId: 'fake-acct-A' }) },
        { name: 'B', auth: makeFakeAuth({ accountId: 'fake-acct-B' }), state: { status: 'invalid', permanentReason: 'Revoked' } },
      ],
      active: 'A',
    })

    // 共享目录就位
    expect(fs.existsSync(path.join(env.sharedCodexDir, 'config.toml'))).toBe(true)
    expect(fs.lstatSync(path.join(env.sharedCodexDir, 'skills')).isDirectory()).toBe(true)
    expect(fs.existsSync(path.join(env.sharedCodexDir, 'mcp_config.json'))).toBe(false)

    // 账户 A：5 个槽位中 4 个 symlink（config.toml / skills / sessions / logs），不含 mcp
    const aHome = env.accountHomeDir('A')
    expect(fs.statSync(path.join(aHome, 'auth.json')).isFile()).toBe(true)
    for (const name of ['config.toml', 'skills', 'sessions', 'logs']) {
      const linkPath = path.join(aHome, name)
      expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true)
      // 3 级 ../ 是关键
      expect(fs.readlinkSync(linkPath)).toBe(`../../../shared/.codex/${name}`)
    }
    expect(fs.existsSync(path.join(aHome, 'mcp_config.json'))).toBe(false)

    // 账户 B：state.json 写入成功
    const bState = JSON.parse(await fsp.readFile(path.join(env.accountHomeDir('B'), 'state.json'), 'utf8'))
    expect(bState).toEqual({ status: 'invalid', permanentReason: 'Revoked' })

    // active.json 就位
    const active = JSON.parse(await fsp.readFile(env.activeJsonFile, 'utf8'))
    expect(active.currentAccount).toBe('A')
    expect(active.version).toBe('v1.7')
    expect(active.migratedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  test('makeFakeJwt iat 字段可被解码', () => {
    const jwt = makeFakeJwt({ iatSecondsAgo: 3600 })
    const [, payloadB64] = jwt.split('.')
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'))
    const now = Math.floor(Date.now() / 1000)
    expect(payload.iat).toBeGreaterThan(now - 3700)
    expect(payload.iat).toBeLessThan(now - 3500)
  })

  test('installMockCodex 能记录 CODEX_HOME 和 args', async () => {
    const mock = await installMockCodex(env)
    expect(fs.existsSync(path.join(mock.mockBinDir, 'codex'))).toBe(true)

    const fakeCodexHome = env.accountHomeDir('demo')
    await fsp.mkdir(fakeCodexHome, { recursive: true })

    const result = spawnSync('codex', ['--version'], {
      env: { ...process.env, PATH: mock.prependPath, CODEX_HOME: fakeCodexHome },
      encoding: 'utf8',
    })
    expect(result.status).toBe(0)

    const log = JSON.parse(await fsp.readFile(mock.logFile, 'utf8'))
    expect(log.CODEX_HOME).toBe(fakeCodexHome)
    expect(log.args_json).toEqual(['--version'])
  })
})
