/**
 * 第三方模型接入 · 调用结果判定
 *
 * 负责：
 * - 把一次后台调用（退出码、标准输出、标准错误、是否超时）判成 可用 / 不可用 + 原因
 * - 原因五种：key（Key 无效）、balance（余额不足）、model（没有这个模型）、net（连不上 / 超时）、other
 * - Claude Code 会把上游错误包在「成功」JSON 里（result 以 API Error: 开头），要看内容判
 * - dev-workflow 用 --json-schema 时结果在 structured_output，result 可能为空，照样算成功
 * - 其他错误的消息截到 60 字并去掉疑似 Key 的片段
 *
 * @module electron/modules/models/classify
 */

const MESSAGE_MAX = 60

/** 去掉疑似密钥的片段，再截断 */
function sanitize(text) {
  const firstLine = String(text || '').split('\n').find((l) => l.trim()) || ''
  const cleaned = firstLine
    .replace(/sk-[A-Za-z0-9_-]*/g, '***')
    .replace(/[A-Za-z0-9_-]{16,}/g, '***')
    .trim()
  return cleaned.length > MESSAGE_MAX ? cleaned.slice(0, MESSAGE_MAX - 1) + '…' : cleaned
}

/** 解析标准输出里的结果 JSON：先整体，再逐行从后往前找 */
function parseResult(stdout) {
  const text = String(stdout || '').trim()
  if (!text) return null
  try { return JSON.parse(text) } catch {}
  const lines = text.split('\n').reverse()
  for (const l of lines) {
    try {
      const obj = JSON.parse(l)
      if (obj && obj.type === 'result') return obj
    } catch {}
  }
  return null
}

/** 按「API Error: <状态码> …」文本判原因 */
function classifyApiError(text, providerId) {
  const status = Number((String(text).match(/API Error:\s*(\d{3})/) || [])[1])
  if (providerId === 'minimax-api' || providerId === 'minimax-plan') {
    if (status === 401 || /authentication|invalid api key|unauthorized/i.test(text)) return { ok: false, reason: 'key', message: null }
    // 套餐额度、权限和限速不能提示充值，更不能触发跨渠道重试。
    if (status === 403 || status === 429 || /quota|subscription|rate.?limit|permission|额度|权限|限流/i.test(text)) {
      return { ok: false, reason: 'other', message: sanitize(text) }
    }
    if (/insufficient balance|余额不足/i.test(text)) return { ok: false, reason: 'balance', message: null }
    if ([400, 404, 422].includes(status) && /model/i.test(text)) return { ok: false, reason: 'model', message: null }
    return { ok: false, reason: 'other', message: sanitize(text) }
  }
  if (status === 401 || status === 403 || /authentication|invalid api key|unauthorized/i.test(text)) return { ok: false, reason: 'key', message: null }
  if (status === 402 || /insufficient balance|余额不足/i.test(text)) return { ok: false, reason: 'balance', message: null }
  if ([400, 404, 422].includes(status) && /model/i.test(text)) return { ok: false, reason: 'model', message: null }
  return { ok: false, reason: 'other', message: sanitize(text) }
}

const NET_RE = /connection error|ECONNREFUSED|ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|network|socket hang up/i

/**
 * 判定一次调用
 * @param {{exitCode: number|null, stdout: string, stderr: string, timedOut: boolean}} r
 * @returns {{ok: boolean, reason: string|null, message: string|null}}
 */
function classifyResult({ exitCode, stdout, stderr, timedOut }, providerId) {
  if (timedOut) return { ok: false, reason: 'net', message: null }
  const res = parseResult(stdout)
  if (res && res.type === 'result') {
    const text = typeof res.result === 'string' ? res.result : ''
    if (text.startsWith('API Error:')) return classifyApiError(text, providerId)
    const hasOutput = text.trim().length > 0 || (res.structured_output !== undefined && res.structured_output !== null)
    if (exitCode === 0 && res.subtype === 'success' && res.is_error !== true && hasOutput) return { ok: true, reason: null, message: null }
    const why = text || res.subtype || stderr
    if (NET_RE.test(why)) return { ok: false, reason: 'net', message: null }
    return /API Error:/.test(why) ? classifyApiError(why, providerId) : { ok: false, reason: 'other', message: sanitize(why) }
  }
  if (NET_RE.test(String(stderr))) return { ok: false, reason: 'net', message: null }
  if (/API Error:/.test(String(stderr))) return classifyApiError(stderr, providerId)
  return { ok: false, reason: 'other', message: sanitize(stderr) || (exitCode === 0 ? '没有拿到结果' : `退出码 ${exitCode}`) }
}

module.exports = { classifyResult, sanitize }
