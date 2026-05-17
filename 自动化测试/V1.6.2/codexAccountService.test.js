/**
 * V1.6.2 codexAccountService 增强测试
 *
 * 覆盖 V1.6.2 修复 Bug A + Bug B：
 * - syncCurrentToActiveSlot 永远返回 {ok, reason}，所有异常路径不抛
 * - switchAccount 在 sync 失败时返回 SYNC_BEFORE_SWITCH_FAILED 不执行 swap
 * - switchAccount 在 lazy refresh needsRelogin 时返回 TARGET_NEEDS_RELOGIN
 * - restartCodex 切换会完整退出并重新打开 Codex
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

  // mock execFile（ps）→ Codex 没在跑
  mockExecFile = vi.fn((cmd, args, opts, cb) => {
    if (cmd === 'ps') cb(null, '', '')
    else cb(null, '', '')
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
  // 默认 expSecFromNow 给 10 天，避免 7 天阈值的 lazy refresh 触发
  const accountId = opts.accountId || `acc-${name}-${'0'.repeat(32)}`.slice(0, 36)
  const auth = makeAuthObj({ expSecFromNow: 10 * 86400, ...opts, accountId })
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

  it('current 槽账户 ID 不一致且无匹配槽 → ok=false（不污染槽位）', async () => {
    await writeSlotAndAuth('alice', { accountId: 'aaa-id' })
    // auth.json 是另一个账户
    const otherAuth = makeAuthObj({ accountId: 'bbb-id' })
    await fsp.writeFile(AUTH_FILE(), JSON.stringify(otherAuth, null, 2))
    await fsp.writeFile(CURRENT_FILE(), 'alice\n')

    const result = await linkedAccountService.__INTERNAL__.syncCurrentToActiveSlot()
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('active-slot-mismatch')
  })

  it('current 槽位 JSON 损坏 → 用 live auth 修复槽位', async () => {
    const liveAuth = makeAuthObj({ accountId: 'aaa-id', expSecFromNow: 10 * 86400 })
    await fsp.writeFile(SLOT_PATH('alice'), '{bad json')
    await fsp.writeFile(AUTH_FILE(), JSON.stringify(liveAuth, null, 2))
    await fsp.writeFile(CURRENT_FILE(), 'alice\n')

    const result = await linkedAccountService.__INTERNAL__.syncCurrentToActiveSlot()

    expect(result.ok).toBe(true)
    expect(result.reason).toBe('repaired-parse-failed-slot')
    const repaired = JSON.parse(await fsp.readFile(SLOT_PATH('alice'), 'utf-8'))
    expect(repaired.tokens.account_id).toBe('aaa-id')
  })

  it('current 缺失但 account_id 匹配已保存槽 → 按 account_id 同步', async () => {
    await writeSlotAndAuth('alice', { accountId: 'aaa-id', expSecFromNow: 1000 })
    const liveAuth = makeAuthObj({ accountId: 'aaa-id', expSecFromNow: 10 * 86400 })
    await fsp.writeFile(AUTH_FILE(), JSON.stringify(liveAuth, null, 2))

    const result = await linkedAccountService.__INTERNAL__.syncCurrentToActiveSlot()

    expect(result.ok).toBe(true)
    expect(result.reason).toBe('synced-by-account-id')
    const stored = JSON.parse(await fsp.readFile(SLOT_PATH('alice'), 'utf-8'))
    expect(stored.tokens.access_token).toBe(liveAuth.tokens.access_token)
  })

  it('live auth 未归属任何已保存槽 → 拒绝继续切换以保护唯一凭证', async () => {
    await writeSlotAndAuth('bob', { accountId: 'bbb-id', expSecFromNow: 10 * 86400 })
    const liveAuth = makeAuthObj({ accountId: 'unsaved-id', expSecFromNow: 10 * 86400 })
    await fsp.writeFile(AUTH_FILE(), JSON.stringify(liveAuth, null, 2))

    const result = await linkedAccountService.switchAccount('bob')

    expect(result.success).toBe(false)
    expect(result.error).toBe('SYNC_BEFORE_SWITCH_FAILED')
    const authStill = JSON.parse(await fsp.readFile(AUTH_FILE(), 'utf-8'))
    expect(authStill.tokens.account_id).toBe('unsaved-id')
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

  it('restartCodex=true 且目标槽 needsRelogin → 拒绝切换并重新打开原 Codex', async () => {
    const aliceAuth = await writeSlotAndAuth('alice', { accountId: 'aaa', expSecFromNow: 10 * 86400 })
    await writeSlotAndAuth('bob', { accountId: 'bbb', expSecFromNow: 60 })

    await fsp.writeFile(AUTH_FILE(), JSON.stringify(aliceAuth, null, 2))
    await fsp.writeFile(CURRENT_FILE(), 'alice\n')

    const runningPs = ' 100 1 /Applications/Codex.app/Contents/MacOS/Codex\n'
    let psCalls = 0
    mockExecFile.mockImplementation((cmd, args, opts, cb) => {
      if (cmd === 'ps') {
        psCalls += 1
        cb(null, psCalls <= 2 ? runningPs : '', '')
        return
      }
      cb(null, '', '')
    })
    mockFetch.mockReturnValue(Promise.resolve({
      ok: false,
      status: 400,
      text: () => Promise.resolve('{"error":"invalid_grant"}'),
    }))

    const result = await linkedAccountService.switchAccount('bob', { restartCodex: true })

    expect(result.success).toBe(false)
    expect(result.error).toBe('TARGET_NEEDS_RELOGIN')
    expect(result.codexWasRunning).toBe(true)
    expect(result.restarted).toBe(true)
    expect(mockExecFile.mock.calls.some((c) => c[0] === 'open')).toBe(true)

    const authStill = JSON.parse(await fsp.readFile(AUTH_FILE(), 'utf-8'))
    expect(authStill.tokens.account_id).toBe('aaa')
  })

  // 【回归】这条原本断言"access_token 没快过期就不刷、直接 swap 冻结槽位"，
  // 并且是绿的——正是这个断言把 bug 行为认证成了正确预期，导致带病发版。
  // 真实事故：槽位是冻结快照，refresh_token 早被 Codex 自己轮换作废；
  // 用 access_token 过期时间做判断是看错时钟。修复后：切换到非激活账户
  // 必须无条件强制刷新，跟 access_token 还剩几天过期无关。
  it('目标槽 access_token 还很久才过期 → 仍必须强制刷新（不再端冻结旧票）', async () => {
    const aliceAuth = await writeSlotAndAuth('alice', { accountId: 'aaa', expSecFromNow: 10 * 86400 })
    await writeSlotAndAuth('bob', { accountId: 'bbb', expSecFromNow: 10 * 86400 })

    await fsp.writeFile(AUTH_FILE(), JSON.stringify(aliceAuth, null, 2))
    await fsp.writeFile(CURRENT_FILE(), 'alice\n')

    mockFetch.mockReturnValue(Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({
        access_token: 'a.b.c', id_token: 'a.b.c', refresh_token: 'minted-on-switch', expires_in: 3600,
      })),
    }))

    const result = await linkedAccountService.switchAccount('bob')

    expect(result.success).toBe(true)
    expect(mockFetch).toHaveBeenCalledTimes(1)  // 强制刷新触发，不再静默端旧票
  })

  it('目标就是当前激活账户 → 跳过强制刷新，不无谓轮换活号', async () => {
    const aliceAuth = await writeSlotAndAuth('alice', { accountId: 'aaa', expSecFromNow: 10 * 86400 })
    await fsp.writeFile(AUTH_FILE(), JSON.stringify(aliceAuth, null, 2))
    await fsp.writeFile(CURRENT_FILE(), 'alice\n')

    const result = await linkedAccountService.switchAccount('alice')

    expect(result.success).toBe(true)
    expect(mockFetch).not.toHaveBeenCalled()  // 已是激活账户，live token 本就能用
  })

  // 【核心回归】模拟真实 OpenAI：refresh_token 一次性，用过即废。
  // 这是 mock 永远返回新票的旧测试结构上无法覆盖的那类 bug。
  it('槽位 refresh_token 已被轮换作废 → 切换必须拦截并引导重登，绝不把废票端给 Codex', async () => {
    const aliceAuth = await writeSlotAndAuth('alice', { accountId: 'aaa', expSecFromNow: 10 * 86400 })
    // bob 槽位是冻结快照，里面的 refresh_token 早被 Codex 自己轮换作废
    await writeSlotAndAuth('bob', { accountId: 'bbb', expSecFromNow: 10 * 86400 })

    await fsp.writeFile(AUTH_FILE(), JSON.stringify(aliceAuth, null, 2))
    await fsp.writeFile(CURRENT_FILE(), 'alice\n')

    // OpenAI 单次性语义：alive 集合为空 = bob 那张冻结的票已死，
    // 拿它换票 → 400 invalid_grant「refresh token was already used」
    const alive = new Set()
    mockFetch.mockImplementation((_url, init) => {
      const body = JSON.parse(init.body)
      if (!alive.has(body.refresh_token)) {
        return Promise.resolve({
          ok: false,
          status: 400,
          text: () => Promise.resolve('{"error":"invalid_grant","error_description":"refresh token was already used"}'),
        })
      }
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{}') })
    })

    const result = await linkedAccountService.switchAccount('bob')

    expect(result.success).toBe(false)
    expect(result.error).toBe('TARGET_NEEDS_RELOGIN')
    // 关键：auth.json 必须还是 alice，没把 bob 的废票 swap 进去坑 Codex
    const authStill = JSON.parse(await fsp.readFile(AUTH_FILE(), 'utf-8'))
    expect(authStill.tokens.account_id).toBe('aaa')

    // UX：确认死了 → 槽位打上 needs_relogin 标记，listSavedAccounts 据此标红
    const bobSlot = JSON.parse(await fsp.readFile(SLOT_PATH('bob'), 'utf-8'))
    expect(bobSlot.__codepal_needs_relogin).toBe(true)
    const list = await linkedAccountService.listSavedAccounts()
    expect(list.accounts.find((a) => a.name === 'bob').expired).toBe(true)
  })

  it('成功切入必清掉残留的 needs_relogin 标记（兜 watcher 错过同步导致卡片一直红）', async () => {
    const aliceAuth = await writeSlotAndAuth('alice', { accountId: 'aaa', expSecFromNow: 10 * 86400 })
    // bob 其实已恢复（token 有效），但还残留着上次失败打的标记
    const bob = await writeSlotAndAuth('bob', { accountId: 'bbb', expSecFromNow: 10 * 86400 })
    bob.__codepal_needs_relogin = true
    await fsp.writeFile(SLOT_PATH('bob'), JSON.stringify(bob, null, 2))

    await fsp.writeFile(AUTH_FILE(), JSON.stringify(aliceAuth, null, 2))
    await fsp.writeFile(CURRENT_FILE(), 'alice\n')

    // force 刷新走网络失败的软降级路径（不阻塞切换）
    mockFetch.mockImplementation(() => Promise.reject(new Error('ECONNREFUSED')))

    const result = await linkedAccountService.switchAccount('bob')

    expect(result.success).toBe(true)
    const bobSlot = JSON.parse(await fsp.readFile(SLOT_PATH('bob'), 'utf-8'))
    expect(bobSlot.__codepal_needs_relogin).toBeUndefined()  // 标记被清
  })

  it('槽位带 __codepal_needs_relogin 标记 → 即使启发式判活也报 expired（卡片转已失效）', async () => {
    // access_token 还有 10 天才过期，isRefreshTokenLikelyDead 会判"活"
    const dead = await writeSlotAndAuth('zoe', { accountId: 'zzz', expSecFromNow: 10 * 86400 })
    dead.__codepal_needs_relogin = true
    await fsp.writeFile(SLOT_PATH('zoe'), JSON.stringify(dead, null, 2))

    const list = await linkedAccountService.listSavedAccounts()
    expect(list.accounts.find((a) => a.name === 'zoe').expired).toBe(true)
  })

  it('restartCodex=true 且 Codex 在运行 → 先退出 Codex，再 swap，最后重新打开', async () => {
    const aliceAuth = await writeSlotAndAuth('alice', { accountId: 'aaa', expSecFromNow: 10 * 86400 })
    await writeSlotAndAuth('bob', { accountId: 'bbb', expSecFromNow: 10 * 86400 })

    await fsp.writeFile(AUTH_FILE(), JSON.stringify(aliceAuth, null, 2))
    await fsp.writeFile(CURRENT_FILE(), 'alice\n')

    const runningPs = [
      ' 100 1 /Applications/Codex.app/Contents/MacOS/Codex',
      ' 101 100 /Applications/Codex.app/Contents/Resources/codex app-server --analytics-default-enabled',
    ].join('\n')
    let psCalls = 0
    mockExecFile.mockImplementation((cmd, args, opts, cb) => {
      if (cmd === 'ps') {
        psCalls += 1
        cb(null, psCalls <= 2 ? runningPs : '', '')
        return
      }
      cb(null, '', '')
    })

    const result = await linkedAccountService.switchAccount('bob', { restartCodex: true })

    expect(result.success).toBe(true)
    expect(result.codexWasRunning).toBe(true)
    expect(result.restarted).toBe(true)
    expect(mockExecFile.mock.calls.some((c) => c[0] === 'osascript')).toBe(true)
    expect(mockExecFile.mock.calls.some((c) => c[0] === 'open')).toBe(true)

    const written = JSON.parse(await fsp.readFile(AUTH_FILE(), 'utf-8'))
    expect(written.tokens.account_id).toBe('bbb')
    expect(await fsp.readFile(CURRENT_FILE(), 'utf-8')).toBe('bob\n')
  })

  it('restartCodex=true 且已经是目标 auth → noop 后仍重新打开 Codex', async () => {
    const aliceAuth = await writeSlotAndAuth('alice', { accountId: 'aaa', expSecFromNow: 10 * 86400 })

    await fsp.writeFile(AUTH_FILE(), JSON.stringify(aliceAuth, null, 2))
    await fsp.writeFile(CURRENT_FILE(), 'alice\n')

    const runningPs = ' 100 1 /Applications/Codex.app/Contents/MacOS/Codex\n'
    let psCalls = 0
    mockExecFile.mockImplementation((cmd, args, opts, cb) => {
      if (cmd === 'ps') {
        psCalls += 1
        cb(null, psCalls <= 2 ? runningPs : '', '')
        return
      }
      cb(null, '', '')
    })

    const result = await linkedAccountService.switchAccount('alice', { restartCodex: true })

    expect(result.success).toBe(true)
    expect(result.noop).toBe(true)
    expect(result.codexWasRunning).toBe(true)
    expect(result.restarted).toBe(true)
    expect(mockExecFile.mock.calls.some((c) => c[0] === 'open')).toBe(true)
    expect(await fsp.readFile(CURRENT_FILE(), 'utf-8')).toBe('alice\n')
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
