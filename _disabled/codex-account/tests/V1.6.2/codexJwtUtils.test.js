/**
 * V1.6.2 codexJwtUtils 增强测试
 *
 * 覆盖 V1.6.2 修复 Bug C：
 * - last_refresh 字段缺失时用 mtime 兜底
 * - mtime 也无 → 保守判死（fail-closed）
 * - 字段非法时同样判死
 * - 阈值默认从 30d 收紧到 20d
 *
 * @module 自动化测试/V1.6.2/codexJwtUtils.test
 */

import { describe, it, expect } from 'vitest'
import { isRefreshTokenLikelyDead } from '../../electron/services/codexJwtUtils'
import { makeJwt, makeAuthObj } from '../V1.5.0/helpers'

const DAY = 86400 * 1000

describe('isRefreshTokenLikelyDead V1.6.2 增强', () => {
  it('access_token 没过期 → 一律判活（不看 last_refresh）', () => {
    const auth = makeAuthObj({ expSecFromNow: 3600 })
    delete auth.last_refresh
    expect(isRefreshTokenLikelyDead(auth)).toBe(false)
  })

  it('access_token 过期 + last_refresh 缺失 + mtime 缺失 → fail-closed 判死', () => {
    const auth = makeAuthObj({ expSecFromNow: -100 })
    delete auth.last_refresh
    expect(isRefreshTokenLikelyDead(auth)).toBe(true)
  })

  it('access_token 过期 + last_refresh 缺失 + mtime 5 天前 → 判活（mtime 兜底）', () => {
    const auth = makeAuthObj({ expSecFromNow: -100 })
    delete auth.last_refresh
    const mtime5dAgo = Date.now() - 5 * DAY
    expect(isRefreshTokenLikelyDead(auth, undefined, mtime5dAgo)).toBe(false)
  })

  it('access_token 过期 + last_refresh 缺失 + mtime 25 天前 → 判死（超阈值 20d）', () => {
    const auth = makeAuthObj({ expSecFromNow: -100 })
    delete auth.last_refresh
    const mtime25dAgo = Date.now() - 25 * DAY
    expect(isRefreshTokenLikelyDead(auth, undefined, mtime25dAgo)).toBe(true)
  })

  it('last_refresh 是非法字符串 → 用 mtime 兜底', () => {
    const auth = makeAuthObj({ expSecFromNow: -100, lastRefresh: 'not-a-date' })
    const mtime3dAgo = Date.now() - 3 * DAY
    expect(isRefreshTokenLikelyDead(auth, undefined, mtime3dAgo)).toBe(false)
  })

  it('last_refresh 非法 + mtime 缺失 → fail-closed 判死', () => {
    const auth = makeAuthObj({ expSecFromNow: -100, lastRefresh: 'garbage' })
    expect(isRefreshTokenLikelyDead(auth)).toBe(true)
  })

  it('last_refresh 合法但超过阈值 → 判死（不论 mtime）', () => {
    const lastRefresh25dAgo = new Date(Date.now() - 25 * DAY).toISOString()
    const auth = makeAuthObj({ expSecFromNow: -100, lastRefresh: lastRefresh25dAgo })
    const mtimeNow = Date.now()  // mtime 是新的，但 last_refresh 字段优先
    expect(isRefreshTokenLikelyDead(auth, undefined, mtimeNow)).toBe(true)
  })

  it('阈值边界：访问刚好 19.9 天前 → 判活；20.1 天前 → 判死', () => {
    const auth199 = makeAuthObj({
      expSecFromNow: -100,
      lastRefresh: new Date(Date.now() - 19.9 * DAY).toISOString(),
    })
    expect(isRefreshTokenLikelyDead(auth199)).toBe(false)

    const auth201 = makeAuthObj({
      expSecFromNow: -100,
      lastRefresh: new Date(Date.now() - 20.1 * DAY).toISOString(),
    })
    expect(isRefreshTokenLikelyDead(auth201)).toBe(true)
  })

  it('refresh_token 缺失 → 判死', () => {
    const auth = makeAuthObj()
    delete auth.tokens.refresh_token
    expect(isRefreshTokenLikelyDead(auth)).toBe(true)
  })

  it('mtimeMs 传 0 / 负数 → 视为缺失 → 走 fail-closed', () => {
    const auth = makeAuthObj({ expSecFromNow: -100 })
    delete auth.last_refresh
    expect(isRefreshTokenLikelyDead(auth, undefined, 0)).toBe(true)
    expect(isRefreshTokenLikelyDead(auth, undefined, -1)).toBe(true)
  })
})
