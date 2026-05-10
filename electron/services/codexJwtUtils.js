/**
 * Codex JWT 工具
 *
 * 负责：
 * - 解码 Codex auth.json 里的 JWT（id_token / access_token）
 * - 提取 email（作为账户身份标识，对应 bash 脚本的 extract_email）
 * - 提取 plan（Plus / Pro / Team / Free 等，找不到返回 'unknown'）
 * - 提取 account_id（直接从 tokens.account_id 取）
 * - 判断 token 是否已过期（用于凭证失效检测）
 *
 * @module electron/services/codexJwtUtils
 */

/**
 * 解码 JWT 的 payload 部分（第二段 base64url JSON）
 *
 * 执行步骤：
 *   1. 按 `.` 切三段
 *   2. 第二段做 base64url 解码（自动补 `=`）
 *   3. JSON.parse 成对象
 *
 * @param {string} jwt - 完整 JWT 字符串
 * @returns {object} 解码后的 payload 对象
 * @throws {Error} JWT 格式非法或 payload 不是合法 JSON 时抛出 'BAD_JWT'
 */
function decodeJwtPayload(jwt) {
  if (typeof jwt !== 'string' || !jwt) {
    throw new Error('BAD_JWT')
  }
  const parts = jwt.split('.')
  if (parts.length < 2) {
    throw new Error('BAD_JWT')
  }
  const seg = parts[1]
  // 补齐 base64 padding，Node 的 base64url 也接受无 padding 但保险处理
  const padded = seg + '='.repeat((4 - (seg.length % 4)) % 4)
  try {
    const buf = Buffer.from(padded, 'base64url')
    return JSON.parse(buf.toString('utf-8'))
  } catch {
    throw new Error('BAD_JWT')
  }
}

/**
 * 从 auth.json 对象中提取 email
 *
 * 优先级：
 *   1. id_token payload.email（ChatGPT OAuth 标准 claim）
 *   2. id_token payload.name / preferred_username
 *   3. 自定义 claim（https://api.openai.com/profile 等命名空间）
 *   4. id_token payload.sub
 *   5. 全部失败 → '(no-email)'
 *
 * 对 API Key 模式（OPENAI_API_KEY 非空）返回 '(api-key)'
 *
 * @param {object} authObj - auth.json 解析后的对象
 * @returns {string} email 或占位字符串
 */
function extractEmail(authObj) {
  if (!authObj || typeof authObj !== 'object') return '(invalid)'
  if (authObj.OPENAI_API_KEY) return '(api-key)'

  const tokens = authObj.tokens || {}
  const idToken = tokens.id_token
  if (!idToken) return '(no-token)'

  let payload
  try {
    payload = decodeJwtPayload(idToken)
  } catch {
    return '(bad-jwt)'
  }

  if (payload.email) return payload.email
  if (payload.name) return payload.name
  if (payload.preferred_username) return payload.preferred_username

  // OpenAI 自定义命名空间（观测到存在）
  const profile = payload['https://api.openai.com/profile']
  if (profile && profile.email) return profile.email

  if (payload.sub) return payload.sub
  return '(no-email)'
}

/**
 * 从 auth.json 对象中提取套餐类型
 *
 * 按已知可能位置依次尝试：
 *   1. id_token payload['https://api.openai.com/auth'].chatgpt_plan_type
 *   2. id_token payload.chatgpt_plan_type
 *   3. id_token payload.plan
 *   4. access_token 同样的三个位置
 *
 * 返回值规范化为小写 枚举 或 unknown：
 *   plus / pro / team / free / enterprise / edu / business / prolite / unknown
 *
 * @param {object} authObj - auth.json 解析后的对象
 * @returns {string} 小写套餐字符串，找不到返回 'unknown'
 */
function extractPlan(authObj) {
  if (!authObj || typeof authObj !== 'object') return 'unknown'
  const tokens = authObj.tokens || {}

  const candidates = [tokens.id_token, tokens.access_token].filter(Boolean)
  for (const jwt of candidates) {
    let payload
    try {
      payload = decodeJwtPayload(jwt)
    } catch {
      continue
    }
    const fromAuthClaim = payload['https://api.openai.com/auth']
    if (fromAuthClaim && fromAuthClaim.chatgpt_plan_type) {
      return String(fromAuthClaim.chatgpt_plan_type).toLowerCase()
    }
    if (payload.chatgpt_plan_type) return String(payload.chatgpt_plan_type).toLowerCase()
    if (payload.plan) return String(payload.plan).toLowerCase()
  }
  return 'unknown'
}

/**
 * 从 auth.json 对象中提取 account_id（直接读 tokens.account_id）
 * @param {object} authObj
 * @returns {string} account_id（找不到返回空字符串）
 */
function extractAccountId(authObj) {
  if (!authObj || typeof authObj !== 'object') return ''
  const tokens = authObj.tokens || {}
  return tokens.account_id || ''
}

/**
 * 检查 JWT 是否已过期
 *
 * @param {string} jwt
 * @param {number} [toleranceSec=0] - 容忍度（秒），早于 exp - tolerance 秒视为"即将过期"
 * @returns {boolean} true 表示已过期或格式错误，false 表示仍有效
 */
function isTokenExpired(jwt, toleranceSec = 0) {
  let payload
  try {
    payload = decodeJwtPayload(jwt)
  } catch {
    return true
  }
  if (typeof payload.exp !== 'number') return false
  const nowSec = Math.floor(Date.now() / 1000)
  return nowSec >= payload.exp - toleranceSec
}

/**
 * 判断某个 account 槽位是否已彻底失效
 *
 * 规则：access_token 过期 且 上次刷新距今超过 N 天 → 推断 refresh_token 也失效
 * （refresh_token 本身没有 exp 字段，OpenAI 实测 TTL 7-30 天浮动，V1.6.2 收紧到 20 天）
 *
 * **fail-closed 设计**（V1.6.2 修复 Bug C）：
 * - last_refresh 字段缺失 → 用文件 mtime 兜底
 * - mtime 也无 → 保守判死（宁可误报也不撒谎）
 * - 字段解析失败 → 同上
 *
 * @param {object} authObj - auth.json 解析后的对象
 * @param {number} [refreshTtlDays=20] - V1.6.2 从 30d 收紧到 20d
 * @param {number|null} [mtimeMs=null] - 文件 mtime（毫秒），last_refresh 缺失时兜底
 * @returns {boolean}
 */
function isRefreshTokenLikelyDead(authObj, refreshTtlDays = 20, mtimeMs = null) {
  if (!authObj || typeof authObj !== 'object') return true
  const tokens = authObj.tokens || {}
  if (!tokens.refresh_token) return true
  const accessExpired = tokens.access_token ? isTokenExpired(tokens.access_token) : true
  if (!accessExpired) return false

  // last_refresh 字段优先；缺失或非法时用 mtime 兜底
  let lastRefresh = null
  const lastRefreshRaw = authObj.last_refresh
  if (lastRefreshRaw) {
    const parsed = Date.parse(lastRefreshRaw)
    if (!Number.isNaN(parsed)) lastRefresh = parsed
  }
  if (lastRefresh === null && typeof mtimeMs === 'number' && mtimeMs > 0) {
    lastRefresh = mtimeMs
  }
  // 既无 last_refresh 也无 mtime → 保守判死（fail-closed）
  if (lastRefresh === null) return true

  const ageDays = (Date.now() - lastRefresh) / (86400 * 1000)
  return ageDays > refreshTtlDays
}

module.exports = {
  decodeJwtPayload,
  extractEmail,
  extractPlan,
  extractAccountId,
  isTokenExpired,
  isRefreshTokenLikelyDead,
}
