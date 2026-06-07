/**
 * 模块 B · OAuth 错误分类 单元测试
 *
 * 覆盖：
 * - TC-014 嵌套 refresh_token_expired → Expired
 * - TC-015 嵌套 refresh_token_reused → Exhausted
 * - TC-016 嵌套 refresh_token_invalidated → Revoked
 * - TC-017 未知 code → Other
 * - TC-018 扁平 error 字段兼容 → Other (Permanent)
 * - TC-019 5xx → Transient
 * - 边界：非 JSON body、网络层失败、空 body
 *
 * @module 自动化测试/V1.7/moduleB-errors/codexErrorClassifier.test
 */

const { classify } = require('../../../electron/services/codexErrorClassifier')

describe('模块 B · codexErrorClassifier.classify', () => {
  // TC-014
  test('TC-014 嵌套 refresh_token_expired → Expired', () => {
    const body = '{"error":{"code":"refresh_token_expired","message":"..."}}'
    expect(classify(401, body)).toEqual({
      classification: 'Permanent',
      reason: 'Expired',
      code: 'refresh_token_expired',
    })
  })

  // TC-015
  test('TC-015 嵌套 refresh_token_reused → Exhausted', () => {
    const body = '{"error":{"code":"refresh_token_reused","message":"Your refresh token has already been used..."}}'
    expect(classify(401, body)).toEqual({
      classification: 'Permanent',
      reason: 'Exhausted',
      code: 'refresh_token_reused',
    })
  })

  // TC-016
  test('TC-016 嵌套 refresh_token_invalidated → Revoked', () => {
    const body = '{"error":{"code":"refresh_token_invalidated"}}'
    expect(classify(401, body)).toEqual({
      classification: 'Permanent',
      reason: 'Revoked',
      code: 'refresh_token_invalidated',
    })
  })

  // TC-017
  test('TC-017 未知 code → Other', () => {
    const body = '{"error":{"code":"future_unknown_code_xyz"}}'
    expect(classify(401, body)).toEqual({
      classification: 'Permanent',
      reason: 'Other',
      code: 'future_unknown_code_xyz',
    })
  })

  // TC-018
  test('TC-018 扁平 error 字段兼容', () => {
    const body = '{"error":"invalid_grant","error_description":"..."}'
    const result = classify(401, body)
    expect(result.classification).toBe('Permanent')
    expect(result.code).toBe('invalid_grant')
    expect(result.reason).toBe('Other')
  })

  // TC-019
  test('TC-019 503 → Transient.ServerError', () => {
    expect(classify(503, '{}')).toEqual({
      classification: 'Transient',
      reason: 'ServerError',
      code: null,
      http: 503,
    })
  })

  test('TC-019 502 + HTML body 仍归 Transient（不抛错）', () => {
    const result = classify(502, '<html>Bad Gateway</html>')
    expect(result.classification).toBe('Transient')
    expect(result.http).toBe(502)
  })

  test('http=0（网络层失败）→ Transient.Network', () => {
    expect(classify(0, '')).toMatchObject({
      classification: 'Transient',
      reason: 'Network',
    })
  })

  test('TC-049（前置）非 JSON 401 body → Permanent.Other', () => {
    const result = classify(401, '<html>Forbidden</html>')
    expect(result.classification).toBe('Permanent')
    expect(result.reason).toBe('Other')
    expect(result.code).toBeNull()
  })

  test('空 body 401 → Permanent.Other', () => {
    const result = classify(401, '')
    expect(result.classification).toBe('Permanent')
    expect(result.reason).toBe('Other')
  })

  test('400 含 refresh_token_expired 仍归 Expired（不限于 401）', () => {
    const body = '{"error":{"code":"refresh_token_expired"}}'
    expect(classify(400, body).reason).toBe('Expired')
  })
})
