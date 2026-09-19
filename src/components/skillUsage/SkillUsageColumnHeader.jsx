/**
 * SkillUsageColumnHeader —「调用·近30天」列表头
 *
 * - 可点排序（降序 ↓ / 升序 ↑）
 * - ⓘ 展示账本口径、上次扫描、双源状态与日志可观测边界
 *
 * @module components/skillUsage/SkillUsageColumnHeader
 */
import React from 'react'
import './skillUsage.css'

function sourceLabel(value) {
  return {
    ok: '已读取',
    missing: '未找到',
    error: '读取失败',
  }[value] || '未扫描'
}

function formatScannedAt(value) {
  if (!value) return '—'
  try {
    return new Date(value).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return value
  }
}

/**
 * @param {object} props
 * @param {'desc'|'asc'} props.sort - 当前排序方向
 * @param {Function} props.onToggleSort - 切换排序
 * @param {boolean} props.helpOpen - 说明浮层是否展开
 * @param {Function} props.onToggleHelp - 切换说明浮层
 * @param {object|null} props.scanMeta - 上次扫描元数据
 * @param {{claude:string,codex:string}|null} [props.sources] - 兼容旧调用方的源状态
 */
export default function SkillUsageColumnHeader({
  sort,
  onToggleSort,
  helpOpen,
  onToggleHelp,
  scanMeta,
  sources: legacySources,
}) {
  const sources = scanMeta?.sources || legacySources

  return (
    <div className="header-usage">
      <span className="header-usage-sort" onClick={onToggleSort}>
        调用·近30天 {sort === 'asc' ? '↑' : '↓'}
      </span>
      <button type="button" className="header-usage-info" onClick={onToggleHelp} title="调用数说明">ⓘ</button>
      {helpOpen && (
        <div className="usage-help-pop">
          <strong>调用数说明</strong>
          <div>主数字是 CodePal 已记录的近 30 天有效调用。同一会话触发两次记 2 次。</div>
          <div className="usage-help-meta">上次扫描：{formatScannedAt(scanMeta?.lastScannedAt)}</div>
          <div className="usage-help-meta">
            Claude {sourceLabel(sources?.claude)} · Codex {sourceLabel(sources?.codex)}
          </div>
          <div className="usage-help-boundary">
            长时间未打开 CodePal，或原日志已被工具清理，期间调用可能未被记录。0 次不等于一定没用过。
          </div>
          {scanMeta?.migrationFailed && (
            <div className="usage-help-note">调用账本升级失败，本次继续显示旧口径。</div>
          )}
        </div>
      )}
    </div>
  )
}
