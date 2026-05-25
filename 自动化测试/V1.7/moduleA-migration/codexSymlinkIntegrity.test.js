/**
 * 模块 A · symlink 完整性自愈 单元测试
 *
 * 覆盖：
 * - TC-008 缺失 symlink 被重建
 * - TC-009 被破坏成普通文件的 symlink 备份后重建
 * - 边界：可选项缺失 + shared 也无 → 跳过；dangling symlink 重建；多账户批量
 *
 * @module 自动化测试/V1.7/moduleA-migration/codexSymlinkIntegrity.test
 */

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')

const { makeIsolatedRoot, buildV17, makeFakeAuth } = require('../setup/testEnv')
const { verifyAccountIntegrity, verifyAllAccounts } = require('../../../electron/services/codexSymlinkIntegrity')

describe('模块 A · codexSymlinkIntegrity', () => {
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

  // TC-008
  test('TC-008 缺失 symlink 被自动重建', async () => {
    await buildV17(env, {
      shared: { configToml: '[profile]\n' },
      accounts: [
        {
          name: 'A',
          auth: makeFakeAuth({ accountId: 'fake-acct-A' }),
          skipSymlinks: ['skills'], // 故意不建 skills
        },
      ],
    })

    // 先确认 skills symlink 不存在
    const linkPath = path.join(env.accountHomeDir('A'), 'skills')
    expect(fs.existsSync(linkPath)).toBe(false)

    const result = await verifyAccountIntegrity('A')
    expect(result.ok).toBe(true)
    expect(result.repaired).toContain('skills')
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true)
    expect(fs.readlinkSync(linkPath)).toBe('../../../shared/.codex/skills')
  })

  // TC-009
  test('TC-009 被破坏成普通文件的 symlink 备份后重建', async () => {
    await buildV17(env, {
      shared: { configToml: 'theme = "light"\n' },
      accounts: [
        {
          name: 'A',
          auth: makeFakeAuth({ accountId: 'fake-acct-A' }),
          skipSymlinks: ['config.toml'],
        },
      ],
    })
    // 写一个普通文件占位 config.toml（破坏 symlink 形态）
    const homePath = env.accountHomeDir('A')
    const broken = path.join(homePath, 'config.toml')
    await fsp.writeFile(broken, 'theme = "dark"\n', 'utf8')
    expect(fs.lstatSync(broken).isSymbolicLink()).toBe(false)

    // 收集 logger warn
    const warnings = []
    const logger = { warn: (msg) => warnings.push(msg) }

    const result = await verifyAccountIntegrity('A', { logger })
    expect(result.ok).toBe(true)
    expect(result.repaired).toContain('config.toml')
    expect(result.conflict).toContain('config.toml')

    // 重建后是 symlink
    expect(fs.lstatSync(broken).isSymbolicLink()).toBe(true)

    // .conflict-backup 文件存在
    const backupName = (await fsp.readdir(homePath)).find((n) => n.startsWith('config.toml.conflict-backup-'))
    expect(backupName).toBeTruthy()
    expect(await fsp.readFile(path.join(homePath, backupName), 'utf8')).toBe('theme = "dark"\n')

    // 日志含警告
    expect(warnings.some((m) => m.includes('config.toml') && m.includes('备份到'))).toBe(true)

    // shared 的 config.toml 原样保留（不被覆盖）
    expect(await fsp.readFile(path.join(env.sharedCodexDir, 'config.toml'), 'utf8')).toBe('theme = "light"\n')
  })

  test('已存在的合法 symlink → skipped 不重建', async () => {
    await buildV17(env, {
      shared: { configToml: '[profile]\n' },
      accounts: [{ name: 'A', auth: makeFakeAuth({ accountId: 'a' }) }],
    })
    const result = await verifyAccountIntegrity('A')
    expect(result.ok).toBe(true)
    expect(result.repaired).toEqual([])
    expect(result.skipped).toEqual(expect.arrayContaining(['skills', 'sessions', 'logs', 'config.toml']))
  })

  test('可选项 shared 不存在时跳过（不强制创建空 mcp_config.json）', async () => {
    await buildV17(env, {
      shared: { configToml: '[profile]\n' /* 不写 mcp */ },
      accounts: [{ name: 'A', auth: makeFakeAuth({ accountId: 'a' }) }],
    })
    const result = await verifyAccountIntegrity('A')
    expect(result.skipped).toContain('mcp_config.json')
    expect(fs.existsSync(path.join(env.sharedCodexDir, 'mcp_config.json'))).toBe(false)
    expect(fs.existsSync(path.join(env.accountHomeDir('A'), 'mcp_config.json'))).toBe(false)
  })

  test('dangling symlink（target 已删）被重建', async () => {
    await buildV17(env, {
      shared: { configToml: '[profile]\n' },
      accounts: [{ name: 'A', auth: makeFakeAuth({ accountId: 'a' }) }],
    })
    // 删 shared/skills → symlink 变 dangling
    await fsp.rm(path.join(env.sharedCodexDir, 'skills'), { recursive: true, force: true })
    const result = await verifyAccountIntegrity('A')
    expect(result.repaired).toContain('skills')
    expect(fs.lstatSync(path.join(env.accountHomeDir('A'), 'skills')).isSymbolicLink()).toBe(true)
    expect(fs.statSync(path.join(env.sharedCodexDir, 'skills')).isDirectory()).toBe(true) // 重建时 mkdir
  })

  test('account 目录缺失 → ok=false + ACCOUNT_DIR_MISSING', async () => {
    const result = await verifyAccountIntegrity('Nope')
    expect(result.ok).toBe(false)
    expect(result.error).toBe('ACCOUNT_DIR_MISSING')
  })

  test('verifyAllAccounts 跑全量', async () => {
    await buildV17(env, {
      shared: { configToml: '[profile]\n' },
      accounts: [
        { name: 'A', auth: makeFakeAuth({ accountId: 'a' }), skipSymlinks: ['logs'] },
        { name: 'B', auth: makeFakeAuth({ accountId: 'b' }) },
      ],
    })
    const report = await verifyAllAccounts()
    expect(Object.keys(report).sort()).toEqual(['A', 'B'])
    expect(report.A.repaired).toContain('logs')
    expect(report.B.repaired).toEqual([])
  })
})
