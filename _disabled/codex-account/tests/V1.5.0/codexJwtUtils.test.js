/**
 * codexJwtUtils 单元测试
 *
 * 覆盖：
 * - decodeJwtPayload：合法 / 损坏 / 短段
 * - extractEmail：标准 email / name / api-key / 无 token
 * - extractPlan：各种 plan 位置 + unknown 兜底
 * - extractAccountId：正常 / 缺失
 * - isTokenExpired：exp 过去 / 未来 / 容忍度
 * - isRefreshTokenLikelyDead：access 未过期 / access 过期但 last_refresh 新 / 均过期
 *
 * @module 自动化测试/V1.5.0/codexJwtUtils.test
 */

import { describe, it, expect } from 'vitest'
import {
  decodeJwtPayload,
  extractEmail,
  extractPlan,
  extractAccountId,
  isTokenExpired,
  isRefreshTokenLikelyDead,
} from '../../electron/services/codexJwtUtils.js'
import { makeJwt, makeAuthObj } from './helpers.js'

describe('decodeJwtPayload', () => {
  it('合法 JWT 能解出 payload', () => {
    const jwt = makeJwt({ email: 'bob@x.com', sub: 'u-1' })
    const p = decodeJwtPayload(jwt)
    expect(p.email).toBe('bob@x.com')
    expect(p.sub).toBe('u-1')
  })
  it('JWT 只有一段 → 抛 BAD_JWT', () => {
    expect(() => decodeJwtPayload('onlyoneseg')).toThrow('BAD_JWT')
  })
  it('空 / 非字符串 → 抛 BAD_JWT', () => {
    expect(() => decodeJwtPayload('')).toThrow('BAD_JWT')
    expect(() => decodeJwtPayload(null)).toThrow('BAD_JWT')
  })
  it('payload 段不是合法 base64/JSON → 抛 BAD_JWT', () => {
    expect(() => decodeJwtPayload('a.notb64json@@@.c')).toThrow('BAD_JWT')
  })
})

describe('extractEmail', () => {
  it('正常 ChatGPT OAuth 账户 → 取 id_token.email', () => {
    const auth = makeAuthObj({ email: 'alice@example.com' })
    expect(extractEmail(auth)).toBe('alice@example.com')
  })
  it('OPENAI_API_KEY 模式 → (api-key)', () => {
    const auth = makeAuthObj({ apiKey: 'sk-xxx' })
    expect(extractEmail(auth)).toBe('(api-key)')
  })
  it('空对象 → (invalid)', () => {
    expect(extractEmail(null)).toBe('(invalid)')
    expect(extractEmail(undefined)).toBe('(invalid)')
  })
  it('没有 tokens.id_token → (no-token)', () => {
    expect(extractEmail({ auth_mode: 'chatgpt', tokens: {} })).toBe('(no-token)')
  })
  it('id_token 损坏 → (bad-jwt)', () => {
    expect(
      extractEmail({ tokens: { id_token: 'not.a.jwt@@' } })
    ).toBe('(bad-jwt)')
  })
  it('payload 只有 sub → 返回 sub', () => {
    const auth = {
      tokens: { id_token: makeJwt({ sub: 'user-xyz' }) },
    }
    expect(extractEmail(auth)).toBe('user-xyz')
  })
  it('payload 在命名空间下带 email → 取出来', () => {
    const auth = {
      tokens: {
        id_token: makeJwt({ 'https://api.openai.com/profile': { email: 'x@y.com' } }),
      },
    }
    expect(extractEmail(auth)).toBe('x@y.com')
  })
})

describe('extractPlan', () => {
  it('access_token 里的 chatgpt_plan_type → 小写返回', () => {
    const auth = makeAuthObj({ plan: 'PLUS' })
    expect(extractPlan(auth)).toBe('plus')
  })
  it('未知 plan 值 → 原样返回', () => {
    const auth = makeAuthObj({ plan: 'prolite' })
    expect(extractPlan(auth)).toBe('prolite')
  })
  it('都找不到 → unknown', () => {
    expect(extractPlan({ tokens: {} })).toBe('unknown')
    expect(extractPlan({})).toBe('unknown')
  })
  it('id_token 里直接有 plan 字段 → 优先取到', () => {
    const auth = {
      tokens: { id_token: makeJwt({ plan: 'Pro' }), access_token: '' },
    }
    expect(extractPlan(auth)).toBe('pro')
  })
})

describe('extractAccountId', () => {
  it('正常 → 取 tokens.account_id', () => {
    const auth = makeAuthObj({ accountId: 'abc-123' })
    expect(extractAccountId(auth)).toBe('abc-123')
  })
  it('缺失 → 空字符串', () => {
    expect(extractAccountId({ tokens: {} })).toBe('')
    expect(extractAccountId(null)).toBe('')
  })
})

describe('isTokenExpired', () => {
  it('未来 exp → false', () => {
    const jwt = makeJwt({}, Math.floor(Date.now() / 1000) + 3600)
    expect(isTokenExpired(jwt)).toBe(false)
  })
  it('过去 exp → true', () => {
    const jwt = makeJwt({}, Math.floor(Date.now() / 1000) - 60)
    expect(isTokenExpired(jwt)).toBe(true)
  })
  it('无 exp 字段 → false（保守，不强判过期）', () => {
    const jwt = makeJwt({ email: 'x@y.com' })
    expect(isTokenExpired(jwt)).toBe(false)
  })
  it('toleranceSec 生效：还差 30s 到期 + tolerance 60s → 算过期', () => {
    const jwt = makeJwt({}, Math.floor(Date.now() / 1000) + 30)
    expect(isTokenExpired(jwt, 60)).toBe(true)
  })
  it('bad JWT → 视为过期 true', () => {
    expect(isTokenExpired('bad.jwt@@.sig')).toBe(true)
  })
})

describe('isRefreshTokenLikelyDead', () => {
  it('access_token 未过期 → false', () => {
    const auth = makeAuthObj({ expSecFromNow: 3600 })
    expect(isRefreshTokenLikelyDead(auth)).toBe(false)
  })
  it('access_token 过期但 last_refresh 是 5 天前 → false', () => {
    const auth = makeAuthObj({
      expSecFromNow: -60,
      lastRefresh: new Date(Date.now() - 5 * 86400_000).toISOString(),
    })
    expect(isRefreshTokenLikelyDead(auth)).toBe(false)
  })
  it('access_token 过期 + last_refresh 是 40 天前 → true', () => {
    const auth = makeAuthObj({
      expSecFromNow: -60,
      lastRefresh: new Date(Date.now() - 40 * 86400_000).toISOString(),
    })
    expect(isRefreshTokenLikelyDead(auth)).toBe(true)
  })
  it('缺 refresh_token → true', () => {
    const auth = makeAuthObj()
    delete auth.tokens.refresh_token
    expect(isRefreshTokenLikelyDead(auth)).toBe(true)
  })
  it('null / 非法 → true', () => {
    expect(isRefreshTokenLikelyDead(null)).toBe(true)
    expect(isRefreshTokenLikelyDead({})).toBe(true)
  })
})
