/**
 * V1.6.2 codexAccountService 增强测试
 *
 * 覆盖 V1.6.2 修复 Bug A + Bug B：
 * - syncCurrentToActiveSlot 永远返回 {ok, reason}，所有异常路径不抛
 * - switchAccount 在 sync 失败时返回 SYNC_BEFORE_SWITCH_FAILED 不执行 swap
 * - switchAccount 在 lazy refresh needsRelogin 时返回 TARGET_NEEDS_RELOGIN
 *
 * @module 自动化测试/V1.6.2/codexAccountService.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import accountService from '../../electron/services/codexAccountService'
import { makeAuthObj } from '../V1.5.0/helpers'

// 同一份 service 实例（accountService 自己 require 的 refresher 才是它内部用的实例）
const linkedAccountService = accountService
const linkedRefresher = accountService.__INTERNAL__.getLinkedRefresher()

let tmpHome
let mockExecFile
let mockFetch

const ACCOUNTS_DIR = () => path.join(tmpHome, '.codex-switcher', 'accounts')
const SLOT_PATH = (name) => path.join(ACCOUNTS_DIR(), `${name}.json`)
const CURRENT_FILE = () => path.join(tmpHome, '.codex-switcher', 'current')
const AUTH_FILE = () => path.join(tmpHome, '.codex', 'auth.json')

beforeEach(async () => {
  tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-account-v162-'))
  linkedAccountService.__INTERNAL__.__setHomeDir(tmpHome)
  await fsp.mkdir(ACCOUNTS_DIR(), { recursive: true })
  await fsp.mkdir(path.dirname(AUTH_FILE()), { recursive: true })

  // mock execFile（pgrep）→ Codex 没在跑
  mockExecFile = vi.fn((cmd, args, opts, cb) => {
    cb(Object.assign(new Error('not found'), { code: 1 }), '', '')
  })
  linkedAccountService.__INTERNAL__.__setExecFile(mockExecFile)

  // mock fetch for refresher（不主动刷）
  mockFetch = vi.fn()
  linkedRefresher.__INTERNAL__.__setFetch(mockFetch)
  linkedRefresher.__INTERNAL__.inflight.clear()
})

afterEach(async () => {
  linkedAccountService.__INTERNAL__.__resetExecFile()
  linkedAccountService.__INTERNAL__.__resetHomeDir()
  linkedRefresher.__INTERNAL__.__resetFetch()
  linkedRefresher.__INTERNAL__.inflight.clear()
  await fsp.rm(tmpHome, { recursive: true, force: true })
})

async function writeSlotAndAuth(name, opts = {}) {
  // 默认 expSecFromNow 给一个比较长的时间，避免 lazy refresh 触发
  const accountId = opts.accountId || `acc-${name}-${'0'.repeat(32)}`.slice(0, 36)
  const auth = makeAuthObj({ expSecFromNow: 3600, ...opts, accountId })
  await fsp.writeFile(SLOT_PATH(name), JSON.stringify(auth, null, 2))
  return auth
}

// ---------- syncCurrentToActiveSlot 永不抛 ----------

describe('syncCurrentToActiveSlot 异常安全（Bug A 修复）', () => {
  it('auth.json 不存在 → ok=true reason=no-auth-file', async () => {
    const result = await linkedAccountService.__INTERNAL__.syncCurrentToActiveSlot()
    expect(result.ok).toBe(true)
    expect(result.reason).toBe('no-auth-file')
  })

  it('hash 一致无需同步 → ok=true reason=already-synced', async () => {
    const auth = await writeSlotAndAuth('alice')
    await fsp.writeFile(AUTH_FILE(), JSON.stringify(auth, null, 2))
    await fsp.writeFile(CURRENT_FILE(), 'alice\n')

    const result = await linkedAccountService.__INTERNAL__.syncCurrentToActiveSlot()
    expect(result.ok).toBe(true)
    expect(result.reason).toBe('already-synced')
  })

  it('真同步成功 → ok=true reason=synced', async () => {
    await writeSlotAndAuth('alice', { expSecFromNow: 1000 })
    // auth.json 是同账户但 token 较新（不同 hash）
    const newerAuth = makeAuthObj({
      accountId: `acc-alice-${'0'.repeat(32)}`.slice(0, 36),
      expSecFromNow: 9000,
    })
    await fsp.writeFile(AUTH_FILE(), JSON.stringify(newerAuth, null, 2))
    await fsp.writeFile(CURRENT_FILE(), 'alice\n')

    const result = await linkedAccountService.__INTERNAL__.syncCurrentToActiveSlot()
    expect(result.ok).toBe(true)
    expect(result.reason).toBe('synced')

    // alice 槽位现在应该是 newerAuth
    const slotContent = JSON.parse(await fsp.readFile(SLOT_PATH('alice'), 'utf-8'))
    expect(slotContent.tokens.access_token).toBe(newerAuth.tokens.access_token)
  })

  it('账户 ID 不一致 → ok=true reason=account-mismatch（不污染槽位）', async () => {
    await writeSlotAndAuth('alice', { accountId: 'aaa-id' })
    // auth.json 是另一个账户
    const otherAuth = makeAuthObj({ accountId: 'bbb-id' })
    await fsp.writeFile(AUTH_FILE(), JSON.stringify(otherAuth, null, 2))
    await fsp.writeFile(CURRENT_FILE(), 'alice\n')

    const result = await linkedAccountService.__INTERNAL__.syncCurrentToActiveSlot()
    expect(result.ok).toBe(true)
    expect(result.reason).toBe('account-mismatch')
  })
})

// ---------- switchAccount sync 失败拦截 ----------

describe('switchAccount sync 失败必须拦截（Bug A 修复）', () => {
  it('atomicCopy 抛错 → 返回 SYNC_BEFORE_SWITCH_FAILED', async () => {
    // 准备两个账户（alice 当前激活，bob 是切换目标）
    const aliceAuth = await writeSlotAndAuth('alice', { accountId: 'aaa', expSecFromNow: 1000 })
    await writeSlotAndAuth('bob', { accountId: 'bbb', expSecFromNow: 3600 })

    // auth.json 的 token 比 alice 槽位新（不同 hash）→ 应该触发同步
    const newerAlice = makeAuthObj({ accountId: 'aaa', expSecFromNow: 9000 })
    await fsp.writeFile(AUTH_FILE(), JSON.stringify(newerAlice, null, 2))
    await fsp.writeFile(CURRENT_FILE(), 'alice\n')

    // 把 alice 槽位文件 readonly + 0 权限模拟同步失败
    // （但 atomicCopy 用 rename，临时文件先创建在同目录，rename 应该能成功；
    // 改用更可靠的方式：让目录变只读）
    const accountsDir = ACCOUNTS_DIR()
    await fsp.chmod(accountsDir, 0o500)  // r-x，禁止写

    const result = await linkedAccountService.switchAccount('bob')

    // 清理（让 afterEach 能 rm 掉）
    await fsp.chmod(accountsDir, 0o700).catch(() => {})

    expect(result.success).toBe(false)
    expect(result.error).toBe('SYNC_BEFORE_SWITCH_FAILED')
    expect(result.hint).toMatch(/保存当前账户凭证.*失败/)

    // 验证：auth.json 仍然是 newerAlice，没被 swap 成 bob
    const authStill = JSON.parse(await fsp.readFile(AUTH_FILE(), 'utf-8'))
    expect(authStill.tokens.account_id).toBe('aaa')
  })
})

// ---------- switchAccount lazy refresh ----------

describe('switchAccount lazy refresh 目标槽（Bug B 修复）', () => {
  it('目标槽 access_token 即将过期 → 切换前先 refresh', async () => {
    const aliceAuth = await writeSlotAndAuth('alice', { accountId: 'aaa', expSecFromNow: 3600 })
    await writeSlotAndAuth('bob', { accountId: 'bbb', expSecFromNow: 60 })  // 即将过期

    await fsp.writeFile(AUTH_FILE(), JSON.stringify(aliceAuth, null, 2))
    await fsp.writeFile(CURRENT_FILE(), 'alice\n')

    // mock refresh 成功
    const exp = Math.floor(Date.now() / 1000) + 3600
    mockFetch.mockReturnValue(Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({
        access_token: 'a.b.c',  // 新 token（实际场景会是真 JWT，简化测试）
        id_token: 'a.b.c',
        refresh_token: 'new-rt',
        expires_in: 3600,
      })),
    }))

    const result = await linkedAccountService.switchAccount('bob')

    expect(result.success).toBe(true)
    expect(mockFetch).toHaveBeenCalledTimes(1)  // lazy refresh 触发了
  })

  it('目标槽 needsRelogin（400 invalid_grant） → 拒绝切换', async () => {
    const aliceAuth = await writeSlotAndAuth('alice', { accountId: 'aaa', expSecFromNow: 3600 })
    await writeSlotAndAuth('bob', { accountId: 'bbb', expSecFromNow: 60 })

    await fsp.writeFile(AUTH_FILE(), JSON.stringify(aliceAuth, null, 2))
    await fsp.writeFile(CURRENT_FILE(), 'alice\n')

    // mock refresh 返回 400
    mockFetch.mockReturnValue(Promise.resolve({
      ok: false,
      status: 400,
      text: () => Promise.resolve('{"error":"invalid_grant"}'),
    }))

    const result = await linkedAccountService.switchAccount('bob')

    expect(result.success).toBe(false)
    expect(result.error).toBe('TARGET_NEEDS_RELOGIN')
    expect(result.hint).toMatch(/授权已过期/)

    // auth.json 应该还是 alice（没被 swap）
    const authStill = JSON.parse(await fsp.readFile(AUTH_FILE(), 'utf-8'))
    expect(authStill.tokens.account_id).toBe('aaa')
  })

  it('目标槽 access_token 还远未过期 → 不发 fetch，直接 swap', async () => {
    const aliceAuth = await writeSlotAndAuth('alice', { accountId: 'aaa', expSecFromNow: 3600 })
    await writeSlotAndAuth('bob', { accountId: 'bbb', expSecFromNow: 3600 })

    await fsp.writeFile(AUTH_FILE(), JSON.stringify(aliceAuth, null, 2))
    await fsp.writeFile(CURRENT_FILE(), 'alice\n')

    const result = await linkedAccountService.switchAccount('bob')

    expect(result.success).toBe(true)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('B3: 切换成功后写入 __codepal_last_switch_at 字段', async () => {
    const aliceAuth = await writeSlotAndAuth('alice', { accountId: 'aaa', expSecFromNow: 3600 })
    await writeSlotAndAuth('bob', { accountId: 'bbb', expSecFromNow: 3600 })

    await fsp.writeFile(AUTH_FILE(), JSON.stringify(aliceAuth, null, 2))
    await fsp.writeFile(CURRENT_FILE(), 'alice\n')

    const before = Date.now()
    const result = await linkedAccountService.switchAccount('bob')
    const after = Date.now()

    expect(result.success).toBe(true)

    // bob slot 现在应有 __codepal_last_switch_at 字段
    const bobSlot = JSON.parse(await fsp.readFile(SLOT_PATH('bob'), 'utf-8'))
    expect(typeof bobSlot.__codepal_last_switch_at).toBe('number')
    expect(bobSlot.__codepal_last_switch_at).toBeGreaterThanOrEqual(before)
    expect(bobSlot.__codepal_last_switch_at).toBeLessThanOrEqual(after)
  })

  it('B3: refresher 续 token 时保留 __codepal_last_switch_at 字段', async () => {
    const original = Date.now() - 5 * 86400 * 1000  // 5 天前
    const slotPath = SLOT_PATH('alice')

    // 写一个带 __codepal_last_switch_at 的 slot
    const auth = makeAuthObj({ accountId: 'aaa', expSecFromNow: 60 })
    auth.__codepal_last_switch_at = original
    await fsp.writeFile(slotPath, JSON.stringify(auth, null, 2))

    // mock refresh 成功
    const exp = Math.floor(Date.now() / 1000) + 3600
    mockFetch.mockReturnValue(Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({
        access_token: 'new.access.token',
        id_token: 'new.id.token',
        refresh_token: 'new-rt',
        expires_in: 3600,
      })),
    }))

    await linkedRefresher.ensureFreshCodexToken({ filePath: slotPath, force: true })

    // 续完后，__codepal_last_switch_at 字段应保留为原始值（不被 refresher 改）
    const after = JSON.parse(await fsp.readFile(slotPath, 'utf-8'))
    expect(after.__codepal_last_switch_at).toBe(original)
    // 但 last_refresh 字段应被更新
    expect(after.last_refresh).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('目标槽 refresh 网络错误 → 不阻塞切换（让 Codex 自己尝试）', async () => {
    const aliceAuth = await writeSlotAndAuth('alice', { accountId: 'aaa', expSecFromNow: 3600 })
    await writeSlotAndAuth('bob', { accountId: 'bbb', expSecFromNow: 60 })

    await fsp.writeFile(AUTH_FILE(), JSON.stringify(aliceAuth, null, 2))
    await fsp.writeFile(CURRENT_FILE(), 'alice\n')

    // mock 网络错误：5xx，会重试一次
    mockFetch.mockImplementation(() => Promise.reject(new Error('ECONNREFUSED')))

    const result = await linkedAccountService.switchAccount('bob')

    // 网络错误 → 不阻塞 switch，仍然成功
    expect(result.success).toBe(true)
    // 重试 1 次
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })
})
