/**
 * 单工具 Skill 启用单元格
 *
 * 负责封装 Toggle、分工具调用次数、漂移同步入口和不可用/未纳管状态。
 *
 * @module components/skillControl/SkillActivationCell
 */

import React from 'react'
import Toggle from '../Toggle'
import Tag from '../Tag/Tag'
import Button from '../Button/Button'
import './skillControl.css'

/**
 * @param {object} props - 组件属性
 */
export default function SkillActivationCell({
  state,
  usageCount = 0,
  pending = false,
  managed = true,
  toolName,
  onChange,
  onSync,
  onAdopt,
}) {
  if (!state || state.state === 'unavailable') {
    return <Tag variant="warning">无法读取</Tag>
  }

  if (!managed && state.state === 'external') {
    return (
      <div className="skill-activation-cell" title={`从 ${toolName} 将完整内容纳入中央资产库`}>
        <Button variant="ghost" size="sm" disabled={pending} onClick={onAdopt}>
          {pending ? '接管中' : '纳管'}
        </Button>
      </div>
    )
  }

  if (!managed) {
    return <span className="skill-activation-cell__empty">—</span>
  }

  if (state.mutable === false) {
    return <Tag variant="default">只读来源</Tag>
  }

  return (
    <div className="skill-activation-cell">
      <Toggle
        checked={Boolean(state.enabled)}
        disabled={pending}
        onChange={(enabled) => onChange(enabled)}
      />
      <span className="skill-activation-cell__usage" title={`${toolName} 近 30 天显式调用 ${usageCount} 次`}>
        {pending ? '处理中' : `${usageCount} 次`}
      </span>
      {state.state === 'drifted' && (
        <Button variant="ghost" size="sm" disabled={pending} onClick={onSync}>同步</Button>
      )}
    </div>
  )
}
