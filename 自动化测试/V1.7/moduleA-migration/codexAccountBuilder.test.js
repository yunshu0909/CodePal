/**
 * 模块 A · 账户目录构建 单元测试
 *
 * 覆盖：
 * - TC-001 createAccount 建出 .codex 子目录 + 必建/可选 symlinks
 * - TC-002 createAccount 暖 .system 通过 spawn codex --version
 * - 边界：optional 文件不存在时不创建 symlink；必建目录在 shared 缺失时先 mkdir
 *
 * @module 自动化测试/V1.7/moduleA-migration/codexAccountBuilder.test
 */

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')

const { makeIsolatedRoot, installMockCodex } = require('../setup/testEnv')
const codexAccountBuilder = require('../../../electron/services/codexAccountBuilder')

describe('模块 A · codexAccountBuilder', () => {
  let env
  let restore

  beforeEach(async () => {
    env = makeIsolatedRoot()
    restore = env.apply()
    // 预建 shared/.codex/（含 config.toml 但不含 mcp_config.json）
    await fsp.mkdir(env.sharedCodexDir, { recursive: true })
    await fsp.writeFile(path.join(env.sharedCodexDir, 'config.toml'), '[profile]\nmodel = "gpt-5"\n')
  })

  afterEach(async () => {
    restore?.()
    await env.cleanup()
  })

  // TC-001
  test('TC-001 createAccount 建出 .codex 子目录 + 3 必建 symlinks（mcp_config 不存在则不建）', async () => {
    const result = await codexAccountBuilder.createAccount('test-account-1', {
      auth: { tokens: { access_token: 'fake-jwt', refresh_token: 'fake-rt-001' } },
      warmSystem: false, // TC-001 不要求 warm
    })

    expect(result.ok).toBe(true)
    expect(result.dir).toBe(env.accountHomeDir('test-account-1'))
    expect(fs.statSync(result.dir).isDirectory()).toBe(true)
    expect(fs.statSync(path.join(result.dir, 'auth.json')).isFile()).toBe(true)

    // auth.json 内容
    const auth = JSON.parse(await fsp.readFile(path.join(result.dir, 'auth.json'), 'utf8'))
    expect(auth.tokens.access_token).toBe('fake-jwt')

    // 3 个必建 symlinks（skills/sessions/logs）
    for (const name of ['skills', 'sessions', 'logs']) {
      const linkPath = path.join(result.dir, name)
      expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true)
      expect(fs.readlinkSync(linkPath)).toBe(`../../../shared/.codex/${name}`)
    }

    // config.toml symlink 存在（因为 shared 中存在）
    const configLink = path.join(result.dir, 'config.toml')
    expect(fs.lstatSync(configLink).isSymbolicLink()).toBe(true)
    expect(fs.readlinkSync(configLink)).toBe('../../../shared/.codex/config.toml')

    // mcp_config.json 不存在（shared 没有 → 不强制创建）
    expect(fs.existsSync(path.join(result.dir, 'mcp_config.json'))).toBe(false)

    // 必建目录自动 mkdir：skills/sessions/logs 都在 shared 中存在了
    expect(fs.statSync(path.join(env.sharedCodexDir, 'skills')).isDirectory()).toBe(true)
    expect(fs.statSync(path.join(env.sharedCodexDir, 'sessions')).isDirectory()).toBe(true)
    expect(fs.statSync(path.join(env.sharedCodexDir, 'logs')).isDirectory()).toBe(true)

    // symlinks 结构化报告
    const mandatory = result.symlinks.filter((s) => s.kind === 'mandatory')
    expect(mandatory.map((s) => s.name).sort()).toEqual(['logs', 'sessions', 'skills'])
    expect(mandatory.every((s) => s.created)).toBe(true)
    const optional = result.symlinks.filter((s) => s.kind === 'optional')
    expect(optional.find((s) => s.name === 'config.toml').created).toBe(true)
    expect(optional.find((s) => s.name === 'mcp_config.json').created).toBe(false)
  })

  test('TC-001+ shared 中也有 mcp_config.json 时 → optional symlink 建出', async () => {
    await fsp.writeFile(path.join(env.sharedCodexDir, 'mcp_config.json'), '{"servers":{}}')
    const result = await codexAccountBuilder.createAccount('with-mcp', {
      auth: { tokens: { access_token: 'fake-jwt' } },
      warmSystem: false,
    })
    const linkPath = path.join(result.dir, 'mcp_config.json')
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true)
    expect(fs.readlinkSync(linkPath)).toBe('../../../shared/.codex/mcp_config.json')
  })

  test('shared 中无 skills/sessions/logs 时，buildAccountDir 自动 mkdir 再建 symlink', async () => {
    // 删掉刚 beforeEach 建的 config.toml + shared 整体，让 sharedDir 空
    await fsp.rm(env.sharedCodexDir, { recursive: true, force: true })
    await fsp.mkdir(env.sharedCodexDir, { recursive: true }) // shared 存在但空

    const result = await codexAccountBuilder.buildAccountDir('empty-shared', {
      auth: { tokens: { access_token: 'fake' } },
    })
    expect(result.ok).toBe(true)
    for (const name of ['skills', 'sessions', 'logs']) {
      expect(fs.statSync(path.join(env.sharedCodexDir, name)).isDirectory()).toBe(true)
      expect(fs.lstatSync(path.join(result.dir, name)).isSymbolicLink()).toBe(true)
    }
  })

  test('state.json 可选写入', async () => {
    const result = await codexAccountBuilder.buildAccountDir('with-state', {
      auth: { tokens: { access_token: 'fake' } },
      state: { status: 'invalid', permanentReason: 'Revoked' },
    })
    const state = JSON.parse(await fsp.readFile(path.join(result.dir, 'state.json'), 'utf8'))
    expect(state).toEqual({ status: 'invalid', permanentReason: 'Revoked' })
  })

  // TC-002
  test('TC-002 createAccount 默认 warm .system: spawn codex --version 注入 CODEX_HOME', async () => {
    const mock = await installMockCodex(env)
    const prevPath = process.env.PATH
    process.env.PATH = mock.prependPath
    try {
      const result = await codexAccountBuilder.createAccount('test-warm', {
        auth: { tokens: { access_token: 'fake' } },
        spawnTimeoutMs: 5000,
      })
      expect(result.warmed.attempted).toBe(true)
      expect(result.warmed.ok).toBe(true)
      expect(result.warmed.code).toBe(0)

      // 检查 mock 写出的 log
      const log = JSON.parse(await fsp.readFile(mock.logFile, 'utf8'))
      expect(log.CODEX_HOME).toBe(env.accountHomeDir('test-warm'))
      expect(log.args_json).toEqual(['--version'])
    } finally {
      process.env.PATH = prevPath
    }
  })

  test('warm .system 失败时不抛错，仍返 ok=true', async () => {
    // 不安装 mock codex；PATH 改为只含一个空目录
    const prevPath = process.env.PATH
    process.env.PATH = '/nonexistent-bin-dir-12345'
    try {
      const result = await codexAccountBuilder.createAccount('test-warm-fail', {
        auth: { tokens: { access_token: 'fake' } },
        spawnTimeoutMs: 2000,
      })
      expect(result.ok).toBe(true)
      expect(result.warmed.attempted).toBe(true)
      expect(result.warmed.ok).toBe(false)
    } finally {
      process.env.PATH = prevPath
    }
  })

  test('warmSystem=false 时跳过 spawn', async () => {
    const result = await codexAccountBuilder.createAccount('no-warm', {
      auth: { tokens: { access_token: 'fake' } },
      warmSystem: false,
    })
    expect(result.warmed).toEqual({ attempted: false })
  })
})
