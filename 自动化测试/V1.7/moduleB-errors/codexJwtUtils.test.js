/**
 * 模块 B · JWT 工具 单元测试
 *
 * 覆盖：
 * - TC-020 decodeJwtPayload 提取 iat 字段值精确匹配
 *
 * @module 自动化测试/V1.7/moduleB-errors/codexJwtUtils.test
 */

const { decodeJwtPayload } = require('../../../electron/services/codexJwtUtils')

describe('模块 B · codexJwtUtils', () => {
  // TC-020
  test('TC-020 decodeJwtPayload 提取 iat=1716550800', () => {
    // 手工构造：header={"alg":"HS256"}、payload={"iat":1716550800,"sub":"u-1"}
    const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url')
    const payload = Buffer.from(JSON.stringify({ iat: 1716550800, sub: 'u-1' })).toString('base64url')
    const jwt = `${header}.${payload}.sig`

    const decoded = decodeJwtPayload(jwt)
    expect(decoded).toEqual({ iat: 1716550800, sub: 'u-1' })
  })

  test('decodeJwtPayload 对非法 JWT 抛 BAD_JWT', () => {
    expect(() => decodeJwtPayload('not-a-jwt')).toThrow('BAD_JWT')
    expect(() => decodeJwtPayload('')).toThrow('BAD_JWT')
    expect(() => decodeJwtPayload(null)).toThrow('BAD_JWT')
  })

  test('decodeJwtPayload 兼容无 padding 的 base64url', () => {
    // base64url 可能缺尾部 = padding，decoder 应自动补齐
    const payload = { iat: 100, foo: 'bar' }
    const seg = Buffer.from(JSON.stringify(payload)).toString('base64url').replace(/=+$/, '')
    const jwt = `eyJhbGciOiJIUzI1NiJ9.${seg}.sig`
    expect(decodeJwtPayload(jwt)).toEqual(payload)
  })
})
