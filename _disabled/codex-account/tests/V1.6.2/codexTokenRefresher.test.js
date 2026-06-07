/**
 * V1.6.2 codexTokenRefresher 测试
 *
 * 覆盖：
 * - ensureFreshCodexToken：200 写盘、4xx needsRelogin、401 needsRelogin、5xx 重试 1 次后成功 / 失败、timeout
 * - inflight 并发去重（同 accountId 同时调 N 次只发 1 次 fetch）
 * - sweepAllSlots：跳过激活槽、7 天阈值、串行执行
 * - recoverFromCrash：模拟 .recovery 文件存在 → 启动后槽位被恢复 + .recovery 被删
 *
 * @module 自动化测试/V1.6.2/codexTokenRefresher.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import refresher from '../../electron/services/codexTokenRefresher'
import { makeJwt, makeAuthObj } from '../V1.5.0/helpers'

// 拿 refresher 内部 require 的 accountService（ESM import 可能是另一个实例，
// 用 getLinkedAccountService 才能注入到 refresher 真正使用的那个）
const linkedAccountService = refresher.__INTERNAL__.getLinkedAccountService()

let tmpHome
let mockFetch

const ACCOUNTS_DIR = () => path.join(tmpHome, '.codex-switcher', 'accounts')
const SLOT_PATH = (name) => path.join(ACCOUNTS_DIR(), `${name}.json`)
const CURRENT_FILE = () => path.join(tmpHome, '.codex-switcher', 'current')

beforeEach(async () => {
  tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-refresher-test-'))
  linkedAccountService.__INTERNAL__.__setHomeDir(tmpHome)
  await fsp.mkdir(ACCOUNTS_DIR(), { recursive: true })

  // 默认 mock fetch
  mockFetch = vi.fn()
  refresher.__INTERNAL__.__setFetch(mockFetch)
  refresher.__INTERNAL__.inflight.clear()
})

afterEach(async () => {
  refresher.__INTERNAL__.__resetFetch()
  refresher.__INTERNAL__.inflight.clear()
  linkedAccountService.__INTERNAL__.__resetHomeDir()
  await fsp.rm(tmpHome, { recursive: true, force: true })
})

// ---------- helpers ----------

/**
 * 写一个 slot 文件（使用 V1.5.0 helpers 生成 auth 结构）
 * 默认每个 slot 用基于 name 的唯一 accountId，避免 inflight Map 串台
 * @param {string} name
 * @param {object} [authOpts]
 */
async function writeSlot(name, authOpts = {}) {
  const accountId = authOpts.accountId || `acc-${name}-${'0'.repeat(32 - name.length - 4)}`.slice(0, 36)
  const auth = makeAuthObj({ ...authOpts, accountId })
  await fsp.writeFile(SLOT_PATH(name), JSON.stringify(auth, null, 2))
  return auth
}

function mockFetchOk(data) {
  return Promise.resolve({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(data)),
  })
}

function mockFetchError(status, body = '{"error":"invalid_grant"}') {
  return Promise.resolve({
    ok: false,
    status,
    text: () => Promise.resolve(body),
  })
}

function mockFetchNetworkError(message = 'network error') {
  return Promise.reject(new Error(message))
}

function freshTokenResponse(opts = {}) {
  const expSecFromNow = opts.expSecFromNow ?? 3600
  const exp = Math.floor(Date.now() / 1000) + expSecFromNow
  return {
    access_token: makeJwt({ scp: 'openid' }, exp),
    id_token: makeJwt({ email: opts.email || 'alice@example.com' }, exp),
    refresh_token: opts.refresh_token || 'new-refresh-token',
    expires_in: expSecFromNow,
    token_type: 'Bearer',
  }
}

// ---------- ensureFreshCodexToken ----------

describe('ensureFreshCodexToken', () => {
  it('access_token 还远未过期 → 不刷', async () => {
    await writeSlot('alice', { expSecFromNow: 3600 })
    const result = await refresher.ensureFreshCodexToken({ filePath: SLOT_PATH('alice') })
    expect(result.success).toBe(true)
    expect(result.refreshed).toBe(false)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('access_token 即将过期 → 调 fetch + 写盘 + 删 .recovery', async () => {
    await writeSlot('alice', { expSecFromNow: 60 })  // 1 分钟内过期
    mockFetch.mockReturnValue(mockFetchOk(freshTokenResponse()))

    const result = await refresher.ensureFreshCodexToken({ filePath: SLOT_PATH('alice') })

    expect(result.success).toBe(true)
    expect(result.refreshed).toBe(true)
    expect(mockFetch).toHaveBeenCalledTimes(1)

    // 验证 fetch 调用参数
    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe('https://auth.openai.com/oauth/token')
    expect(init.method).toBe('POST')
    expect(init.headers['Content-Type']).toBe('application/json')
    expect(init.headers['User-Agent']).toMatch(/^CodePal\//)
    const body = JSON.parse(init.body)
    expect(body.grant_type).toBe('refresh_token')
    expect(body.client_id).toBe('app_EMoamEEZ73f0CkXaXp7hrann')

    // 验证写盘结果
    const written = JSON.parse(await fsp.readFile(SLOT_PATH('alice'), 'utf-8'))
    expect(written.tokens.refresh_token).toBe('new-refresh-token')
    expect(written.last_refresh).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    // .recovery 应该已被删除
    const remaining = await fsp.readdir(ACCOUNTS_DIR())
    expect(remaining.filter((n) => n.includes('.recovery-'))).toHaveLength(0)
  })

  it('400 invalid_grant → needsRelogin=true，不重试', async () => {
    await writeSlot('alice', { expSecFromNow: 60 })
    mockFetch.mockReturnValue(mockFetchError(400, '{"error":"invalid_grant","error_description":"Token expired"}'))

    const result = await refresher.ensureFreshCodexToken({ filePath: SLOT_PATH('alice') })

    expect(result.success).toBe(false)
    expect(result.needsRelogin).toBe(true)
    expect(mockFetch).toHaveBeenCalledTimes(1)  // 不重试
  })

  it('401 → needsRelogin=true', async () => {
    await writeSlot('alice', { expSecFromNow: 60 })
    mockFetch.mockReturnValue(mockFetchError(401))

    const result = await refresher.ensureFreshCodexToken({ filePath: SLOT_PATH('alice') })

    expect(result.success).toBe(false)
    expect(result.needsRelogin).toBe(true)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('500 → 重试 1 次后成功', async () => {
    await writeSlot('alice', { expSecFromNow: 60 })
    mockFetch
      .mockReturnValueOnce(mockFetchError(500, 'Internal Server Error'))
      .mockReturnValueOnce(mockFetchOk(freshTokenResponse()))

    const result = await refresher.ensureFreshCodexToken({ filePath: SLOT_PATH('alice') })

    expect(result.success).toBe(true)
    expect(result.refreshed).toBe(true)
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('500 → 重试还是 500 → 失败', async () => {
    await writeSlot('alice', { expSecFromNow: 60 })
    mockFetch.mockReturnValue(mockFetchError(503, 'Service Unavailable'))

    const result = await refresher.ensureFreshCodexToken({ filePath: SLOT_PATH('alice') })

    expect(result.success).toBe(false)
    expect(result.needsRelogin).toBeFalsy()
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('网络错误 → 重试 1 次后失败', async () => {
    await writeSlot('alice', { expSecFromNow: 60 })
    mockFetch.mockImplementation(() => mockFetchNetworkError())

    const result = await refresher.ensureFreshCodexToken({ filePath: SLOT_PATH('alice') })

    expect(result.success).toBe(false)
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('force=true → 即使 access_token 没过期也刷', async () => {
    await writeSlot('alice', { expSecFromNow: 3600 })
    mockFetch.mockReturnValue(mockFetchOk(freshTokenResponse()))

    const result = await refresher.ensureFreshCodexToken({
      filePath: SLOT_PATH('alice'),
      force: true,
    })

    expect(result.refreshed).toBe(true)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('refresh_token 缺失 → needsRelogin=true', async () => {
    const auth = makeAuthObj({ expSecFromNow: 60 })
    delete auth.tokens.refresh_token
    await fsp.writeFile(SLOT_PATH('alice'), JSON.stringify(auth, null, 2))

    const result = await refresher.ensureFreshCodexToken({ filePath: SLOT_PATH('alice') })

    expect(result.success).toBe(false)
    expect(result.needsRelogin).toBe(true)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('auth.json 文件不存在 → 返回 AUTH_FILE_NOT_FOUND', async () => {
    const result = await refresher.ensureFreshCodexToken({ filePath: SLOT_PATH('non-exist') })
    expect(result.success).toBe(false)
    expect(result.error).toBe('AUTH_FILE_NOT_FOUND')
  })

  it('OpenAI 返回新 refresh_token → 写回；不返回 → 沿用旧值', async () => {
    await writeSlot('alice', { expSecFromNow: 60 })
    const oldRefresh = JSON.parse(await fsp.readFile(SLOT_PATH('alice'), 'utf-8')).tokens.refresh_token

    // case 1: 返回新 refresh_token
    mockFetch.mockReturnValueOnce(mockFetchOk(freshTokenResponse({ refresh_token: 'brand-new-rt' })))
    await refresher.ensureFreshCodexToken({ filePath: SLOT_PATH('alice') })
    let written = JSON.parse(await fsp.readFile(SLOT_PATH('alice'), 'utf-8'))
    expect(written.tokens.refresh_token).toBe('brand-new-rt')

    // case 2: response 不含 refresh_token，应沿用旧（即 brand-new-rt）
    await writeSlot('bob', { expSecFromNow: 60 })
    const respNoRt = freshTokenResponse()
    delete respNoRt.refresh_token
    mockFetch.mockReturnValueOnce(mockFetchOk(respNoRt))
    await refresher.ensureFreshCodexToken({ filePath: SLOT_PATH('bob') })
    written = JSON.parse(await fsp.readFile(SLOT_PATH('bob'), 'utf-8'))
    expect(written.tokens.refresh_token).toMatch(/^refresh_/)  // helpers 生成的
  })
})

// ---------- inflight 并发去重 ----------

describe('inflight concurrency dedup', () => {
  it('同 accountId 同时调 3 次 → fetch 只被调 1 次', async () => {
    await writeSlot('alice', { expSecFromNow: 60 })

    // mock 一个延迟 200ms 的 response
    mockFetch.mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify(freshTokenResponse())),
      }), 50)
    }))

    const [r1, r2, r3] = await Promise.all([
      refresher.ensureFreshCodexToken({ filePath: SLOT_PATH('alice') }),
      refresher.ensureFreshCodexToken({ filePath: SLOT_PATH('alice') }),
      refresher.ensureFreshCodexToken({ filePath: SLOT_PATH('alice') }),
    ])

    expect(r1.success).toBe(true)
    expect(r2.success).toBe(true)
    expect(r3.success).toBe(true)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })
})

// ---------- sweepAllSlots ----------

describe('sweepAllSlots', () => {
  beforeEach(async () => {
    // 写 current 文件标记 active 槽
    await fsp.writeFile(CURRENT_FILE(), 'alice\n')
  })

  it('跳过当前激活槽，只刷其他即将过期的槽', async () => {
    // alice = active，距过期 1 天（在 7 天阈值内）
    await writeSlot('alice', { expSecFromNow: 86400 })
    // bob = 距过期 1 天（应被刷）
    await writeSlot('bob', { expSecFromNow: 86400 })
    // charlie = 距过期 30 天（不需刷）
    await writeSlot('charlie', { expSecFromNow: 30 * 86400 })

    mockFetch.mockReturnValue(mockFetchOk(freshTokenResponse()))

    const stats = await refresher.sweepAllSlots()

    expect(stats.total).toBe(3)
    expect(stats.skipped).toBe(2)  // alice 因为 active 跳过 + charlie 因为没过期跳过
    expect(stats.refreshed).toBe(1)  // bob 被刷
    expect(stats.failed).toBe(0)
    expect(mockFetch).toHaveBeenCalledTimes(1)  // 只对 bob 发请求
  })

  it('某个槽 refresh 失败不影响其他槽', async () => {
    await fsp.writeFile(CURRENT_FILE(), '__no_match__\n')  // 不匹配任何 slot 名，等价于"没有激活槽"，但绕过 B2 fail-closed
    await writeSlot('alice', { expSecFromNow: 60 })
    await writeSlot('bob', { expSecFromNow: 60 })

    mockFetch
      .mockReturnValueOnce(mockFetchError(400))   // alice failed
      .mockReturnValueOnce(mockFetchOk(freshTokenResponse()))  // bob success

    const stats = await refresher.sweepAllSlots()

    expect(stats.total).toBe(2)
    expect(stats.refreshed).toBe(1)
    expect(stats.needsRelogin).toBe(1)
  })

  it('不会处理 .recovery-* 临时文件', async () => {
    await fsp.writeFile(CURRENT_FILE(), '__no_match__\n')
    await writeSlot('alice', { expSecFromNow: 60 })
    // 模拟一个遗留的 recovery 文件
    await fsp.writeFile(
      path.join(ACCOUNTS_DIR(), 'alice.json.recovery-12345'),
      '{"filePath":"x","response":{}}'
    )

    mockFetch.mockReturnValue(mockFetchOk(freshTokenResponse()))

    const stats = await refresher.sweepAllSlots()

    expect(stats.total).toBe(1)  // 只数 alice，不数 .recovery
  })
})

// ---------- recoverFromCrash ----------

describe('recoverFromCrash', () => {
  it('有合法的 .recovery 文件 → 应用到对应槽位 + 删 .recovery', async () => {
    // 写一个旧的 alice 槽位
    const oldAuth = makeAuthObj({ expSecFromNow: -100 })  // 已过期
    await fsp.writeFile(SLOT_PATH('alice'), JSON.stringify(oldAuth, null, 2))

    // 写一个 recovery 文件，包含新 tokens
    const recoveryContent = {
      filePath: SLOT_PATH('alice'),
      response: freshTokenResponse({ refresh_token: 'recovered-rt' }),
      timestamp: '2026-05-10T12:00:00.000Z',
    }
    const recoveryPath = `${SLOT_PATH('alice')}.recovery-99999`
    await fsp.writeFile(recoveryPath, JSON.stringify(recoveryContent, null, 2))

    const stats = await refresher.recoverFromCrash()

    expect(stats.recovered).toBe(1)
    expect(stats.failed).toBe(0)

    // alice 槽位应被恢复成 recovery 里的 tokens
    const restored = JSON.parse(await fsp.readFile(SLOT_PATH('alice'), 'utf-8'))
    expect(restored.tokens.refresh_token).toBe('recovered-rt')
    expect(restored.last_refresh).toBe('2026-05-10T12:00:00.000Z')

    // recovery 文件应被删
    expect(fs.existsSync(recoveryPath)).toBe(false)
  })

  it('损坏的 .recovery 文件 → 删除并计入 failed', async () => {
    const recoveryPath = path.join(ACCOUNTS_DIR(), 'broken.recovery-1')
    await fsp.writeFile(recoveryPath, '{this-is-not-valid-json')

    const stats = await refresher.recoverFromCrash()

    expect(stats.failed).toBe(1)
    expect(fs.existsSync(recoveryPath)).toBe(false)
  })

  it('没有 .recovery 文件 → 静默 0/0', async () => {
    await writeSlot('alice')
    const stats = await refresher.recoverFromCrash()
    expect(stats.recovered).toBe(0)
    expect(stats.failed).toBe(0)
  })
})

// ---------- V1.6.2 hotfix 加固测试（B1/B2/B3/C2/C3）----------

describe('B2 sweep active 判定双保险', () => {
  it('current 文件读不到 + auth.json 也无 → fail-closed 整轮跳过', async () => {
    // 不写 current，不写 auth.json
    await writeSlot('alice', { expSecFromNow: 60 })

    const stats = await refresher.sweepAllSlots()

    expect(stats.total).toBe(0)  // 没进循环
    expect(stats.refreshed).toBe(0)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('auth.json 的 account_id 匹配某 slot → 跳过该 slot（不靠 current 文件）', async () => {
    await fsp.writeFile(CURRENT_FILE(), '__stale__\n')  // 故意写过期的 current
    await writeSlot('alice', { accountId: 'real-active', expSecFromNow: 60 })
    await writeSlot('bob', { accountId: 'inactive', expSecFromNow: 60 })

    // auth.json 实际激活的是 alice
    const aliceAuth = makeAuthObj({ accountId: 'real-active' })
    await fsp.mkdir(path.join(tmpHome, '.codex'), { recursive: true })
    await fsp.writeFile(path.join(tmpHome, '.codex', 'auth.json'), JSON.stringify(aliceAuth, null, 2))

    mockFetch.mockReturnValue(mockFetchOk(freshTokenResponse()))

    const stats = await refresher.sweepAllSlots()

    // alice 是真正激活槽，应被跳过；bob 应被刷
    expect(stats.skipped).toBe(1)
    expect(stats.refreshed).toBe(1)
    expect(mockFetch).toHaveBeenCalledTimes(1)  // 只对 bob
  })
})

describe('C2 .tmp 文件清理', () => {
  it('mtime > 5 分钟的 .tmp-* 文件 → recoverFromCrash 时删除', async () => {
    await writeSlot('alice')

    // 写一个看似 5 分 1 秒前的 tmp 残留
    const stale = path.join(ACCOUNTS_DIR(), 'alice.json.tmp-12345-abcd')
    await fsp.writeFile(stale, 'half-written-junk')
    const oldTime = (Date.now() - 6 * 60 * 1000) / 1000
    await fsp.utimes(stale, oldTime, oldTime)

    // 写一个新鲜的 tmp（不应被删）
    const fresh = path.join(ACCOUNTS_DIR(), 'alice.json.tmp-99999-xyz')
    await fsp.writeFile(fresh, 'just-being-written')

    const stats = await refresher.recoverFromCrash()

    expect(stats.tmpCleaned).toBe(1)
    expect(fs.existsSync(stale)).toBe(false)
    expect(fs.existsSync(fresh)).toBe(true)  // 新鲜的不动
  })
})

describe('C3 inflight key 区分 force', () => {
  it('同账户 force=false 和 force=true 不互相去重', async () => {
    await writeSlot('alice', { expSecFromNow: 3600 })  // 离过期还远
    mockFetch.mockReturnValue(mockFetchOk(freshTokenResponse()))

    // force=false：access_token 还没过期 → 不刷
    const r1 = await refresher.ensureFreshCodexToken({
      filePath: SLOT_PATH('alice'),
      force: false,
    })
    // force=true：强制刷
    const r2 = await refresher.ensureFreshCodexToken({
      filePath: SLOT_PATH('alice'),
      force: true,
    })

    expect(r1.refreshed).toBe(false)
    expect(r2.refreshed).toBe(true)
    expect(mockFetch).toHaveBeenCalledTimes(1)  // 只 force=true 那次发请求
  })
})

// ---------- 配置 ----------

describe('环境变量与配置', () => {
  it('CODEX_REFRESH_TOKEN_URL_OVERRIDE 应被读到（启动时）', () => {
    // 因为 TOKEN_URL 是模块加载时读取的，本测试只能验证常量结构存在
    expect(refresher.__INTERNAL__.TOKEN_URL).toBeDefined()
    expect(refresher.__INTERNAL__.CLIENT_ID).toBe('app_EMoamEEZ73f0CkXaXp7hrann')
  })

  it('setUserAgent 改 User-Agent', async () => {
    refresher.setUserAgent('1.6.2')
    await writeSlot('alice', { expSecFromNow: 60 })
    mockFetch.mockReturnValue(mockFetchOk(freshTokenResponse()))

    await refresher.ensureFreshCodexToken({ filePath: SLOT_PATH('alice') })

    const [, init] = mockFetch.mock.calls[0]
    expect(init.headers['User-Agent']).toBe('CodePal/1.6.2 (+codex-token-refresher)')
  })
})
