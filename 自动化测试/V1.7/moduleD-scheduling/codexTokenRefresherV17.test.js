/**
 * 模块 D · V1.7 Token 刷新器 单元测试
 *
 * 覆盖：
 * - TC-031 sweep 跳过 active 账号
 * - TC-032 inactive 超 7d 触发 force refresh
 * - TC-035 Transient 1s/2s/4s 退避 + 顺序断言
 * - TC-036 Transient 3 次失败后 state.json paused
 * - TC-037 Permanent 立刻标 invalid 零重试
 * - TC-038 pendingTokenCache 写盘失败保留新 refresh_token + 下次 refresh 优先用
 * - 边界：mtime 防撞车 / inflight 去重 / 24h force 限频 / recover from crash
 *
 * @module 自动化测试/V1.7/moduleD-scheduling/codexTokenRefresherV17.test
 */

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')

const { makeIsolatedRoot, buildV17, makeFakeAuth } = require('../setup/testEnv')
const accountService = require('../../../electron/services/codexAccountService')
const refresher = require('../../../electron/services/codexTokenRefresherV17')

const I = refresher.__INTERNAL__

// 构造一个 fake fetch（返回任意 status + body）
function makeFakeFetch(scriptedResponses) {
  let i = 0
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url, body: init.body, headers: init.headers })
    const next = scriptedResponses[Math.min(i, scriptedResponses.length - 1)]
    i += 1
    if (next.throw) throw new Error(next.throw)
    return {
      status: next.status,
      ok: next.status >= 200 && next.status < 300,
      text: async () => next.body ?? '',
    }
  }
  fn.calls = calls
  return fn
}

describe('模块 D · codexTokenRefresherV17', () => {
  let env
  let restore

  beforeEach(() => {
    env = makeIsolatedRoot()
    restore = env.apply()
    I.__clearCaches()
  })

  afterEach(async () => {
    I.__resetFetch()
    I.__resetNow()
    I.__clearCaches()
    restore?.()
    await env.cleanup()
  })

  // TC-037
  test('TC-037 Permanent.Revoked 立刻标 invalid 零重试 + state.json 写入', async () => {
    await buildV17(env, {
      accounts: [{ name: 'A', auth: makeFakeAuth({ accountId: 'a', refreshToken: 'rt-A' }) }],
      active: 'B',
    })

    const fakeFetch = makeFakeFetch([
      { status: 401, body: '{"error":{"code":"refresh_token_invalidated"}}' },
    ])
    I.__setFetch(fakeFetch)

    const result = await refresher.ensureFreshCodexTokenV17({ accountName: 'A', force: true })
    expect(result.ok).toBe(false)
    expect(result.classification).toBe('Permanent')
    expect(result.reason).toBe('Revoked')
    expect(result.attempts).toBe(1) // 零重试

    expect(fakeFetch.calls.length).toBe(1) // 真的只调一次

    const state = await accountService.readAccountStateV17('A')
    expect(state).toEqual({ status: 'invalid', permanentReason: 'Revoked' })
  })

  test('TC-037+ Permanent.Expired 立刻 invalid', async () => {
    await buildV17(env, {
      accounts: [{ name: 'A', auth: makeFakeAuth({ accountId: 'a', refreshToken: 'rt-A' }) }],
      active: 'B',
    })
    I.__setFetch(makeFakeFetch([{ status: 401, body: '{"error":{"code":"refresh_token_expired"}}' }]))
    const r = await refresher.ensureFreshCodexTokenV17({ accountName: 'A', force: true })
    expect(r.classification).toBe('Permanent')
    expect(r.reason).toBe('Expired')
    expect((await accountService.readAccountStateV17('A')).permanentReason).toBe('Expired')
  })

  // TC-035 + TC-036
  test('TC-035/036 Transient 1s/2s/4s 退避 + 3 次失败后 state.json paused', async () => {
    await buildV17(env, {
      accounts: [{ name: 'T', auth: makeFakeAuth({ accountId: 't', refreshToken: 'rt-T' }) }],
      active: 'B',
    })
    // 4 次都 503（首次 + 3 次重试 = 4 次）
    I.__setFetch(makeFakeFetch([
      { status: 503, body: 'gateway error' },
      { status: 503, body: 'gateway error' },
      { status: 503, body: 'gateway error' },
      { status: 503, body: 'gateway error' },
    ]))

    const backoffs = []
    const t0 = Date.now()
    const r = await refresher.ensureFreshCodexTokenV17({
      accountName: 'T',
      force: true,
      onAttempt: (n, delay) => backoffs.push({ n, delay, elapsed: Date.now() - t0 }),
    })
    expect(r.ok).toBe(false)
    expect(r.classification).toBe('Transient')
    expect(r.reason).toBe('ServerError')
    expect(r.attempts).toBe(4) // 1 次首发 + 3 次重试

    // 退避顺序：第 1 次失败 → 等 1s；第 2 次失败 → 等 2s；第 3 次失败 → 等 4s
    expect(backoffs.map((b) => b.delay)).toEqual([1000, 2000, 4000])

    // state.json 写入 paused
    expect(await accountService.readAccountStateV17('T')).toEqual({ status: 'paused' })
  }, 15000) // 实际跑 1+2+4 = 7s 退避

  test('Transient 第 2 次重试就成功 → 不再退避，写盘 + state.json active', async () => {
    await buildV17(env, {
      accounts: [{ name: 'OK2', auth: makeFakeAuth({ accountId: 'ok2', refreshToken: 'rt-OK' }) }],
      active: 'B',
    })
    I.__setFetch(makeFakeFetch([
      { status: 503, body: '' },
      {
        status: 200,
        body: JSON.stringify({
          access_token: makeFakeJwtForToken(0),
          id_token: makeFakeJwtForToken(0),
          refresh_token: 'rt-OK-new',
        }),
      },
    ]))

    const r = await refresher.ensureFreshCodexTokenV17({ accountName: 'OK2', force: true })
    expect(r.ok).toBe(true)
    expect(r.refreshed).toBe(true)
    const auth = JSON.parse(await fsp.readFile(path.join(env.accountHomeDir('OK2'), 'auth.json'), 'utf8'))
    expect(auth.tokens.refresh_token).toBe('rt-OK-new')
    expect((await accountService.readAccountStateV17('OK2')).status).toBe('active')
  }, 8000)

  // TC-038（V1.7 P0-3 修复：从假绿改为真断言——把 fetch mock 的 calls 暴露并断言 body）
  test('TC-038 atomic write 失败 → pendingTokenCache 保留新 refresh_token + 下次刷新发出的 body 真的用 cache 的 rt-D-NEW', async () => {
    await buildV17(env, {
      accounts: [{ name: 'D', auth: makeFakeAuth({ accountId: 'd', refreshToken: 'rt-D-old' }) }],
      active: 'B',
    })
    const scriptedFetch = makeFakeFetch([
      {
        status: 200,
        body: JSON.stringify({
          access_token: makeFakeJwtForToken(0),
          id_token: makeFakeJwtForToken(0),
          refresh_token: 'rt-D-NEW',
        }),
      },
      // 第二次刷新：cache 里有 'rt-D-NEW'，必须用它发请求
      {
        status: 200,
        body: JSON.stringify({
          access_token: makeFakeJwtForToken(0),
          id_token: makeFakeJwtForToken(0),
          refresh_token: 'rt-D-NEXT',
        }),
      },
    ])
    I.__setFetch(scriptedFetch)

    // 让 atomic rename 失败一次（写 tmp 成功、rename 失败）
    const fspMod = require('node:fs/promises')
    const originalRename = fspMod.rename.bind(fspMod)
    let renameCallCount = 0
    vi.spyOn(fspMod, 'rename').mockImplementation(async (src, dst) => {
      renameCallCount += 1
      // 只让"auth.json"的 rename 第 1 次失败（其他 rename 比如 state.json 正常）
      if (renameCallCount === 1 && dst.endsWith('auth.json')) {
        const err = new Error('disk full')
        err.code = 'ENOSPC'
        throw err
      }
      return originalRename(src, dst)
    })

    const r1 = await refresher.ensureFreshCodexTokenV17({ accountName: 'D', force: true })
    expect(r1.ok).toBe(false)
    expect(r1.classification).toBe('Transient')
    expect(r1.reason).toBe('PersistFailed')

    // 第 1 次 fetch 用了 disk 上的 'rt-D-old'
    expect(scriptedFetch.calls.length).toBe(1)
    expect(JSON.parse(scriptedFetch.calls[0].body).refresh_token).toBe('rt-D-old')

    // pendingTokenCache 含新 refresh_token
    const cached = I.pendingTokenCache.get('D')
    expect(cached.refresh_token).toBe('rt-D-NEW')

    // disk 上仍是旧 token
    const onDisk = JSON.parse(await fsp.readFile(path.join(env.accountHomeDir('D'), 'auth.json'), 'utf8'))
    expect(onDisk.tokens.refresh_token).toBe('rt-D-old')

    // 第二次 refresh：cache 里有 'rt-D-NEW'，应该用它而不是 disk 的 'rt-D-old'
    vi.restoreAllMocks()
    const r2 = await refresher.ensureFreshCodexTokenV17({ accountName: 'D', force: true })
    expect(r2.ok).toBe(true)

    // V1.7 P0-3 关键真断言：第 2 次 fetch 的 body.refresh_token 必须是 cache 里的 'rt-D-NEW'
    expect(scriptedFetch.calls.length).toBe(2)
    expect(JSON.parse(scriptedFetch.calls[1].body).refresh_token).toBe('rt-D-NEW')

    // 经过第 2 次成功 → cache 应被清
    expect(I.pendingTokenCache.has('D')).toBe(false)

    // 磁盘上 refresh_token 更新为 rt-D-NEXT
    const onDisk2 = JSON.parse(await fsp.readFile(path.join(env.accountHomeDir('D'), 'auth.json'), 'utf8'))
    expect(onDisk2.tokens.refresh_token).toBe('rt-D-NEXT')
  })

  // TC-031
  test('TC-031 sweep 跳过 active 账号', async () => {
    await buildV17(env, {
      accounts: [
        {
          name: 'A',
          auth: makeFakeAuth({ accountId: 'a', refreshToken: 'rt-A', iatSecondsAgo: 14 * 86400 }),
        },
        {
          name: 'B',
          auth: makeFakeAuth({ accountId: 'b', refreshToken: 'rt-B', iatSecondsAgo: 14 * 86400 }),
        },
      ],
      active: 'A', // A 是 active
    })
    // 让 A/B 的 mtime 都 > 60s（防 mtime 跳过）
    const old = Date.now() - 5 * 60_000
    for (const name of ['A', 'B']) {
      await fsp.utimes(path.join(env.accountHomeDir(name), 'auth.json'), old / 1000, old / 1000)
    }

    I.__setFetch(makeFakeFetch([
      {
        status: 200,
        body: JSON.stringify({
          access_token: makeFakeJwtForToken(0),
          id_token: makeFakeJwtForToken(0),
          refresh_token: 'rt-B-new',
        }),
      },
    ]))

    const report = await refresher.sweepAllSlotsV17()
    expect(report.active).toBe('A')
    const actions = report.processed.reduce((m, p) => ({ ...m, [p.accountName]: p.action }), {})
    expect(actions.A).toBe('skipped-active')
    expect(actions.B).toBe('refreshed')
  }, 10000)

  // TC-032
  test('TC-032 inactive 超 7d 阈值才触发，未超阈值不触发', async () => {
    await buildV17(env, {
      accounts: [
        {
          name: 'OLD',
          auth: makeFakeAuth({ accountId: 'old', refreshToken: 'rt-OLD', iatSecondsAgo: 8 * 86400 }),
        },
        {
          name: 'YOUNG',
          auth: makeFakeAuth({ accountId: 'young', refreshToken: 'rt-Y', iatSecondsAgo: 2 * 86400 }),
        },
      ],
      active: null,
    })
    // 让所有 mtime 都 < 60s 内
    const old = Date.now() - 5 * 60_000
    for (const name of ['OLD', 'YOUNG']) {
      await fsp.utimes(path.join(env.accountHomeDir(name), 'auth.json'), old / 1000, old / 1000)
    }

    I.__setFetch(makeFakeFetch([
      {
        status: 200,
        body: JSON.stringify({
          access_token: makeFakeJwtForToken(0),
          id_token: makeFakeJwtForToken(0),
          refresh_token: 'rt-OLD-new',
        }),
      },
    ]))

    const report = await refresher.sweepAllSlotsV17()
    const actions = report.processed.reduce((m, p) => ({ ...m, [p.accountName]: p.action }), {})
    expect(actions.OLD).toBe('refreshed')
    expect(actions.YOUNG).toBe('skipped-not-due')
  }, 10000)

  test('sweep mtime 防撞车：< 60s 内被修改的账号跳过', async () => {
    await buildV17(env, {
      accounts: [
        {
          name: 'JUST',
          auth: makeFakeAuth({ accountId: 'j', refreshToken: 'rt-J', iatSecondsAgo: 10 * 86400 }),
        },
      ],
      active: null,
    })
    // mtime 默认就是刚刚写的（< 60s）
    const report = await refresher.sweepAllSlotsV17()
    const action = report.processed.find((p) => p.accountName === 'JUST').action
    expect(action).toBe('skipped-mtime')
  })

  test('inflight 去重：并发两次同 force 调用只发一次 HTTP', async () => {
    await buildV17(env, {
      accounts: [{ name: 'INF', auth: makeFakeAuth({ accountId: 'i', refreshToken: 'rt-INF' }) }],
      active: 'B',
    })
    let fetchCount = 0
    I.__setFetch(async () => {
      fetchCount += 1
      // 故意慢一点
      await new Promise((r) => setTimeout(r, 100))
      return {
        status: 200,
        ok: true,
        text: async () => JSON.stringify({
          access_token: makeFakeJwtForToken(0),
          id_token: makeFakeJwtForToken(0),
          refresh_token: 'rt-INF-new',
        }),
      }
    })

    const [r1, r2] = await Promise.all([
      refresher.ensureFreshCodexTokenV17({ accountName: 'INF', force: true }),
      refresher.ensureFreshCodexTokenV17({ accountName: 'INF', force: true }),
    ])
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
    expect(fetchCount).toBe(1) // 真的只一次 HTTP
  })

  test('24h force 限频：第 4 次强制刷会被拦截', async () => {
    await buildV17(env, {
      accounts: [{ name: 'F', auth: makeFakeAuth({ accountId: 'f', refreshToken: 'rt-F' }) }],
      active: 'B',
    })
    I.__setFetch(async () => ({
      status: 200,
      ok: true,
      text: async () => JSON.stringify({
        access_token: makeFakeJwtForToken(0),
        id_token: makeFakeJwtForToken(0),
        refresh_token: 'rt-F',
      }),
    }))
    // 3 次正常通过
    for (let i = 0; i < 3; i += 1) {
      const r = await refresher.ensureFreshCodexTokenV17({ accountName: 'F', force: true })
      expect(r.ok).toBe(true)
    }
    // 第 4 次拦截
    const r4 = await refresher.ensureFreshCodexTokenV17({ accountName: 'F', force: true })
    expect(r4.ok).toBe(false)
    expect(r4.classification).toBe('Transient')
    expect(r4.error).toBe('FORCE_24H_LIMIT')
  })

  test('recoverFromCrashV17：窗口内 .recovery 重放到 auth.json', async () => {
    await buildV17(env, {
      accounts: [{ name: 'R', auth: makeFakeAuth({ accountId: 'r', refreshToken: 'rt-R-OLD' }) }],
      active: null,
    })
    // 写一个 .recovery 文件（10 分钟内）
    const now = Date.now() - 5 * 60_000
    const recoveryPath = path.join(env.accountHomeDir('R'), `auth.json.recovery-${now}`)
    await fsp.writeFile(recoveryPath, JSON.stringify({
      accountName: 'R',
      response: {
        access_token: makeFakeJwtForToken(0),
        id_token: makeFakeJwtForToken(0),
        refresh_token: 'rt-R-RECOVERED',
      },
      timestamp: new Date(now).toISOString(),
    }))

    const report = await refresher.recoverFromCrashV17()
    const r = report.find((x) => x.accountName === 'R')
    expect(r.action).toBe('restored')
    expect(fs.existsSync(recoveryPath)).toBe(false)

    const auth = JSON.parse(await fsp.readFile(path.join(env.accountHomeDir('R'), 'auth.json'), 'utf8'))
    expect(auth.tokens.refresh_token).toBe('rt-R-RECOVERED')
  })

  test('recoverFromCrashV17：超过 10 分钟窗口的 .recovery 被清不重放', async () => {
    await buildV17(env, {
      accounts: [{ name: 'S', auth: makeFakeAuth({ accountId: 's', refreshToken: 'rt-S-OLD' }) }],
      active: null,
    })
    const stale = Date.now() - 30 * 60_000
    const stalePath = path.join(env.accountHomeDir('S'), `auth.json.recovery-${stale}`)
    await fsp.writeFile(stalePath, JSON.stringify({
      accountName: 'S',
      response: { refresh_token: 'rt-S-STALE' },
      timestamp: new Date(stale).toISOString(),
    }))

    const report = await refresher.recoverFromCrashV17()
    expect(report[0].action).toBe('expired')
    expect(fs.existsSync(stalePath)).toBe(false)

    // auth.json 没被改
    const auth = JSON.parse(await fsp.readFile(path.join(env.accountHomeDir('S'), 'auth.json'), 'utf8'))
    expect(auth.tokens.refresh_token).toBe('rt-S-OLD')
  })

  test('TC-049（前置）非 JSON body 401 → Permanent.Other', async () => {
    await buildV17(env, {
      accounts: [{ name: 'X', auth: makeFakeAuth({ accountId: 'x', refreshToken: 'rt-X' }) }],
      active: 'B',
    })
    I.__setFetch(makeFakeFetch([{ status: 401, body: '<html>Forbidden</html>' }]))
    const r = await refresher.ensureFreshCodexTokenV17({ accountName: 'X', force: true })
    expect(r.classification).toBe('Permanent')
    expect(r.reason).toBe('Other')
  })

  test('nextKeepaliveAt 计算正确：以 max(iat, lastForceRefreshAt) + 7d 为基准', async () => {
    const now = 1700000000000
    const iatSec = Math.floor((now - 3 * 86400 * 1000) / 1000) // 3d 前
    const auth = { tokens: { access_token: makeFakeJwtForToken(0, iatSec) } }
    const state = { status: 'active', lastForceRefreshAt: now - 1 * 86400 * 1000 }
    const next = refresher.nextKeepaliveAt('X', state, auth, now)
    // baseline = max(iatSec*1000, lastForceRefreshAt) = iatSec*1000（3d 前比 1d 前更老）
    // wait — iatSec*1000 = now - 3d, lastForceRefreshAt = now - 1d
    // max(now-3d, now-1d) = now-1d
    // next = now-1d + 7d = now + 6d
    expect(next).toBe(now - 1 * 86400 * 1000 + 7 * 86400 * 1000)
  })
})

// ===== helpers =====

function makeFakeJwtForToken(iatSecondsAgo, iatOverride) {
  const now = Math.floor(Date.now() / 1000)
  const iat = iatOverride ?? (now - iatSecondsAgo)
  const header = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({
    iat,
    exp: iat + 1800,
    sub: 'fake',
  })).toString('base64url')
  return `${header}.${payload}.sig`
}
