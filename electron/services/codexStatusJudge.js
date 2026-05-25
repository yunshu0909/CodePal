/**
 * 账户三档健康状态判定（V1.7 + V1.7.1 阈值修正）
 *
 * 负责（V1.7.1 修正）：
 * - 三个证据源取最新者：state.lastForceRefreshAt（sweep 写入）/ JWT iat / auth.last_refresh
 * - 阈值对齐 sweep 周期 7 天：在保活窗口内 → 绿；超过 → 黄
 * - 绿（近期验证）：最近一次成功铸票（sweep 或自然续期）在 7 天内
 * - 黄（未近期验证 / 网络异常）：超过 7 天没有任何成功铸票证据，或 state=paused
 * - 红（已确认失效）：state=invalid 或 auth.json 损坏
 *
 * V1.7.0 老逻辑（6h 阈值）的问题：sweep 周期 7d 但 UI 阈值 6h——sweep 完只绿 6h，
 * 剩 6.75 天黄色，让用户误以为账号要死。V1.7.1 把 UI 阈值改成跟 sweep 同步。
 *
 * 依据：
 * - 设计稿 §7 状态判定（V1.7.1 修正版）
 * - PRD US-07 三档语义
 * - K17 sweep 周期 7d
 *
 * @module electron/services/codexStatusJudge
 */

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')

const accountService = require('./codexAccountService')
const { decodeJwtPayload } = require('./codexJwtUtils')

// V1.7.1：与 sweep 周期一致（K17）—— sweep 完成后接下来 7 天保持绿色
const FRESH_WINDOW_SECONDS = 7 * 24 * 3600

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
 *   ageMs?: number,
 *   source: 'sweep' | 'iat' | 'last_refresh' | 'state' | 'missing'
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

  // 4. paused → 黄（网络异常，sweep 退避中）
  if (state.status === 'paused') {
    return { color: 'yellow', label: '网络异常', reason: 'Paused', source: 'state' }
  }

  // 5. active → 取三个证据源中最新者
  // V1.7.1 修正：lastForceRefreshAt 是 sweep 主动刷新写入的，最准确反映"保活动作"
  //            iat 是 access_token 自然续期的时间（codex CLI 用的时候自然更新）
  //            last_refresh 是 V1.6 兼容字段
  const nowMs = opts.now ?? Date.now()
  const freshWindowMs = (opts.freshWindowSeconds ?? FRESH_WINDOW_SECONDS) * 1000

  const evidences = []
  if (typeof state.lastForceRefreshAt === 'number' && state.lastForceRefreshAt > 0) {
    evidences.push({ at: state.lastForceRefreshAt, source: 'sweep' })
  }
  const accessToken = authObj?.tokens?.access_token
  if (typeof accessToken === 'string' && accessToken.length > 0) {
    try {
      const payload = decodeJwtPayload(accessToken)
      if (typeof payload.iat === 'number') {
        evidences.push({ at: payload.iat * 1000, source: 'iat' })
      }
    } catch { /* JWT 解码失败 → 不计入证据 */ }
  }
  const lastRefreshRaw = authObj.last_refresh
  if (typeof lastRefreshRaw === 'string') {
    const parsed = Date.parse(lastRefreshRaw)
    if (!Number.isNaN(parsed)) {
      evidences.push({ at: parsed, source: 'last_refresh' })
    }
  }

  if (evidences.length === 0) {
    return { color: 'red', label: '凭证损坏', reason: 'NoEvidence', source: 'missing' }
  }

  // 取最新证据；at 相同（同一次铸票事件的不同表达）时按 source 优先级
  // sweep（显式 ms 时间戳）> iat（JWT 秒精度）> last_refresh（V1.6 兼容字段）
  const SOURCE_PRIORITY = { sweep: 3, iat: 2, last_refresh: 1 }
  evidences.sort((a, b) => {
    if (b.at !== a.at) return b.at - a.at
    return (SOURCE_PRIORITY[b.source] ?? 0) - (SOURCE_PRIORITY[a.source] ?? 0)
  })
  // 同事件（差 < 2s）按 source 优先级而非时间精度（避免 ms vs 秒精度造成的"假胜出"）
  let latest = evidences[0]
  for (const ev of evidences) {
    if (latest.at - ev.at <= 2000 && (SOURCE_PRIORITY[ev.source] ?? 0) > (SOURCE_PRIORITY[latest.source] ?? 0)) {
      latest = ev
    }
  }
  const ageMs = nowMs - latest.at

  if (ageMs <= freshWindowMs) {
    return { color: 'green', label: '近期验证', ageMs, source: latest.source }
  }
  // 超过 7 天没刷过——sweep 该跑没跑（schedule 异常 / 网络异常持续 / 系统挂起）
  return { color: 'yellow', label: '未近期验证', ageMs, source: latest.source }
}

module.exports = {
  judge,
  FRESH_WINDOW_SECONDS,
}
