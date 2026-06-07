/**
 * V1.5.0 测试 helpers
 *
 * 负责：
 * - 生成测试用 JWT（合法 base64url，不校验签名）
 * - 生成 auth.json 结构化假数据
 *
 * @module 自动化测试/V1.5.0/helpers
 */

/**
 * 生成一个测试 JWT
 *
 * @param {object} payload - JWT payload（exp 会覆盖式写入）
 * @param {number} [exp] - UNIX 秒，未指定则不带 exp
 * @returns {string} 形如 `header.payload.signature` 的 JWT
 */
export function makeJwt(payload = {}, exp = undefined) {
  const header = { typ: 'JWT', alg: 'HS256' }
  const body = { ...payload }
  if (exp != null) body.exp = exp
  const h = Buffer.from(JSON.stringify(header)).toString('base64url')
  const b = Buffer.from(JSON.stringify(body)).toString('base64url')
  return `${h}.${b}.sig`
}

/**
 * 生成一份 auth.json 的对象（和真实 Codex auth.json 结构一致）
 *
 * @param {object} [opts]
 * @param {string} [opts.accountId='12345678-1234-1234-1234-123456789abc']
 * @param {string} [opts.email='alice@example.com']
 * @param {string} [opts.plan='plus']
 * @param {number} [opts.expSecFromNow=3600]
 * @param {string|null} [opts.lastRefresh=now]
 * @param {string|null} [opts.apiKey=null]
 * @returns {object}
 */
export function makeAuthObj(opts = {}) {
  const {
    accountId = '12345678-1234-1234-1234-123456789abc',
    email = 'alice@example.com',
    plan = 'plus',
    expSecFromNow = 3600,
    lastRefresh = new Date().toISOString(),
    apiKey = null,
  } = opts

  const now = Math.floor(Date.now() / 1000)
  const exp = now + expSecFromNow

  return {
    OPENAI_API_KEY: apiKey,
    auth_mode: apiKey ? 'api-key' : 'chatgpt',
    tokens: {
      id_token: makeJwt({ email }, exp),
      access_token: makeJwt(
        {
          scp: 'openid email profile',
          'https://api.openai.com/auth': { chatgpt_plan_type: plan },
        },
        exp
      ),
      refresh_token: `refresh_${accountId}`,
      account_id: accountId,
    },
    last_refresh: lastRefresh,
  }
}
