/**
 * codexAuthWatcher 单元测试
 *
 * 测试核心纯函数 handleAuthChange，绕开 chokidar（chokidar 本身是成熟库）。
 * 这样测试快、稳，不依赖文件系统事件延迟。
 *
 * 覆盖：
 *   1. 新账户（account_id 未归属任何槽位）→ 触发 onNewAccountDetected
 *   2. 已归属账户的 auth.json 变化 → 自动同步回槽位、不触发回调
 *   3. 损坏 JSON → handled=false
 *   4. 同 account_id 反复触发 → 跳过
 *
 * @module 自动化测试/V1.5.0/codexAuthWatcher.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeAuthObj } from './helpers.js'

const watcher = await import('../../electron/services/codexAuthWatcher.js').then(
  (m) => m.default || m
)
const { handleAuthChange } = watcher
// 使用 watcher 闭包里真正 require 的 accountService 实例（避免 ESM/CJS cache 分离）
const accountService = watcher.__INTERNAL__.getLinkedAccountService()
const { __setHomeDir, __resetHomeDir, getAuthFile, accountPath } = accountService.__INTERNAL__

let tmpHome

function writeAuthRaw(obj) {
  const dir = join(tmpHome, '.codex')
  mkdirSync(dir, { recursive: true })
  writeFileSync(getAuthFile(), typeof obj === 'string' ? obj : JSON.stringify(obj))
}

function seedAccount(name, obj) {
  mkdirSync(join(tmpHome, '.codex-switcher/accounts'), { recursive: true })
  writeFileSync(accountPath(name), JSON.stringify(obj))
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'codex-watcher-test-'))
  __setHomeDir(tmpHome)
})

afterEach(() => {
  __resetHomeDir()
  if (tmpHome && existsSync(tmpHome)) {
    rmSync(tmpHome, { recursive: true, force: true })
  }
})

describe('handleAuthChange', () => {
  it('auth.json 不存在 → handled=false', async () => {
    const state = { lastProcessedId: '' }
    const onNew = vi.fn()
    const r = await handleAuthChange(state, { onNewAccountDetected: onNew })
    expect(r.handled).toBe(false)
    expect(r.reason).toBe('no-auth-file')
    expect(onNew).not.toHaveBeenCalled()
  })

  it('新账户（account_id 未归属）→ 触发回调', async () => {
    seedAccount('alice', makeAuthObj({ accountId: 'a1' }))
    writeAuthRaw(makeAuthObj({ accountId: 'd1', email: 'diana@x.com', plan: 'plus' }))

    const state = { lastProcessedId: '' }
    const onNew = vi.fn()
    const r = await handleAuthChange(state, { onNewAccountDetected: onNew })

    expect(r.handled).toBe(true)
    expect(r.reason).toBe('new-account')
    expect(onNew).toHaveBeenCalledTimes(1)
    const payload = onNew.mock.calls[0][0]
    expect(payload.accountId).toBe('d1')
    expect(payload.email).toBe('diana@x.com')
    expect(payload.plan).toBe('plus')
    expect(payload.suggestedName).toBe('diana')
  })

  it('默认命名冲突 → 自增 -2', async () => {
    seedAccount('diana', makeAuthObj({ accountId: 'old' }))
    writeAuthRaw(makeAuthObj({ accountId: 'd1', email: 'diana@x.com' }))

    const state = { lastProcessedId: '' }
    const onNew = vi.fn()
    await handleAuthChange(state, { onNewAccountDetected: onNew })

    const payload = onNew.mock.calls[0][0]
    expect(payload.suggestedName).toBe('diana-2')
  })

  it('已归属账户的 auth.json 变化 → 自动同步回槽位，不触发新账户回调', async () => {
    const aliceV1 = makeAuthObj({ accountId: 'a1', email: 'alice@x.com', expSecFromNow: 60 })
    const aliceV2 = makeAuthObj({ accountId: 'a1', email: 'alice@x.com', expSecFromNow: 3600 })
    seedAccount('alice', aliceV1)
    writeAuthRaw(aliceV2)

    const state = { lastProcessedId: '' }
    const onNew = vi.fn()
    const r = await handleAuthChange(state, { onNewAccountDetected: onNew })

    expect(r.handled).toBe(true)
    expect(r.reason).toBe('synced-slot')
    expect(onNew).not.toHaveBeenCalled()

    const aliceStored = JSON.parse(readFileSync(accountPath('alice'), 'utf-8'))
    expect(aliceStored.tokens.id_token).toBe(aliceV2.tokens.id_token)
  })

  it('损坏 JSON → 解析失败，handled=false，不崩', async () => {
    writeAuthRaw('{not-json')
    const state = { lastProcessedId: '' }
    const onNew = vi.fn()
    const r = await handleAuthChange(state, { onNewAccountDetected: onNew })
    expect(r.handled).toBe(false)
    expect(r.reason).toBe('parse-failed')
    expect(onNew).not.toHaveBeenCalled()
  })

  it('同 account_id 反复触发 → 跳过（lastProcessedId 已记录）', async () => {
    writeAuthRaw(makeAuthObj({ accountId: 'd1', email: 'diana@x.com' }))
    const state = { lastProcessedId: '' }
    const onNew = vi.fn()

    await handleAuthChange(state, { onNewAccountDetected: onNew })
    expect(onNew).toHaveBeenCalledTimes(1)

    const r2 = await handleAuthChange(state, { onNewAccountDetected: onNew })
    expect(r2.handled).toBe(false)
    expect(r2.reason).toBe('same-id')
    expect(onNew).toHaveBeenCalledTimes(1)
  })

  it('不同 account_id 依次到达 → 都触发', async () => {
    const state = { lastProcessedId: '' }
    const onNew = vi.fn()

    writeAuthRaw(makeAuthObj({ accountId: 'd1', email: 'diana@x.com' }))
    await handleAuthChange(state, { onNewAccountDetected: onNew })

    writeAuthRaw(makeAuthObj({ accountId: 'd2', email: 'evan@x.com' }))
    await handleAuthChange(state, { onNewAccountDetected: onNew })

    expect(onNew).toHaveBeenCalledTimes(2)
    expect(onNew.mock.calls[0][0].accountId).toBe('d1')
    expect(onNew.mock.calls[1][0].accountId).toBe('d2')
  })
})
