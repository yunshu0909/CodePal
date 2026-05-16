/**
 * codexAccountService 单元测试
 *
 * 关键策略：
 * - 用 tmp dir 作为假 home（__setHomeDir），避免碰真实 ~/.codex/
 * - execFile 用 mock（__setExecFile）控制 ps / osascript / open 的行为
 * - 每个测试重置 tmp dir 保证隔离
 *
 * @module 自动化测试/V1.5.0/codexAccountService.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeAuthObj } from './helpers.js'

const service = await import('../../electron/services/codexAccountService.js').then(
  (m) => m.default || m
)
const {
  readCurrentAuth,
  listSavedAccounts,
  saveAccount,
  renameAccount,
  deleteAccount,
  switchAccount,
  detectStorageMode,
  emailToDefaultName,
  __INTERNAL__,
} = service
const {
  __setHomeDir,
  __resetHomeDir,
  __setExecFile,
  __resetExecFile,
  getLinkedRefresher,
  getAuthFile,
  getAccountsDir,
  getBackupsDir,
  getCurrentFile,
  getConfigTomlFile,
  accountPath,
} = __INTERNAL__

let tmpHome
const execFileMock = vi.fn()
const refresher = getLinkedRefresher()

// ---------- 测试辅助 ----------

function writeAuth(obj) {
  const dir = join(tmpHome, '.codex')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'auth.json'), JSON.stringify(obj, null, 2))
}

function writeConfigToml(content) {
  const dir = join(tmpHome, '.codex')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.toml'), content)
}

function seedAccount(name, obj) {
  mkdirSync(getAccountsDir(), { recursive: true })
  writeFileSync(accountPath(name), JSON.stringify(obj, null, 2))
}

/**
 * 默认 execFile mock：ps 返回空进程表，其他默认成功
 * 测试里可以覆盖
 */
function defaultExecFileBehavior(cmd, args, opts, cb) {
  if (cmd === 'ps') {
    cb(null, '', '')  // Codex 默认不在跑
  } else {
    cb(null, 'ok', '')
  }
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'codex-account-test-'))
  __setHomeDir(tmpHome)
  execFileMock.mockReset()
  execFileMock.mockImplementation(defaultExecFileBehavior)
  __setExecFile(execFileMock)
  refresher.__INTERNAL__.__setFetch(vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify({
      access_token: 'new.access.token',
      id_token: 'new.id.token',
      refresh_token: 'new-refresh-token',
    })),
  }))
  refresher.__INTERNAL__.inflight.clear()
})

afterEach(() => {
  __resetHomeDir()
  __resetExecFile()
  refresher.__INTERNAL__.__resetFetch()
  refresher.__INTERNAL__.inflight.clear()
  if (tmpHome && existsSync(tmpHome)) {
    rmSync(tmpHome, { recursive: true, force: true })
  }
})

// ---------- readCurrentAuth ----------

describe('readCurrentAuth', () => {
  it('auth.json 不存在 → exists=false', async () => {
    const r = await readCurrentAuth()
    expect(r.exists).toBe(false)
  })

  it('auth.json 存在且正常 → 提取 email/plan/accountId', async () => {
    writeAuth(makeAuthObj({ email: 'alice@example.com', plan: 'plus', accountId: 'acc-1' }))
    const r = await readCurrentAuth()
    expect(r.exists).toBe(true)
    expect(r.email).toBe('alice@example.com')
    expect(r.plan).toBe('plus')
    expect(r.accountId).toBe('acc-1')
  })

  it('auth.json 损坏 JSON → exists=true 但 accountId 为空', async () => {
    mkdirSync(join(tmpHome, '.codex'), { recursive: true })
    writeFileSync(getAuthFile(), '{bad json')
    const r = await readCurrentAuth()
    expect(r.exists).toBe(true)
    expect(r.accountId).toBe('')
    expect(r.email).toBe('(invalid-json)')
  })
})

// ---------- detectStorageMode ----------

describe('detectStorageMode', () => {
  it('config.toml 不存在 → file 模式', async () => {
    const r = await detectStorageMode()
    expect(r.mode).toBe('file')
  })
  it('显式 cli_auth_credentials_store = "keyring" → keyring 模式', async () => {
    writeConfigToml(`
# some config
cli_auth_credentials_store = "keyring"
model = "gpt-5"
`)
    const r = await detectStorageMode()
    expect(r.mode).toBe('keyring')
  })
  it('显式 "file" → file 模式', async () => {
    writeConfigToml('cli_auth_credentials_store = "file"')
    expect((await detectStorageMode()).mode).toBe('file')
  })
  it('显式 "auto" → auto 模式', async () => {
    writeConfigToml('cli_auth_credentials_store = "auto"')
    expect((await detectStorageMode()).mode).toBe('auto')
  })
  it('未知值 → unknown', async () => {
    writeConfigToml('cli_auth_credentials_store = "weird"')
    expect((await detectStorageMode()).mode).toBe('unknown')
  })
  it('没有这个 key → file 模式（默认）', async () => {
    writeConfigToml('model = "gpt-5"')
    expect((await detectStorageMode()).mode).toBe('file')
  })
})

// ---------- listSavedAccounts ----------

describe('listSavedAccounts', () => {
  it('空目录 → accounts 数组为空', async () => {
    const r = await listSavedAccounts()
    expect(r.accounts).toEqual([])
    expect(r.activeName).toBe('')
    expect(r.hasUnsavedActive).toBe(false)
  })

  it('3 个账户 + auth.json 匹配其中一个 → 正确标出 activeName', async () => {
    const aliceAuth = makeAuthObj({ email: 'alice@x.com', accountId: 'a1', plan: 'plus' })
    const bobAuth = makeAuthObj({ email: 'bob@x.com', accountId: 'b1', plan: 'pro' })
    const carolAuth = makeAuthObj({ email: 'carol@x.com', accountId: 'c1', plan: 'team' })
    seedAccount('alice', aliceAuth)
    seedAccount('bob', bobAuth)
    seedAccount('carol', carolAuth)
    writeAuth(bobAuth)  // 当前激活是 bob

    const r = await listSavedAccounts()
    expect(r.accounts).toHaveLength(3)
    expect(r.activeName).toBe('bob')
    expect(r.hasUnsavedActive).toBe(false)
  })

  it('auth.json 存在但没匹配任何账户 → hasUnsavedActive=true', async () => {
    seedAccount('alice', makeAuthObj({ email: 'alice@x.com', accountId: 'a1' }))
    writeAuth(makeAuthObj({ email: 'diana@x.com', accountId: 'd1', plan: 'plus' }))

    const r = await listSavedAccounts()
    expect(r.hasUnsavedActive).toBe(true)
    expect(r.unsavedActive.email).toBe('diana@x.com')
    expect(r.unsavedActive.plan).toBe('plus')
    expect(r.activeName).toBe('')
  })

  it('激活账户排在数组首位', async () => {
    seedAccount('alice', makeAuthObj({ accountId: 'a1' }))
    seedAccount('bob', makeAuthObj({ accountId: 'b1' }))
    writeAuth(makeAuthObj({ accountId: 'a1' }))

    const r = await listSavedAccounts()
    expect(r.accounts[0].name).toBe('alice')
  })

  it('损坏文件被标为 expired 但不崩', async () => {
    mkdirSync(getAccountsDir(), { recursive: true })
    writeFileSync(accountPath('broken'), '{not json')
    const r = await listSavedAccounts()
    expect(r.accounts).toHaveLength(1)
    expect(r.accounts[0].name).toBe('broken')
    expect(r.accounts[0].expired).toBe(true)
  })
})

// ---------- saveAccount ----------

describe('saveAccount', () => {
  it('保存当前 auth.json 为新账户', async () => {
    writeAuth(makeAuthObj({ email: 'diana@x.com', accountId: 'd1', plan: 'plus' }))
    const r = await saveAccount('diana')
    expect(r.success).toBe(true)
    expect(r.account.email).toBe('diana@x.com')
    expect(existsSync(accountPath('diana'))).toBe(true)
    // current 应该标记为 diana
    expect(readFileSync(getCurrentFile(), 'utf-8').trim()).toBe('diana')
  })

  it('非法名字 → INVALID_NAME', async () => {
    writeAuth(makeAuthObj())
    const r = await saveAccount('../evil')
    expect(r.success).toBe(false)
    expect(r.error).toBe('INVALID_NAME')
  })

  it('名字已存在 → NAME_EXISTS', async () => {
    writeAuth(makeAuthObj({ accountId: 'a1' }))
    seedAccount('alice', makeAuthObj({ accountId: 'a1' }))
    const r = await saveAccount('alice')
    expect(r.success).toBe(false)
    expect(r.error).toBe('NAME_EXISTS')
  })

  it('auth.json 不存在 → AUTH_JSON_NOT_FOUND', async () => {
    const r = await saveAccount('alice')
    expect(r.success).toBe(false)
    expect(r.error).toBe('AUTH_JSON_NOT_FOUND')
  })
})

// ---------- renameAccount ----------

describe('renameAccount', () => {
  it('正常重命名 → 文件改名 + current 同步', async () => {
    seedAccount('alice', makeAuthObj({ accountId: 'a1' }))
    writeFileSync(getCurrentFile(), 'alice\n')
    const r = await renameAccount('alice', 'alice-work')
    expect(r.success).toBe(true)
    expect(existsSync(accountPath('alice'))).toBe(false)
    expect(existsSync(accountPath('alice-work'))).toBe(true)
    expect(readFileSync(getCurrentFile(), 'utf-8').trim()).toBe('alice-work')
  })

  it('同名 → 幂等成功', async () => {
    seedAccount('alice', makeAuthObj({ accountId: 'a1' }))
    const r = await renameAccount('alice', 'alice')
    expect(r.success).toBe(true)
  })

  it('新名字已存在 → NAME_EXISTS', async () => {
    seedAccount('alice', makeAuthObj({ accountId: 'a1' }))
    seedAccount('bob', makeAuthObj({ accountId: 'b1' }))
    const r = await renameAccount('alice', 'bob')
    expect(r.success).toBe(false)
    expect(r.error).toBe('NAME_EXISTS')
  })

  it('非法名 → INVALID_NAME', async () => {
    seedAccount('alice', makeAuthObj())
    const r = await renameAccount('alice', '../evil')
    expect(r.success).toBe(false)
    expect(r.error).toBe('INVALID_NAME')
  })

  it('源不存在 → ACCOUNT_NOT_FOUND', async () => {
    const r = await renameAccount('nonexistent', 'new')
    expect(r.success).toBe(false)
    expect(r.error).toBe('ACCOUNT_NOT_FOUND')
  })
})

// ---------- deleteAccount ----------

describe('deleteAccount', () => {
  it('正常删除 → 冷备份存在 + 源文件消失', async () => {
    seedAccount('carol', makeAuthObj({ accountId: 'c1' }))
    const r = await deleteAccount('carol')
    expect(r.success).toBe(true)
    expect(existsSync(accountPath('carol'))).toBe(false)
    expect(r.backupPath).toMatch(/rm-carol-/)
    expect(existsSync(r.backupPath)).toBe(true)
  })

  it('删除当前激活账户 → current 被清空', async () => {
    seedAccount('carol', makeAuthObj({ accountId: 'c1' }))
    writeFileSync(getCurrentFile(), 'carol\n')
    const r = await deleteAccount('carol')
    expect(r.success).toBe(true)
    expect(readFileSync(getCurrentFile(), 'utf-8').trim()).toBe('')
  })

  it('账户不存在 → ACCOUNT_NOT_FOUND', async () => {
    const r = await deleteAccount('none')
    expect(r.success).toBe(false)
    expect(r.error).toBe('ACCOUNT_NOT_FOUND')
  })
})

// ---------- switchAccount ----------

describe('switchAccount', () => {
  it('Codex 未运行 + 正常切换 → swap 完成，codexWasRunning=false', async () => {
    // execFileMock 默认 ps 返回空进程表（Codex 不在）
    seedAccount('alice', makeAuthObj({ accountId: 'a1' }))
    seedAccount('bob', makeAuthObj({ accountId: 'b1' }))
    writeAuth(makeAuthObj({ accountId: 'a1' }))
    writeFileSync(getCurrentFile(), 'alice\n')

    const r = await switchAccount('bob')
    expect(r.success).toBe(true)
    expect(r.codexWasRunning).toBe(false)

    const written = JSON.parse(readFileSync(getAuthFile(), 'utf-8'))
    expect(written.tokens.account_id).toBe('b1')
    expect(readFileSync(getCurrentFile(), 'utf-8').trim()).toBe('bob')
  })

  it('Codex 在运行 → 仍只 swap，不 quit / 不 restart', async () => {
    // ps 返回 Codex 进程在跑
    execFileMock.mockImplementation((cmd, args, opts, cb) => {
      if (cmd === 'ps') cb(null, ' 12345 1 /Applications/Codex.app/Contents/MacOS/Codex\n', '')
      else cb(null, 'ok', '')
    })
    seedAccount('alice', makeAuthObj({ accountId: 'a1' }))
    seedAccount('bob', makeAuthObj({ accountId: 'b1' }))
    writeAuth(makeAuthObj({ accountId: 'a1' }))

    const r = await switchAccount('bob')
    expect(r.success).toBe(true)
    expect(r.codexWasRunning).toBe(true)

    // auth.json 应该已经切成 bob
    const written = JSON.parse(readFileSync(getAuthFile(), 'utf-8'))
    expect(written.tokens.account_id).toBe('b1')

    // 关键：绝不应该调 osascript 或 open
    expect(execFileMock.mock.calls.filter((c) => c[0] === 'osascript')).toHaveLength(0)
    expect(execFileMock.mock.calls.filter((c) => c[0] === 'open')).toHaveLength(0)
  })

  it('目标账户不存在 → ACCOUNT_NOT_FOUND', async () => {
    const r = await switchAccount('ghost')
    expect(r.success).toBe(false)
    expect(r.error).toBe('ACCOUNT_NOT_FOUND')
  })

  it('同账户切换 → noop', async () => {
    const auth = makeAuthObj({ accountId: 'a1', expSecFromNow: 10 * 86400 })
    seedAccount('alice', auth)
    writeAuth(auth)
    writeFileSync(getCurrentFile(), 'alice\n')

    const r = await switchAccount('alice')
    expect(r.success).toBe(true)
    expect(r.noop).toBe(true)
    expect(execFileMock.mock.calls.filter((c) => c[0] === 'osascript')).toHaveLength(0)
    expect(execFileMock.mock.calls.filter((c) => c[0] === 'open')).toHaveLength(0)
  })

  it('切换前自动同步当前 auth.json 回原槽（保 refresh_token）', async () => {
    // 原槽 alice 的 hash = A，current auth.json 已经被 Codex 刷新过，hash = A'
    const aliceOld = makeAuthObj({ accountId: 'a1', expSecFromNow: 60 })
    const aliceNew = makeAuthObj({ accountId: 'a1', expSecFromNow: 3600 })
    seedAccount('alice', aliceOld)
    seedAccount('bob', makeAuthObj({ accountId: 'b1' }))
    writeAuth(aliceNew)
    writeFileSync(getCurrentFile(), 'alice\n')

    await switchAccount('bob')

    // alice 槽应该已被更新到 aliceNew 的内容
    const aliceStored = JSON.parse(readFileSync(accountPath('alice'), 'utf-8'))
    expect(aliceStored.tokens.id_token).toBe(aliceNew.tokens.id_token)
  })
})

// ---------- emailToDefaultName ----------

describe('emailToDefaultName', () => {
  it('普通邮箱 → 邮箱前缀', () => {
    expect(emailToDefaultName('alice@example.com')).toBe('alice')
  })
  it('大写 → 转小写', () => {
    expect(emailToDefaultName('ALICE@X.com')).toBe('alice')
  })
  it('含特殊字符 → 替换为下划线', () => {
    expect(emailToDefaultName('my+tag@x.com')).toBe('my_tag')
  })
  it('重名自增 -2', () => {
    expect(emailToDefaultName('alice@x.com', ['alice'])).toBe('alice-2')
    expect(emailToDefaultName('alice@x.com', ['alice', 'alice-2'])).toBe('alice-3')
  })
  it('空 email → fallback', () => {
    expect(emailToDefaultName('', [])).toBe('account-1')
    expect(emailToDefaultName(null, [])).toBe('account-1')
  })
})
