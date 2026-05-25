/**
 * 模块 A · codexMigrator 单元测试
 *
 * 覆盖：
 * - TC-003 shouldMigrate 检测 active.json 不存在
 * - TC-004 validateStaging 拒绝损坏 symlink
 * - TC-005 atomic rename 失败时永不删旧数据 + 写 migration-failed.log
 * - TC-006 副本 account_id 匹配 live auth → 用 live 覆盖（refresh_token = 'live-rt-new'）
 * - TC-007 旧 ~/.codex/auth.json quarantine 到 .codex.legacy-backup-<ts>/
 * - 边界：fresh install / dedup / live 不匹配任何 slot → imported-from-legacy / live 损坏 → currentAccount=null
 *
 * @module 自动化测试/V1.7/moduleA-migration/codexMigrator.test
 */

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
// vi 由 vitest globals 注入（vitest.config.globals=true），不需要 require

const { makeIsolatedRoot, buildLegacyV16, makeFakeAuth } = require('../setup/testEnv')
const codexMigrator = require('../../../electron/services/codexMigrator')

describe('模块 A · codexMigrator', () => {
  let env
  let restore

  beforeEach(() => {
    env = makeIsolatedRoot()
    restore = env.apply()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    restore?.()
    await env.cleanup()
  })

  // TC-003
  test('TC-003 shouldMigrate 在 active.json 不存在时返 true，存在时返 false', async () => {
    expect(codexMigrator.shouldMigrate()).toBe(true)
    await fsp.mkdir(env.switcherDir, { recursive: true })
    await fsp.writeFile(env.activeJsonFile, JSON.stringify({ currentAccount: 'A', version: 'v1.7' }))
    expect(codexMigrator.shouldMigrate()).toBe(false)
  })

  // TC-004
  test('TC-004 validateStaging 拒绝损坏 symlink', async () => {
    // 自己造一个 staging：account A 的 skills symlink 指向不存在的 target
    const staging = path.join(env.root, '.codex-switcher.v1.7-staging-test')
    const sharedDir = path.join(staging, 'shared', '.codex')
    const accountsDir = path.join(staging, 'accounts')
    await fsp.mkdir(sharedDir, { recursive: true })
    // 故意不建 skills 目录 → dangling symlink
    const homeA = path.join(accountsDir, 'A', '.codex')
    await fsp.mkdir(homeA, { recursive: true })
    await fsp.writeFile(path.join(homeA, 'auth.json'), JSON.stringify(makeFakeAuth({ accountId: 'a' })))
    // 必建 sessions / logs 用正常 symlink
    await fsp.mkdir(path.join(sharedDir, 'sessions'), { recursive: true })
    await fsp.mkdir(path.join(sharedDir, 'logs'), { recursive: true })
    await fsp.symlink('../../../shared/.codex/sessions', path.join(homeA, 'sessions'))
    await fsp.symlink('../../../shared/.codex/logs', path.join(homeA, 'logs'))
    // skills 是 dangling
    await fsp.symlink('../../../shared/.codex/skills', path.join(homeA, 'skills'))
    // active.json
    await fsp.writeFile(path.join(staging, 'active.json'), JSON.stringify({ currentAccount: 'A', version: 'v1.7' }))

    const result = await codexMigrator.validateStaging(staging)
    expect(result.ok).toBe(false)
    expect(result.brokenLink).toBe(path.join(homeA, 'skills'))
    expect(result.reason).toBe('symlink-dangling')
  })

  test('validateStaging 通过的正常情况', async () => {
    const staging = path.join(env.root, '.codex-switcher.v1.7-staging-ok')
    const sharedDir = path.join(staging, 'shared', '.codex')
    const accountsDir = path.join(staging, 'accounts')
    const homeA = path.join(accountsDir, 'A', '.codex')
    await fsp.mkdir(sharedDir, { recursive: true })
    for (const d of ['skills', 'sessions', 'logs']) await fsp.mkdir(path.join(sharedDir, d), { recursive: true })
    await fsp.mkdir(homeA, { recursive: true })
    await fsp.writeFile(path.join(homeA, 'auth.json'), JSON.stringify(makeFakeAuth({ accountId: 'a' })))
    for (const d of ['skills', 'sessions', 'logs']) await fsp.symlink(`../../../shared/.codex/${d}`, path.join(homeA, d))
    await fsp.writeFile(path.join(staging, 'active.json'), JSON.stringify({ currentAccount: 'A', version: 'v1.7' }))

    const result = await codexMigrator.validateStaging(staging)
    expect(result).toEqual({ ok: true })
  })

  // TC-005a（V1.7 P1-4 修复后新增）：EXDEV 跨盘 rename 失败 → 降级为 cp 仍然迁移成功
  test('TC-005a EXDEV 跨盘 rename 触发 cp 兜底，迁移仍然成功 + audit 留痕', async () => {
    await buildLegacyV16(env, {
      liveAuth: makeFakeAuth({ accountId: 'fake-acct-live', refreshToken: 'fake-rt-live' }),
      slots: [
        { name: 'work', auth: makeFakeAuth({ accountId: 'fake-acct-live', refreshToken: 'fake-rt-work' }) },
      ],
      current: 'work',
      shared: { configToml: '[profile]' },
    })

    const fspMod = require('node:fs/promises')
    const originalRename = fspMod.rename.bind(fspMod)
    // 第 1 次 rename (legacySwitcher → backup) 放行；第 2 次 rename (staging → switcher) EXDEV → 走 cp 兜底
    let callCount = 0
    vi.spyOn(fspMod, 'rename').mockImplementation(async (src, dst) => {
      callCount += 1
      if (callCount === 2) {
        const err = new Error('cross-device link not permitted')
        err.code = 'EXDEV'
        throw err
      }
      return originalRename(src, dst)
    })

    const result = await codexMigrator.runMigration({ now: 1700000000000 })
    expect(result.ok).toBe(true)
    expect(result.accounts).toContain('work')

    // 迁移后 switcher 目录就位（通过 cp 兜底）
    expect(fs.existsSync(env.activeJsonFile)).toBe(true)
    expect(fs.existsSync(env.accountHomeDir('work'))).toBe(true)
    // staging 已清理
    const stagingDir = `${env.switcherDir}.v1.7-staging-1700000000000`
    expect(fs.existsSync(stagingDir)).toBe(false)
    // migration.log 含 audit fallback 标记
    const log = JSON.parse(await fsp.readFile(path.join(env.switcherDir, 'migration.log'), 'utf8'))
    expect(log.notes).toEqual(expect.arrayContaining([expect.stringContaining('rename-staging-fallback-cp-due-to-EXDEV')]))
  })

  // TC-005b（V1.7 P1-4 修复后新增）：非 EXDEV 致命错误 → 回滚 backup + 写 migration-failed.log
  test('TC-005b 非 EXDEV rename 失败（EPERM）→ 回滚 backup 到原 switcher + 永不删旧数据', async () => {
    await buildLegacyV16(env, {
      liveAuth: makeFakeAuth({ accountId: 'fake-acct-live', refreshToken: 'fake-rt-live' }),
      slots: [
        { name: 'work', auth: makeFakeAuth({ accountId: 'fake-acct-live', refreshToken: 'fake-rt-work' }) },
      ],
      current: 'work',
      shared: { configToml: '[profile]' },
    })

    const fspMod = require('node:fs/promises')
    const originalRename = fspMod.rename.bind(fspMod)
    let callCount = 0
    vi.spyOn(fspMod, 'rename').mockImplementation(async (src, dst) => {
      callCount += 1
      if (callCount === 2) {
        const err = new Error('operation not permitted')
        err.code = 'EPERM'
        throw err
      }
      return originalRename(src, dst)
    })

    const result = await codexMigrator.runMigration({ now: 1700000000000 })
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('EPERM')
    expect(result.stage).toBe('rename-staging-to-switcher')

    // 旧 .codex/auth.json 仍在
    expect(fs.existsSync(path.join(env.codexDir, 'auth.json'))).toBe(true)
    // staging 仍保留（永不删原则）
    const stagingDir = `${env.switcherDir}.v1.7-staging-1700000000000`
    expect(fs.existsSync(stagingDir)).toBe(true)
    // 回滚生效：原 switcher 重新出现，backup 被 rename 回去
    expect(fs.existsSync(env.switcherDir)).toBe(true)
    const switcherBackup = `${env.switcherDir}.legacy-backup-1700000000000`
    expect(fs.existsSync(switcherBackup)).toBe(false)
    // 旧账号副本仍可见（确认数据没丢）
    expect(fs.existsSync(path.join(env.switcherDir, 'accounts', 'work.json'))).toBe(true)
    // migration-failed.log 写入
    const failedLog = path.join(env.switcherDir, 'migration-failed.log')
    expect(fs.existsSync(failedLog)).toBe(true)
    const log = JSON.parse(await fsp.readFile(failedLog, 'utf8'))
    expect(log.stage).toBe('rename-staging-to-switcher')
    expect(log.error.code).toBe('EPERM')
    expect(log.audit.notes).toEqual(expect.arrayContaining(['rollback-backup-restored']))
  })

  // TC-006
  test('TC-006 副本 account_id 匹配 ~/.codex/auth.json 时用 live 覆盖（refresh_token=live-rt-new）', async () => {
    await buildLegacyV16(env, {
      liveAuth: makeFakeAuth({ accountId: 'user-12345', refreshToken: 'live-rt-new' }),
      slots: [
        { name: 'X', auth: makeFakeAuth({ accountId: 'user-12345', refreshToken: 'slot-rt-old-X' }) },
        { name: 'Y', auth: makeFakeAuth({ accountId: 'user-67890', refreshToken: 'slot-rt-old-Y' }) },
      ],
      current: 'X',
      shared: { configToml: '[profile]' },
    })

    const result = await codexMigrator.runMigration()
    expect(result.ok).toBe(true)

    // active.json
    const active = JSON.parse(await fsp.readFile(env.activeJsonFile, 'utf8'))
    expect(active.currentAccount).toBe('X')
    expect(active.version).toBe('v1.7')
    expect(active.migratedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    // slot X 的 auth.json 被 live 覆盖
    const xAuth = JSON.parse(await fsp.readFile(path.join(env.accountHomeDir('X'), 'auth.json'), 'utf8'))
    expect(xAuth.tokens.refresh_token).toBe('live-rt-new') // 关键断言：不是 slot-rt-old-X

    // slot Y 保留旧票
    const yAuth = JSON.parse(await fsp.readFile(path.join(env.accountHomeDir('Y'), 'auth.json'), 'utf8'))
    expect(yAuth.tokens.refresh_token).toBe('slot-rt-old-Y')
  })

  // TC-007
  test('TC-007 旧 ~/.codex/auth.json quarantine 到 .codex.legacy-backup-<ts>/', async () => {
    const live = makeFakeAuth({ accountId: 'fake-live', refreshToken: 'fake-rt-live' })
    live.sentinel = 'original-content'
    await buildLegacyV16(env, {
      liveAuth: live,
      slots: [{ name: 'matched', auth: makeFakeAuth({ accountId: 'fake-live', refreshToken: 'fake-rt-matched' }) }],
      shared: { configToml: '[profile]' },
    })

    const result = await codexMigrator.runMigration()
    expect(result.ok).toBe(true)
    // ~/.codex/auth.json 不存在
    expect(fs.existsSync(path.join(env.codexDir, 'auth.json'))).toBe(false)
    // .codex.legacy-backup-* 存在
    const codexBackups = (await fsp.readdir(env.root)).filter((n) => n.startsWith('.codex.legacy-backup-'))
    expect(codexBackups.length).toBe(1)
    const backupAuthPath = path.join(env.root, codexBackups[0], 'auth.json')
    const backupAuth = JSON.parse(await fsp.readFile(backupAuthPath, 'utf8'))
    expect(backupAuth.sentinel).toBe('original-content')
  })

  test('fresh install（无 ~/.codex 也无 ~/.codex-switcher）→ ok + currentAccount=null', async () => {
    const result = await codexMigrator.runMigration()
    expect(result.ok).toBe(true)
    expect(result.active).toBeNull()
    expect(fs.existsSync(env.activeJsonFile)).toBe(true)
    const active = JSON.parse(await fsp.readFile(env.activeJsonFile, 'utf8'))
    expect(active.currentAccount).toBeNull()
    expect(active.version).toBe('v1.7')
  })

  test('live auth account_id 不匹配任何 slot → 创建 imported-from-legacy 设为 active', async () => {
    await buildLegacyV16(env, {
      liveAuth: makeFakeAuth({ accountId: 'fake-acct-unknown', refreshToken: 'fake-rt-live' }),
      slots: [
        { name: 'A', auth: makeFakeAuth({ accountId: 'fake-acct-A' }) },
      ],
      shared: { configToml: '[profile]' },
    })

    const result = await codexMigrator.runMigration()
    expect(result.ok).toBe(true)
    expect(result.active).toBe('imported-from-legacy')
    expect(fs.existsSync(env.accountHomeDir('imported-from-legacy'))).toBe(true)
    expect(fs.existsSync(env.accountHomeDir('A'))).toBe(true)
  })

  test('同 account_id 重复副本 → mtime 新者 kept，旧者重命名为 -dedup-<ts>', async () => {
    // 直接造两个同 account_id 的 slot
    await fsp.mkdir(path.join(env.switcherDir, 'accounts'), { recursive: true })
    await fsp.writeFile(
      path.join(env.switcherDir, 'accounts', 'old.json'),
      JSON.stringify(makeFakeAuth({ accountId: 'dup-id', refreshToken: 'old-rt' })),
    )
    // 让 old 的 mtime 早一点
    const oldTime = new Date(Date.now() - 60000)
    await fsp.utimes(path.join(env.switcherDir, 'accounts', 'old.json'), oldTime, oldTime)
    await fsp.writeFile(
      path.join(env.switcherDir, 'accounts', 'new.json'),
      JSON.stringify(makeFakeAuth({ accountId: 'dup-id', refreshToken: 'new-rt' })),
    )
    await fsp.mkdir(env.codexDir, { recursive: true }) // 让 fresh install 流程不至于 mkdir 不存在
    await fsp.writeFile(
      path.join(env.codexDir, 'auth.json'),
      JSON.stringify(makeFakeAuth({ accountId: 'unrelated' })),
    )

    const result = await codexMigrator.runMigration({ now: 1700000000000 })
    expect(result.ok).toBe(true)
    expect(result.accounts).toEqual(expect.arrayContaining(['new', 'old-dedup-1700000000000']))

    // new 的 refresh_token 应是 new-rt（kept）
    const newAuth = JSON.parse(await fsp.readFile(path.join(env.accountHomeDir('new'), 'auth.json'), 'utf8'))
    expect(newAuth.tokens.refresh_token).toBe('new-rt')
    // old-dedup-* 的 refresh_token 是 old-rt（demoted 不丢账号）
    const demotedAuth = JSON.parse(
      await fsp.readFile(path.join(env.accountHomeDir('old-dedup-1700000000000'), 'auth.json'), 'utf8'),
    )
    expect(demotedAuth.tokens.refresh_token).toBe('old-rt')
  })

  test('live auth.json 解析失败 → 跳过激活账号识别，currentAccount=null + 副本仍迁移', async () => {
    await fsp.mkdir(env.codexDir, { recursive: true })
    await fsp.writeFile(path.join(env.codexDir, 'auth.json'), 'not-json-{', 'utf8') // 损坏
    await fsp.mkdir(path.join(env.switcherDir, 'accounts'), { recursive: true })
    await fsp.writeFile(
      path.join(env.switcherDir, 'accounts', 'A.json'),
      JSON.stringify(makeFakeAuth({ accountId: 'A' })),
    )

    const result = await codexMigrator.runMigration()
    expect(result.ok).toBe(true)
    expect(result.active).toBeNull()
    expect(fs.existsSync(env.accountHomeDir('A'))).toBe(true)
  })
})
