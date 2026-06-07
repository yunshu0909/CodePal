/**
 * 模块 D · V1.7 switchAccount + state.json 持久化 单元测试
 *
 * 覆盖：
 * - TC-027 state.json 各状态值（active / paused / invalid + permanentReason）
 * - TC-028 switchAccount 只改 active.json 不写 ~/.codex/auth.json
 * - TC-029 switchAccount 目标失效（Permanent）拦截切换 + state.json 标 invalid
 * - TC-030 switchAccount 切到当前激活返 noop
 * - 边界：目标目录不存在 / auth 损坏 / Transient 拦截 / 强切 / 非法名
 *
 * @module 自动化测试/V1.7/moduleD-scheduling/switchAccountV17.test
 */

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')

const { makeIsolatedRoot, buildV17, makeFakeAuth } = require('../setup/testEnv')
const accountService = require('../../../electron/services/codexAccountService')

const {
  switchAccountV17,
  writeAccountStateV17,
  readAccountStateV17,
  readActiveJsonV17,
} = accountService

describe('模块 D · switchAccountV17 + state.json', () => {
  let env
  let restore

  beforeEach(async () => {
    env = makeIsolatedRoot()
    restore = env.apply()
    await buildV17(env, {
      shared: { configToml: '[profile]\n' },
      accounts: [
        { name: 'A', auth: makeFakeAuth({ accountId: 'fake-acct-A' }), state: { status: 'active' } },
        { name: 'B', auth: makeFakeAuth({ accountId: 'fake-acct-B' }), state: { status: 'active' } },
      ],
      active: 'A',
    })
  })

  afterEach(async () => {
    restore?.()
    await env.cleanup()
  })

  // TC-027
  test('TC-027 state.json 各状态值持久化与回读', async () => {
    await writeAccountStateV17('A', { status: 'active', lastForceRefreshAt: 1700000000000 })
    expect(await readAccountStateV17('A')).toEqual({ status: 'active', lastForceRefreshAt: 1700000000000 })

    await writeAccountStateV17('A', { status: 'paused' })
    expect((await readAccountStateV17('A')).status).toBe('paused')

    await writeAccountStateV17('A', { status: 'invalid', permanentReason: 'Revoked' })
    const st = await readAccountStateV17('A')
    expect(st.status).toBe('invalid')
    expect(st.permanentReason).toBe('Revoked')

    // 落到磁盘
    const onDisk = JSON.parse(await fsp.readFile(path.join(env.accountHomeDir('A'), 'state.json'), 'utf8'))
    expect(onDisk).toEqual({ status: 'invalid', permanentReason: 'Revoked' })
  })

  test('writeAccountStateV17 对不存在的账户抛 ACCOUNT_DIR_MISSING', async () => {
    await expect(writeAccountStateV17('Nope', { status: 'active' })).rejects.toThrow('ACCOUNT_DIR_MISSING')
  })

  test('readAccountStateV17 state.json 缺失 → 默认 active（向后兼容）', async () => {
    // B 在 setup 中虽然写了 state，但我们删掉测试 fallback
    await fsp.unlink(path.join(env.accountHomeDir('B'), 'state.json'))
    expect(await readAccountStateV17('B')).toEqual({ status: 'active' })
  })

  // TC-028
  test('TC-028 切换 A→B：refresh 成功后只改 active.json 不写 ~/.codex/auth.json', async () => {
    // 保证 ~/.codex/ 即便存在也不被写
    await fsp.mkdir(env.codexDir, { recursive: true })
    const sentinelPath = path.join(env.codexDir, 'auth.json')
    expect(fs.existsSync(sentinelPath)).toBe(false)

    const refresherCalls = []
    const result = await switchAccountV17('B', {
      refresher: async (opts) => { refresherCalls.push(opts); return { ok: true } },
      now: 1700000000000,
    })
    // V1.7.1.3：switchAccountV17 现在可能返额外的 codexRestarted / farmDesynced 字段（与平台和 Codex.app 状态有关）
    // 用 toMatchObject 而非 toEqual，允许这些扩展字段
    expect(result).toMatchObject({ ok: true, active: 'B' })
    expect(refresherCalls).toEqual([{ accountName: 'B', force: true }])

    // active.json 已切
    const active = await readActiveJsonV17()
    expect(active.currentAccount).toBe('B')
    expect(active.switchedAt).toBe(new Date(1700000000000).toISOString())
    expect(active.version).toBe('v1.7')

    // ~/.codex/auth.json 未被创建
    expect(fs.existsSync(sentinelPath)).toBe(false)
  })

  // TC-029
  test('TC-029 目标 B 失效（Permanent.Revoked）拦截切换 + state.json 标 invalid', async () => {
    const result = await switchAccountV17('B', {
      refresher: async () => ({ ok: false, classification: 'Permanent', reason: 'Revoked' }),
    })
    expect(result).toEqual({
      ok: false,
      code: 'TARGET_NEEDS_RELOGIN',
      classification: 'Permanent',
      reason: 'Revoked',
    })
    // active.json 仍为 A
    expect((await readActiveJsonV17()).currentAccount).toBe('A')
    // B 的 state.json 已标 invalid
    expect(await readAccountStateV17('B')).toEqual({ status: 'invalid', permanentReason: 'Revoked' })
  })

  // TC-030
  test('TC-030 切到当前激活账号返 noop（refresher 不被调用）', async () => {
    let called = false
    const result = await switchAccountV17('A', {
      refresher: async () => { called = true; return { ok: true } },
    })
    expect(result).toMatchObject({ ok: true, active: 'A', noop: true })
    expect(called).toBe(false) // noop 短路
  })

  test('Transient 默认拦截切换', async () => {
    const result = await switchAccountV17('B', {
      refresher: async () => ({ ok: false, classification: 'Transient', reason: 'ServerError' }),
    })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('TARGET_TRANSIENT')
    expect((await readActiveJsonV17()).currentAccount).toBe('A')
  })

  test('Transient + forceOnTransient=true → 仍切换', async () => {
    const result = await switchAccountV17('B', {
      refresher: async () => ({ ok: false, classification: 'Transient', reason: 'ServerError' }),
      forceOnTransient: true,
    })
    expect(result.ok).toBe(true)
    expect(result.active).toBe('B')
    expect((await readActiveJsonV17()).currentAccount).toBe('B')
  })

  test('目标目录不存在 → ACCOUNT_DIR_MISSING', async () => {
    const result = await switchAccountV17('Nope')
    expect(result).toEqual({ ok: false, code: 'ACCOUNT_DIR_MISSING' })
  })

  test('目标 auth.json 解析失败 → AUTH_CORRUPT', async () => {
    await fsp.writeFile(path.join(env.accountHomeDir('B'), 'auth.json'), 'not-json-{', 'utf8')
    const result = await switchAccountV17('B')
    expect(result).toEqual({ ok: false, code: 'AUTH_CORRUPT' })
  })

  test('非法账号名拒绝', async () => {
    expect(await switchAccountV17('../etc/passwd')).toEqual({ ok: false, code: 'INVALID_NAME' })
    expect(await switchAccountV17('')).toEqual({ ok: false, code: 'INVALID_NAME' })
  })

  test('refresher 抛错时归 REFRESH_THROW (Transient)', async () => {
    const result = await switchAccountV17('B', {
      refresher: async () => { throw new Error('boom') },
    })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('REFRESH_THROW')
    expect(result.classification).toBe('Transient')
  })

  test('listSavedAccountsV17 列出账号 + active 排序在最上', async () => {
    const list = await accountService.listSavedAccountsV17()
    expect(list.map((x) => x.name)).toEqual(['A', 'B'])
    expect(list[0]).toMatchObject({ name: 'A', active: true })
    expect(list[1]).toMatchObject({ name: 'B', active: false })
  })

  test('listSavedAccountsV17 包含 state.json 字段', async () => {
    await writeAccountStateV17('B', { status: 'invalid', permanentReason: 'Expired' })
    const list = await accountService.listSavedAccountsV17()
    const b = list.find((x) => x.name === 'B')
    expect(b.state).toEqual({ status: 'invalid', permanentReason: 'Expired' })
  })
})
