/**
 * 模块 A · V1.7.1 ~/.codex/ symlink farm 单元测试
 *
 * 覆盖：
 * - installHomeSymlinkFarm 改造 ~/.codex/ 为 symlink + 合并 + auth symlink
 * - 幂等：第二次调返 noop
 * - repointActiveAuthSymlink atomic 重建
 * - verifyHomeSymlinkFarm 检测 + 自愈
 * - 合并保留较新文件 / 跳过 auth.json
 *
 * @module 自动化测试/V1.7/moduleA-migration/codexHomeSymlinkFarm.test
 */

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')

const { makeIsolatedRoot, buildV17, makeFakeAuth } = require('../setup/testEnv')
const accountService = require('../../../electron/services/codexAccountService')
const farm = require('../../../electron/services/codexHomeSymlinkFarm')

describe('模块 A · codexHomeSymlinkFarm', () => {
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

  test('installHomeSymlinkFarm 在 ~/.codex/ 不存在时直接建 symlink', async () => {
    await buildV17(env, {
      accounts: [{ name: 'A', auth: makeFakeAuth({ accountId: 'a' }) }],
      active: 'A',
    })
    // 故意不建 env.codexDir
    expect(fs.existsSync(env.codexDir)).toBe(false)

    const r = await farm.installHomeSymlinkFarm()
    expect(r.ok).toBe(true)
    expect(r.action).toBe('installed')
    expect(r.activeAuthLinked).toBe('A')

    // ~/.codex 是 symlink → shared/.codex/
    const lst = fs.lstatSync(env.codexDir)
    expect(lst.isSymbolicLink()).toBe(true)
    expect(fs.readlinkSync(env.codexDir)).toBe(env.sharedCodexDir)

    // shared/.codex/auth.json 是 symlink → accounts/A/.codex/auth.json
    const authLink = path.join(env.sharedCodexDir, 'auth.json')
    expect(fs.lstatSync(authLink).isSymbolicLink()).toBe(true)
    expect(fs.readlinkSync(authLink)).toBe('../../accounts/A/.codex/auth.json')
    // 跟读 ~/.codex/auth.json 应该等于 accounts/A/.codex/auth.json
    const followed = JSON.parse(fs.readFileSync(path.join(env.codexDir, 'auth.json'), 'utf8'))
    const direct = JSON.parse(fs.readFileSync(path.join(env.accountHomeDir('A'), 'auth.json'), 'utf8'))
    expect(followed.tokens.account_id).toBe(direct.tokens.account_id)
  })

  test('installHomeSymlinkFarm 合并现有 ~/.codex/ 内容到 shared（保留较新文件）', async () => {
    await buildV17(env, {
      shared: { configToml: 'shared-old\n' },
      accounts: [{ name: 'A', auth: makeFakeAuth({ accountId: 'a' }) }],
      active: 'A',
    })
    // 在 shared/.codex/config.toml 写一个旧 mtime 版本
    const sharedConfig = path.join(env.sharedCodexDir, 'config.toml')
    const oldTime = new Date('2020-01-01').getTime() / 1000
    await fsp.utimes(sharedConfig, oldTime, oldTime)

    // 在 ~/.codex/ 建一个更新的版本 + 一个独有文件
    await fsp.mkdir(env.codexDir, { recursive: true })
    await fsp.writeFile(path.join(env.codexDir, 'config.toml'), 'home-newer\n')
    await fsp.writeFile(path.join(env.codexDir, 'history.jsonl'), 'session-1\nsession-2\n')
    await fsp.mkdir(path.join(env.codexDir, 'sessions'), { recursive: true })
    await fsp.writeFile(path.join(env.codexDir, 'sessions', 's1.json'), '{}')
    // 也放一个 auth.json（应被跳过，不合并）
    await fsp.writeFile(path.join(env.codexDir, 'auth.json'), JSON.stringify({ tokens: { account_id: 'lurking' } }))

    const r = await farm.installHomeSymlinkFarm()
    expect(r.ok).toBe(true)

    // 合并后 shared 含 home-newer + history.jsonl + sessions/s1.json
    expect(fs.readFileSync(path.join(env.sharedCodexDir, 'config.toml'), 'utf8')).toBe('home-newer\n')
    expect(fs.existsSync(path.join(env.sharedCodexDir, 'history.jsonl'))).toBe(true)
    expect(fs.existsSync(path.join(env.sharedCodexDir, 'sessions', 's1.json'))).toBe(true)
    // auth.json **没有**被合并到 shared/.codex/（auth.json 走 symlink）
    // 但 shared/.codex/auth.json 是建出来的 symlink，不是合并出来的真文件
    const authLink = path.join(env.sharedCodexDir, 'auth.json')
    expect(fs.lstatSync(authLink).isSymbolicLink()).toBe(true)
    // backup 保留了原 ~/.codex/（含 auth.json 那份）
    expect(r.backupPath).toMatch(/\.codex\.pre-symlink-farm-\d+/)
    expect(fs.existsSync(path.join(r.backupPath, 'auth.json'))).toBe(true)
  })

  test('installHomeSymlinkFarm 第二次调返 noop（幂等）', async () => {
    await buildV17(env, {
      accounts: [{ name: 'A', auth: makeFakeAuth({ accountId: 'a' }) }],
      active: 'A',
    })
    await farm.installHomeSymlinkFarm()
    const r2 = await farm.installHomeSymlinkFarm()
    expect(r2.ok).toBe(true)
    expect(r2.action).toBe('noop')
  })

  test('repointActiveAuthSymlink 切换账号时原子重建 auth symlink', async () => {
    await buildV17(env, {
      accounts: [
        { name: 'A', auth: makeFakeAuth({ accountId: 'a-id' }) },
        { name: 'B', auth: makeFakeAuth({ accountId: 'b-id' }) },
      ],
      active: 'A',
    })
    await farm.installHomeSymlinkFarm()

    // 现在 ~/.codex/auth.json → accounts/A/auth.json
    let followed = JSON.parse(fs.readFileSync(path.join(env.codexDir, 'auth.json'), 'utf8'))
    expect(followed.tokens.account_id).toBe('a-id')

    // 切到 B
    const r = await farm.repointActiveAuthSymlink('B')
    expect(r.ok).toBe(true)
    expect(r.target).toBe('../../accounts/B/.codex/auth.json')

    followed = JSON.parse(fs.readFileSync(path.join(env.codexDir, 'auth.json'), 'utf8'))
    expect(followed.tokens.account_id).toBe('b-id')

    // tmp link 不残留
    const sharedFiles = await fsp.readdir(env.sharedCodexDir)
    expect(sharedFiles.some((n) => n.startsWith('auth.json.tmp-'))).toBe(false)
  })

  test('repointActiveAuthSymlink 目标账号不存在返错', async () => {
    await buildV17(env, { accounts: [{ name: 'A', auth: makeFakeAuth({ accountId: 'a' }) }], active: 'A' })
    const r = await farm.repointActiveAuthSymlink('does-not-exist')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/account auth\.json missing/)
  })

  test('verifyHomeSymlinkFarm 检测真目录 → 自愈为 symlink farm', async () => {
    await buildV17(env, { accounts: [{ name: 'A', auth: makeFakeAuth({ accountId: 'a' }) }], active: 'A' })
    // 故意建真目录
    await fsp.mkdir(env.codexDir, { recursive: true })
    await fsp.writeFile(path.join(env.codexDir, 'leftover.txt'), 'hi')

    const r = await farm.verifyHomeSymlinkFarm()
    expect(r.ok).toBe(true)
    expect(r.homeStatus).toBe('symlink-ok') // 修好了
    expect(r.authSymlinkStatus).toBe('symlink-ok')
    expect(r.repaired.length).toBeGreaterThan(0)
    expect(fs.lstatSync(env.codexDir).isSymbolicLink()).toBe(true)
  })

  test('verifyHomeSymlinkFarm 检测 dangling auth 自愈', async () => {
    await buildV17(env, {
      accounts: [{ name: 'A', auth: makeFakeAuth({ accountId: 'a' }) }],
      active: 'A',
    })
    await farm.installHomeSymlinkFarm()

    // 故意把 auth symlink 弄成 wrong target
    const authLink = path.join(env.sharedCodexDir, 'auth.json')
    await fsp.unlink(authLink)
    await fsp.symlink('../../accounts/nonexistent/.codex/auth.json', authLink)

    const r = await farm.verifyHomeSymlinkFarm()
    expect(r.authSymlinkStatus).toBe('symlink-ok') // 已被修
    expect(fs.readlinkSync(authLink)).toBe('../../accounts/A/.codex/auth.json')
  })

  test('verifyHomeSymlinkFarm 当 active=null 时 authSymlinkStatus=no-active', async () => {
    await buildV17(env, { accounts: [], active: null })
    await farm.installHomeSymlinkFarm()

    const r = await farm.verifyHomeSymlinkFarm()
    expect(r.homeStatus).toBe('symlink-ok')
    expect(r.authSymlinkStatus).toBe('no-active')
  })

  test('switchAccountV17 联动 repoint auth symlink', async () => {
    await buildV17(env, {
      accounts: [
        { name: 'A', auth: makeFakeAuth({ accountId: 'a-id' }), state: { status: 'active' } },
        { name: 'B', auth: makeFakeAuth({ accountId: 'b-id' }), state: { status: 'active' } },
      ],
      active: 'A',
    })
    await farm.installHomeSymlinkFarm()
    // 初态：~/.codex/auth.json → A
    expect(JSON.parse(fs.readFileSync(path.join(env.codexDir, 'auth.json'), 'utf8')).tokens.account_id).toBe('a-id')

    // 切到 B（通过 switchAccountV17，注入 mock refresher）
    const r = await accountService.switchAccountV17('B', {
      refresher: async () => ({ ok: true }),
    })
    expect(r.ok).toBe(true)

    // ~/.codex/auth.json 现在指向 B
    expect(JSON.parse(fs.readFileSync(path.join(env.codexDir, 'auth.json'), 'utf8')).tokens.account_id).toBe('b-id')
  })
})
