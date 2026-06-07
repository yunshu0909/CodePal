/**
 * OAuth refresh 响应错误分类（4+1 类）
 *
 * 负责：
 * - 把 OpenAI auth.openai.com/oauth/token 的非 200 响应分类为：
 *   Permanent.Expired / Permanent.Exhausted / Permanent.Revoked / Permanent.Other / Transient
 * - 兼容嵌套（OpenAI 真实格式 `{"error":{"code":"..."}}`）和扁平（旧版 `{"error":"..."}`）两种响应
 *
 * 依据：
 * - 设计稿 §5.1：4+1 错误分类
 * - 设计稿 §5.2：响应格式兼容（嵌套优先 + 扁平兜底）
 * - Codex CLI 源 codex-rs/login/src/auth/manager.rs:862-868
 *
 * @module electron/services/codexErrorClassifier
 */

const PERMANENT_CODE_MAP = {
  refresh_token_expired: 'Expired',
  refresh_token_reused: 'Exhausted',
  refresh_token_invalidated: 'Revoked',
}

/**
 * 从响应 body 中抽取错误 code（兼容嵌套与扁平）
 * @param {string} body
 * @returns {string | null}
 */
function extractErrorCode(body) {
  if (typeof body !== 'string' || body.length === 0) return null
  let json
  try { json = JSON.parse(body) } catch { return null }
  if (!json || typeof json !== 'object') return null
  // 嵌套优先（OpenAI 真实）
  if (json.error && typeof json.error === 'object' && typeof json.error.code === 'string') {
    return json.error.code
  }
  // 扁平兜底
  if (typeof json.error === 'string') return json.error
  return null
}

/**
 * 分类 refresh 响应
 *
 * @param {number} httpStatus - HTTP 状态码
 * @param {string} body - 响应 body 原文
 * @returns {{
 *   classification: 'Permanent' | 'Transient',
 *   reason: 'Expired' | 'Exhausted' | 'Revoked' | 'Other' | 'ServerError' | 'Network',
 *   code: string | null,
 *   http?: number
 * }}
 */
function classify(httpStatus, body) {
  // Transient：5xx 服务端错误
  if (typeof httpStatus === 'number' && httpStatus >= 500 && httpStatus < 600) {
    return { classification: 'Transient', reason: 'ServerError', code: null, http: httpStatus }
  }
  // Transient：网络层失败（http=0 / null）
  if (!httpStatus) {
    return { classification: 'Transient', reason: 'Network', code: null, http: httpStatus ?? null }
  }
  // 401/400 等：按 code 分 Permanent 四类
  const code = extractErrorCode(body)
  if (code && Object.prototype.hasOwnProperty.call(PERMANENT_CODE_MAP, code)) {
    return { classification: 'Permanent', reason: PERMANENT_CODE_MAP[code], code }
  }
  // 解析失败（非 JSON / 缺 code）也归 Permanent.Other（设计稿 §5.3：诚实重试，不再无意义重试）
  return { classification: 'Permanent', reason: 'Other', code: code ?? null }
}

function isPermanent(result) {
  return !!result && result.classification === 'Permanent'
}

function isTransient(result) {
  return !!result && result.classification === 'Transient'
}

module.exports = {
  classify,
  extractErrorCode,
  isPermanent,
  isTransient,
  PERMANENT_CODE_MAP,
}
