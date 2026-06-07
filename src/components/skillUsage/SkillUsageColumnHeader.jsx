/**
 * SkillUsageColumnHeader —「调用·近30天」列表头
 *
 * - 可点排序（降序 ↓ / 升序 ↑）
 * - ⓘ 点击展开/收起「调用数说明」浮层（诚实声明，低调不占常驻空间）
 * - 部分可用时（只读到一个工具的日志）在浮层里追加提示
 *
 * @module components/skillUsage/SkillUsageColumnHeader
 */
import React from 'react'
import './skillUsage.css'

/**
 * @param {object} props
 * @param {'desc'|'asc'} props.sort - 当前排序方向
 * @param {Function} props.onToggleSort - 切换排序
 * @param {boolean} props.helpOpen - 说明浮层是否展开
 * @param {Function} props.onToggleHelp - 切换说明浮层
 * @param {{claude:string, codex:string}|null} props.sources - 各源可用状态
 */
export default function SkillUsageColumnHeader({ sort, onToggleSort, helpOpen, onToggleHelp, sources }) {
  const onlyClaude = sources && sources.claude === 'ok' && sources.codex !== 'ok'
  const onlyCodex = sources && sources.codex === 'ok' && sources.claude !== 'ok'

  return (
    <div className="header-usage">
      <span className="header-usage-sort" onClick={onToggleSort}>
        调用·近30天 {sort === 'asc' ? '↑' : '↓'}
      </span>
      <button type="button" className="header-usage-info" onClick={onToggleHelp} title="调用数说明">ⓘ</button>
      {helpOpen && (
        <div className="usage-help-pop">
          <strong>调用数说明</strong>
          统计近 30 天，来自本机 Claude + Codex 日志（Codex 仅显式 <code>$技能名</code> 调用，隐式不计）。0 次 ≠ 一定没用过。
          {onlyClaude && <div className="usage-help-note">⚠️ 本次仅读到 Claude，Codex 日志未读到。</div>}
          {onlyCodex && <div className="usage-help-note">⚠️ 本次仅读到 Codex，Claude 日志未读到。</div>}
        </div>
      )}
    </div>
  )
}
