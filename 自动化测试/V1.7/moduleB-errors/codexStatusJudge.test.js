/**
 * 模块 B · 三档状态判定 单元测试
 *
 * 覆盖：
 * - TC-021 三档（绿/黄/红）各一例 + paused 也归黄
 * - 边界：auth.json 缺失、损坏、last_refresh fallback
 *
 * @module 自动化测试/V1.7/moduleB-errors/codexStatusJudge.test
 */

const { makeIsolatedRoot, buildV17, makeFakeAuth } = require('../setup/testEnv')
const { judge } = require('../../../electron/services/codexStatusJudge')

describe('模块 B · codexStatusJudge.judge', () => {
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

  // TC-021
  test('TC-021 绿：state=active, iat=now-3h → green/近期验证', async () => {
    await buildV17(env, {
      accounts: [
        {
          name: 'A',
          auth: makeFakeAuth({ accountId: 'fake-acct-A', iatSecondsAgo: 3 * 3600 }),
          state: { status: 'active' },
        },
      ],
    })
    const result = await judge('A')
    expect(result.color).toBe('green')
    expect(result.label).toBe('近期验证')
    expect(result.source).toBe('iat')
  })

  test('TC-021 黄：state=active, iat=now-10d → yellow/未近期验证（V1.7.1 阈值 7d）', async () => {
    await buildV17(env, {
      accounts: [
        {
          name: 'B',
          auth: makeFakeAuth({ accountId: 'fake-acct-B', iatSecondsAgo: 10 * 24 * 3600 }),
          state: { status: 'active' },
        },
      ],
    })
    const result = await judge('B')
    expect(result.color).toBe('yellow')
    expect(result.label).toBe('未近期验证')
  })

  // V1.7.1 新增：sweep 完成后即便 iat 老旧，state.lastForceRefreshAt 在 7d 内仍是绿
  test('V1.7.1：iat 老但 sweep lastForceRefreshAt 在 7d 内 → 绿（sweep 证据胜出）', async () => {
    const now = Date.now()
    await buildV17(env, {
      accounts: [
        {
          name: 'SWEPT',
          // iat 10 天前（旧 access_token，按 V1.7.0 老逻辑应该黄）
          auth: makeFakeAuth({ accountId: 'fake-acct-S', iatSecondsAgo: 10 * 24 * 3600 }),
          // 但 sweep 2 天前刚成功刷过
          state: { status: 'active', lastForceRefreshAt: now - 2 * 24 * 3600 * 1000 },
        },
      ],
    })
    const result = await judge('SWEPT')
    expect(result.color).toBe('green')
    expect(result.label).toBe('近期验证')
    expect(result.source).toBe('sweep') // 走 sweep 证据，不是 iat
  })

  // V1.7.1 新增：iat 在 6h 内（V1.7.0 老逻辑判 绿）+ lastForceRefreshAt 8d 前 → 仍是绿（iat 胜出）
  test('V1.7.1：iat 在 7d 内 + sweep 在 7d 外 → 绿（iat 证据胜出）', async () => {
    const now = Date.now()
    await buildV17(env, {
      accounts: [
        {
          name: 'NATURAL',
          // codex CLI 自然续期 1 小时前
          auth: makeFakeAuth({ accountId: 'fake-acct-N', iatSecondsAgo: 1 * 3600 }),
          // sweep 8 天前
          state: { status: 'active', lastForceRefreshAt: now - 8 * 24 * 3600 * 1000 },
        },
      ],
    })
    const result = await judge('NATURAL')
    expect(result.color).toBe('green')
    expect(result.source).toBe('iat')
  })

  // V1.7.1 新增：iat 8d + sweep 10d → 黄（两个都过期）
  test('V1.7.1：所有证据都超过 7d → 黄', async () => {
    const now = Date.now()
    await buildV17(env, {
      accounts: [
        {
          name: 'STALE',
          auth: makeFakeAuth({ accountId: 'fake-acct-T', iatSecondsAgo: 8 * 24 * 3600 }),
          state: { status: 'active', lastForceRefreshAt: now - 10 * 24 * 3600 * 1000 },
        },
      ],
    })
    const result = await judge('STALE')
    expect(result.color).toBe('yellow')
  })

  test('TC-021 红：state=invalid, permanentReason=Revoked → red/已撤销', async () => {
    await buildV17(env, {
      accounts: [
        {
          name: 'C',
          auth: makeFakeAuth({ accountId: 'fake-acct-C', iatSecondsAgo: 1 * 3600 }),
          state: { status: 'invalid', permanentReason: 'Revoked' },
        },
      ],
    })
    const result = await judge('C')
    expect(result.color).toBe('red')
    expect(result.label).toBe('已撤销')
    expect(result.reason).toBe('Revoked')
  })

  test('paused → 黄/网络异常', async () => {
    await buildV17(env, {
      accounts: [
        {
          name: 'P',
          auth: makeFakeAuth({ accountId: 'fake-acct-P', iatSecondsAgo: 1 * 3600 }),
          state: { status: 'paused' },
        },
      ],
    })
    const result = await judge('P')
    expect(result.color).toBe('yellow')
    expect(result.label).toBe('网络异常')
  })

  test('state.json 缺失 → 按 active 处理（绿，向后兼容）', async () => {
    await buildV17(env, {
      accounts: [
        {
          name: 'NoState',
          auth: makeFakeAuth({ accountId: 'fake-acct-NS', iatSecondsAgo: 1 * 3600 }),
          // 不写 state
        },
      ],
    })
    const result = await judge('NoState')
    expect(result.color).toBe('green')
  })

  test('auth.json 不存在 → 红/凭证缺失', async () => {
    // 不调 buildV17，直接 mkdir 一个空账户目录
    const fs = require('node:fs/promises')
    const path = require('node:path')
    const accountService = require('../../../electron/services/codexAccountService')
    const home = accountService.__INTERNAL__.getAccountHomeDir('Empty')
    await fs.mkdir(home, { recursive: true })

    const result = await judge('Empty')
    expect(result.color).toBe('red')
    expect(result.reason).toBe('AuthMissing')
  })

  test('auth.json 解析失败 → 红/凭证损坏', async () => {
    const fs = require('node:fs/promises')
    const path = require('node:path')
    const accountService = require('../../../electron/services/codexAccountService')
    const home = accountService.__INTERNAL__.getAccountHomeDir('Corrupt')
    await fs.mkdir(home, { recursive: true })
    await fs.writeFile(path.join(home, 'auth.json'), 'not-json-{', 'utf8')

    const result = await judge('Corrupt')
    expect(result.color).toBe('red')
    expect(result.reason).toBe('AuthCorrupt')
  })

  test('access_token JWT 损坏但 last_refresh 在 6h 内 → 绿（fallback）', async () => {
    const fs = require('node:fs/promises')
    const path = require('node:path')
    const accountService = require('../../../electron/services/codexAccountService')
    const home = accountService.__INTERNAL__.getAccountHomeDir('JwtBroken')
    await fs.mkdir(home, { recursive: true })
    const auth = {
      tokens: {
        access_token: 'not-a-jwt', // 让 decodeJwtPayload 抛
        refresh_token: 'fake-rt-jb',
        account_id: 'fake-acct-jb',
      },
      last_refresh: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
    }
    await fs.writeFile(path.join(home, 'auth.json'), JSON.stringify(auth), 'utf8')

    const result = await judge('JwtBroken')
    expect(result.color).toBe('green')
    expect(result.source).toBe('last_refresh')
  })
})
