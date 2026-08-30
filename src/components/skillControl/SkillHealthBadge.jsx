/**
 * Skill 健康状态徽标
 *
 * @module components/skillControl/SkillHealthBadge
 */

import React from 'react'
import Tag from '../Tag/Tag'

/**
 * @param {{skill:object,isCandidate:boolean}} props - 组件属性
 */
export default function SkillHealthBadge({ skill, isCandidate }) {
  if (!skill.managed) return <Tag variant="default">外部 Skill</Tag>

  const states = Object.values(skill.tools || {})
  if (states.some((state) => state.state === 'unavailable')) return <Tag variant="warning">部分可用</Tag>
  if (states.some((state) => state.state === 'drifted')) return <Tag variant="warning">外部修改</Tag>
  if (isCandidate) return <Tag variant="default">可精简</Tag>
  if (states.some((state) => state.enabled)) return <Tag variant="success">已同步</Tag>
  return <Tag variant="default">未启用</Tag>
}
