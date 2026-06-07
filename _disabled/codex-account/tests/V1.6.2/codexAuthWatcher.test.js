/**
 * V1.6.2 codexAuthWatcher 增强测试
 *
 * 覆盖 V1.6.2 修复 B1：
 * - watcher 在 atomicCopy 之前检查 refresher 的 inflight Map
 * - 同 accountId 正在 refresh 时跳过同步，避免覆盖刚写入的新 token
 *
 * @module 自动化测试/V1.6.2/codexAuthWatcher.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import authWatcher from '../../electron/services/codexAuthWatcher'
import { makeAuthObj } from '../V1.5.0/helpers'

// 拿 watcher 内部 require 的同一份实例（避免 ESM/CJS 缓存分离）
const linkedAccountService = authWatcher.__INTERNAL__.getLinkedAccountService()
const linkedRefresher = authWatcher.__INTERNAL__.getLinkedRefresher()

let tmpHome

beforeEach(async () => {
  tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-watcher-v162-'))
  linkedAccountService.__INTERNAL__.__setHomeDir(tmpHome)
  await fsp.mkdir(path.join(tmpHome, '.codex-switcher', 'accounts'), { recursive: true })
  await fsp.mkdir(path.join(tmpHome, '.codex'), { recursive: true })
  linkedRefresher.__INTERNAL__.inflight.clear()
})

afterEach(async () => {
  linkedRefresher.__INTERNAL__.inflight.clear()
  linkedAccountService.__INTERNAL__.__resetHomeDir()
  await fsp.rm(tmpHome, { recursive: true, force: true })
})

describe('B1 watcher 检查 inflight Map', () => {
  it('refresher 正在写同 accountId → watcher 跳过同步', async () => {
    const accountId = 'inflight-test-id'
    const auth = makeAuthObj({ accountId })

    // 写当前 auth.json + slot 文件
    await fsp.writeFile(path.join(tmpHome, '.codex', 'auth.json'), JSON.stringify(auth, null, 2))
    const slotPath = path.join(tmpHome, '.codex-switcher', 'accounts', 'alice.json')
    await fsp.writeFile(slotPath, JSON.stringify(auth, null, 2))

    // 模拟 refresher 正在工作（占住 inflight key）
    const fakeTask = new Promise(() => {})  // never resolves
    linkedRefresher.__INTERNAL__.inflight.set(`${accountId}:force`, fakeTask)

    // watcher 处理 change 事件
    const state = { lastProcessedId: '' }
    const result = await authWatcher.handleAuthChange(state, {})

    expect(result.handled).toBe(false)
    expect(result.reason).toBe('refresh-in-flight')
  })

  it('refresher 没在工作 → watcher 正常同步', async () => {
    const accountId = 'normal-test-id'
    const auth = makeAuthObj({ accountId })

    await fsp.writeFile(path.join(tmpHome, '.codex', 'auth.json'), JSON.stringify(auth, null, 2))
    const slotPath = path.join(tmpHome, '.codex-switcher', 'accounts', 'bob.json')
    await fsp.writeFile(slotPath, JSON.stringify({
      ...auth,
      tokens: { ...auth.tokens, access_token: 'old-token' },  // slot 是旧 token
    }, null, 2))

    const state = { lastProcessedId: '' }
    const result = await authWatcher.handleAuthChange(state, {})

    expect(result.handled).toBe(true)
    expect(result.reason).toBe('synced-slot')

    // 验证：slot 被 atomicCopy 更新（access_token 现在应该匹配 auth.json 的）
    const slotAfter = JSON.parse(await fsp.readFile(slotPath, 'utf-8'))
    expect(slotAfter.tokens.access_token).toBe(auth.tokens.access_token)
  })
})
