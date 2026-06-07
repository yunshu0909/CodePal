/**
 * 模块 A · upgradeV16ResidueAccounts 单元测试 (V1.7.3)
 *
 * 覆盖现实事故：早期 V1.7 用户出现 accounts/ 同时存在 V1.6 单文件 (<name>.json) 与 V1.7 目录两种格式，
 * listSavedAccountsV17 只看目录 → V1.6 残留账号在 UI 里彻底"消失"。
 *
 * @module 自动化测试/V1.7/moduleA-migration/upgradeV16Residue.test
 */

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')

const { makeIsolatedRoot, makeFakeAuth } = require('../setup/testEnv')
const codexMigrator = require('../../../electron/services/codexMigrator')

async function writeResidueJson(env, name, authObj) {
  await fsp.mkdir(env.accountsDir, { recursive: true })
  await fsp.writeFile(path.join(env.accountsDir, `${name}.json`), JSON.stringify(authObj))
}

async function writeDirAccount(env, name, authObj) {
  const home = env.accountHomeDir(name)
  await fsp.mkdir(home, { recursive: true })
  await fsp.writeFile(path.join(home, 'auth.json'), JSON.stringify(authObj))
}

describe('模块 A · upgradeV16ResidueAccounts (V1.7.3)', () => {
  let env, restore

  beforeEach(() => {
    env = makeIsolatedRoot()
    restore = env.apply()
  })

  afterEach(async () => {
    restore?.()
    await env.cleanup()
  })

  test('基本升级：单个 .json → 目录格式', async () => {
    await writeResidueJson(env, 'alice', makeFakeAuth({ accountId: 'a' }))

    const r = await codexMigrator.upgradeV16ResidueAccounts({ logger: silentLogger() })

    expect(r.upgraded).toEqual(['alice'])
    expect(r.conflicts).toEqual([])
    expect(fs.existsSync(path.join(env.accountsDir, 'alice.json'))).toBe(false)
    expect(fs.existsSync(path.join(env.accountHomeDir('alice'), 'auth.json'))).toBe(true)
    const obj = JSON.parse(fs.readFileSync(path.join(env.accountHomeDir('alice'), 'auth.json'), 'utf8'))
    expect(obj.tokens.account_id).toBe('a')
  })

  test('多个 .json 同时升级', async () => {
    await writeResidueJson(env, 'alice', makeFakeAuth({ accountId: 'a' }))
    await writeResidueJson(env, 'bob', makeFakeAuth({ accountId: 'b' }))
    await writeResidueJson(env, 'charlie', makeFakeAuth({ accountId: 'c' }))

    const r = await codexMigrator.upgradeV16ResidueAccounts({ logger: silentLogger() })

    expect(r.upgraded.sort()).toEqual(['alice', 'bob', 'charlie'])
    expect(r.conflicts).toEqual([])
    for (const n of ['alice', 'bob', 'charlie']) {
      expect(fs.existsSync(path.join(env.accountsDir, `${n}.json`))).toBe(false)
      expect(fs.existsSync(path.join(env.accountHomeDir(n), 'auth.json'))).toBe(true)
    }
  })

  test('冲突：同名目录已存在 → .json 隔离为 .conflict-<ts>，目录原样保留', async () => {
    await writeDirAccount(env, 'alice', makeFakeAuth({ accountId: 'a-new' }))
    await writeResidueJson(env, 'alice', makeFakeAuth({ accountId: 'a-old' }))

    const r = await codexMigrator.upgradeV16ResidueAccounts({ logger: silentLogger(), now: 1700000000000 })

    expect(r.upgraded).toEqual([])
    expect(r.conflicts).toEqual([{ name: 'alice', reason: 'directory-already-exists' }])
    expect(fs.existsSync(path.join(env.accountsDir, 'alice.json'))).toBe(false)
    expect(fs.existsSync(path.join(env.accountsDir, 'alice.json.conflict-1700000000000'))).toBe(true)
    // 目录里的 auth 是 a-new，没被 .json 内容覆盖
    const dirAuth = JSON.parse(fs.readFileSync(path.join(env.accountHomeDir('alice'), 'auth.json'), 'utf8'))
    expect(dirAuth.tokens.account_id).toBe('a-new')
  })

  test('部分冲突 + 部分升级共存', async () => {
    await writeDirAccount(env, 'alice', makeFakeAuth({ accountId: 'a' }))
    await writeResidueJson(env, 'alice', makeFakeAuth({ accountId: 'a-residue' }))
    await writeResidueJson(env, 'bob', makeFakeAuth({ accountId: 'b' }))

    const r = await codexMigrator.upgradeV16ResidueAccounts({ logger: silentLogger(), now: 1700000000000 })

    expect(r.upgraded).toEqual(['bob'])
    expect(r.conflicts).toEqual([{ name: 'alice', reason: 'directory-already-exists' }])
  })

  test('幂等：再跑一次没残留时直接 no-op', async () => {
    await writeResidueJson(env, 'alice', makeFakeAuth({ accountId: 'a' }))
    await codexMigrator.upgradeV16ResidueAccounts({ logger: silentLogger() })

    const r2 = await codexMigrator.upgradeV16ResidueAccounts({ logger: silentLogger() })
    expect(r2.upgraded).toEqual([])
    expect(r2.conflicts).toEqual([])
  })

  test('空 accounts/ 不报错', async () => {
    await fsp.mkdir(env.accountsDir, { recursive: true })
    const r = await codexMigrator.upgradeV16ResidueAccounts({ logger: silentLogger() })
    expect(r).toEqual({ upgraded: [], conflicts: [] })
  })

  test('accounts/ 不存在时不报错', async () => {
    const r = await codexMigrator.upgradeV16ResidueAccounts({ logger: silentLogger() })
    expect(r).toEqual({ upgraded: [], conflicts: [] })
  })

  test('隐藏文件 / 非 .json 文件被跳过', async () => {
    await fsp.mkdir(env.accountsDir, { recursive: true })
    await fsp.writeFile(path.join(env.accountsDir, '.DS_Store'), 'noise')
    await fsp.writeFile(path.join(env.accountsDir, '.hidden.json'), '{}')
    await fsp.writeFile(path.join(env.accountsDir, 'readme.txt'), 'not an account')

    const r = await codexMigrator.upgradeV16ResidueAccounts({ logger: silentLogger() })
    expect(r.upgraded).toEqual([])
    expect(r.conflicts).toEqual([])
    expect(fs.existsSync(path.join(env.accountsDir, '.DS_Store'))).toBe(true)
    expect(fs.existsSync(path.join(env.accountsDir, '.hidden.json'))).toBe(true)
    expect(fs.existsSync(path.join(env.accountsDir, 'readme.txt'))).toBe(true)
  })

  test('已是目录格式的账号不动它', async () => {
    await writeDirAccount(env, 'alice', makeFakeAuth({ accountId: 'a' }))
    const r = await codexMigrator.upgradeV16ResidueAccounts({ logger: silentLogger() })
    expect(r.upgraded).toEqual([])
    expect(r.conflicts).toEqual([])
    expect(fs.existsSync(path.join(env.accountHomeDir('alice'), 'auth.json'))).toBe(true)
  })
})

function silentLogger() {
  return { info: () => {}, warn: () => {}, error: () => {} }
}
