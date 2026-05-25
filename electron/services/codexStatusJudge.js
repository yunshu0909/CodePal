/**
 * 账户三档健康状态判定（V1.7）
 *
 * 负责：
 * - 综合 state.json 状态机 + access_token JWT iat 距今时间，输出三档：
 *   - 绿（近期验证 / fresh-verified）：state=active 且 iat 距今 ≤ 6h
 *   - 黄（未近期验证 / stale or 网络异常）：state=active 且 iat > 6h，**或** state=paused
 *   - 红（已确认失效 / invalid）：state=invalid（带 permanentReason） **或** auth.json 损坏
 *
 * 依据：
 * - 设计稿 §7 状态判定
 * - PRD US-07 三档语义
 *
 * 命名规则（设计稿 §7.2 重要语义澄清）：
 * - 不叫"可用/不可用"，叫"近期验证 / 未近期验证 / 已确认失效"
 *
 * @module electron/services/codexStatusJudge
 */

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')

const accountService = require('./codexAccountService')
const { decodeJwtPayload } = require('./codexJwtUtils')

const FRESH_WINDOW_SECONDS = 6 * 3600
const LEGACY_FALLBACK_WINDOW_MS = 6 * 3600 * 1000

const PERMANENT_REASON_LABEL = {
  Expired: '已过期',
  Exhausted: '已被多端复用',
  Revoked: '已撤销',
  Other: '已失效',
}

/**
 * @param {string} accountName
 * @param {{ now?: number, freshWindowSeconds?: number }} [opts]
 * @returns {Promise<{
 *   color: 'green' | 'yellow' | 'red',
 *   label: string,
 *   reason?: string,
 *   iatAgeSeconds?: number,
 *   source: 'iat' | 'last_refresh' | 'state' | 'missing'
 * }>}
 */
async function judge(accountName, opts = {}) {
  const I = accountService.__INTERNAL__
  const home = I.getAccountHomeDir(accountName)
  const authPath = path.join(home, 'auth.json')
  const statePath = path.join(home, 'state.json')

  // 1. auth.json 缺失 → 红（凭证缺失）
  let authRaw
  try { authRaw = await fsp.readFile(authPath, 'utf8') } catch {
    return { color: 'red', label: '凭证缺失', reason: 'AuthMissing', source: 'missing' }
  }

  let authObj
  try { authObj = JSON.parse(authRaw) } catch {
    return { color: 'red', label: '凭证损坏', reason: 'AuthCorrupt', source: 'missing' }
  }

  // 2. 读 state.json（不存在按 active 处理，向后兼容刚迁移过来的账号）
  let state = { status: 'active' }
  if (fs.existsSync(statePath)) {
    try {
      const parsed = JSON.parse(await fsp.readFile(statePath, 'utf8'))
      if (parsed && typeof parsed === 'object') state = parsed
    } catch { /* 损坏 → 默认 active */ }
  }

  // 3. invalid → 红
  if (state.status === 'invalid') {
    const reasonKey = state.permanentReason || 'Other'
    return {
      color: 'red',
      label: PERMANENT_REASON_LABEL[reasonKey] || PERMANENT_REASON_LABEL.Other,
      reason: reasonKey,
      source: 'state',
    }
  }

  // 4. paused → 黄（网络异常）
  if (state.status === 'paused') {
    return { color: 'yellow', label: '网络异常', reason: 'Paused', source: 'state' }
  }

  // 5. active → 看 iat 距今
  const accessToken = authObj?.tokens?.access_token
  const freshWindowSeconds = opts.freshWindowSeconds ?? FRESH_WINDOW_SECONDS
  const nowSec = Math.floor((opts.now ?? Date.now()) / 1000)

  if (typeof accessToken === 'string' && accessToken.length > 0) {
    try {
      const payload = decodeJwtPayload(accessToken)
      if (typeof payload.iat === 'number') {
        const iatAgeSeconds = nowSec - payload.iat
        if (iatAgeSeconds <= freshWindowSeconds) {
          return { color: 'green', label: '近期验证', iatAgeSeconds, source: 'iat' }
        }
        return { color: 'yellow', label: '未近期验证', iatAgeSeconds, source: 'iat' }
      }
    } catch { /* fall through */ }
  }

  // 6. JWT 解码失败 / iat 缺失 → 看 last_refresh 兜底
  const lastRefreshRaw = authObj.last_refresh
  if (typeof lastRefreshRaw === 'string') {
    const parsed = Date.parse(lastRefreshRaw)
    if (!Number.isNaN(parsed)) {
      const ageMs = (opts.now ?? Date.now()) - parsed
      if (ageMs <= LEGACY_FALLBACK_WINDOW_MS) {
        return { color: 'green', label: '近期验证', source: 'last_refresh' }
      }
      return { color: 'yellow', label: '未近期验证', source: 'last_refresh' }
    }
  }

  // 7. 全部依据缺失 → 红（无法证明任何验证记录）
  return { color: 'red', label: '凭证损坏', reason: 'NoEvidence', source: 'missing' }
}

module.exports = {
  judge,
  FRESH_WINDOW_SECONDS,
}
