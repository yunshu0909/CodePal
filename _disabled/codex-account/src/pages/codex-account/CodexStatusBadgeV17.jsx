/**
 * V1.7 三档状态徽章
 *
 * 严格遵守 PRD US-07 命名："近期验证 / 未近期验证 / 已确认失效"——不叫"可用/不可用"
 *
 * 颜色映射（走 Tag variant，不另立新色）：
 * - green → success
 * - yellow → warning
 * - red → danger
 *
 * @module pages/codex-account/CodexStatusBadgeV17
 */

import React from 'react'
import Tag from '../../components/Tag/Tag'

const COLOR_TO_VARIANT = {
  green: 'success',
  yellow: 'warning',
  red: 'danger',
}

/**
 * @param {{ status: { color: 'green'|'yellow'|'red', label: string, reason?: string }, title?: string }} props
 */
export default function CodexStatusBadgeV17({ status, title }) {
  if (!status) return null
  const variant = COLOR_TO_VARIANT[status.color] ?? 'default'
  const tooltip = title ?? buildTooltip(status)
  return (
    <span title={tooltip}>
      <Tag variant={variant} size="sm">{status.label}</Tag>
    </span>
  )
}

function buildTooltip(status) {
  // V1.7.1：阈值与 sweep 周期对齐（7 天），文案体现"保活窗口"语义
  if (status.color === 'green') return '保活窗口内（最近 7 天有过成功铸票，refresh_token 大概率仍活）'
  if (status.color === 'yellow') {
    if (status.reason === 'Paused') return '近 3 次刷新都网络异常已暂停，恢复联网或手动重试'
    return '超过 7 天没有铸票证据（sweep 该跑没跑 / 系统长期挂起）——可点"立即重新验证"'
  }
  if (status.color === 'red') {
    if (status.reason === 'Revoked') return '已在 chatgpt.com 撤销授权 / 改密 / 账号被封'
    if (status.reason === 'Expired') return 'refresh_token 自然过期'
    if (status.reason === 'Exhausted') return 'refresh_token 被多端复用，已被服务端拉黑'
    if (status.reason === 'AuthMissing') return '账户凭证文件不存在，需重新登录'
    if (status.reason === 'AuthCorrupt') return '账户凭证文件损坏'
    return '已确认失效，请重新登录'
  }
  return ''
}
