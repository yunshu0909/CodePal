/**
 * Skill 三层状态菜单
 *
 * 明确区分“关闭”（保留工具副本）、“从工具移除”（仅删工具副本）和
 * “从中央删除”（仅删 CodePal 中央资产），避免把三种破坏范围混为一个开关。
 *
 * @module components/skillControl/SkillStateMenu
 */

import React from 'react'
import Button from '../Button/Button'
import './skillControl.css'

const TOOLS = [
  { id: 'claude-code', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
]

export default function SkillStateMenu({ skill, pendingKeys, onAction }) {
  if (!skill?.managed) return null
  return (
    <details className="skill-state-menu">
      <summary aria-label={`管理 ${skill.name}`}>•••</summary>
      <div className="skill-state-menu__panel">
        <div className="skill-state-menu__group-title">保留副本，仅改启用状态</div>
        {TOOLS.map((tool) => {
          const state = skill.tools?.[tool.id]
          const pending = pendingKeys.has(`${skill.name}:${tool.id}`)
          return (
            <Button
              key={`toggle-${tool.id}`}
              variant="ghost"
              size="sm"
              disabled={pending || state?.enabled == null || state?.mutable === false}
              onClick={() => onAction({ action: state?.enabled ? 'disable' : 'enable', toolId: tool.id })}
            >
              {state?.enabled ? `关闭 ${tool.label}` : `打开 ${tool.label}`}
            </Button>
          )
        })}
        <div className="skill-state-menu__group-title">只清理工具侧副本</div>
        {TOOLS.map((tool) => (
          <Button
            key={`remove-${tool.id}`}
            variant="ghost"
            size="sm"
            disabled={pendingKeys.has(`${skill.name}:${tool.id}`) || skill.tools?.[tool.id]?.mutable === false}
            onClick={() => onAction({ action: 'remove-tool', toolId: tool.id })}
          >
            从 {tool.label} 移除
          </Button>
        ))}
        <div className="skill-state-menu__divider" />
        <Button variant="danger" size="sm" onClick={() => onAction({ action: 'delete-central' })}>
          从中央删除
        </Button>
      </div>
    </details>
  )
}
