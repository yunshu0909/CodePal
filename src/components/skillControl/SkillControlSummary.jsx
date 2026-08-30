/**
 * Skill 控制中心摘要
 *
 * 负责展示资产、两工具启用数、外部来源和问题数，并允许切换对应视图。
 *
 * @module components/skillControl/SkillControlSummary
 */

import React from 'react'
import './skillControl.css'

const METRICS = [
  { key: 'all', valueKey: 'managed', label: '资产库' },
  { key: 'active', valueKey: 'claudeEnabled', label: 'Claude Code 启用' },
  { key: 'active', valueKey: 'codexEnabled', label: 'Codex 启用' },
  { key: 'external', valueKey: 'externalCount', label: '外部 Skill' },
  { key: 'issues', valueKey: 'issueCount', label: '需要处理', warning: true },
]

/**
 * @param {{summary:object,activeView:string,onSelect:(view:string)=>void}} props - 组件属性
 */
export default function SkillControlSummary({ summary, activeView, onSelect }) {
  return (
    <div className="skill-control-summary" aria-label="Skill 状态摘要">
      {METRICS.map((metric, index) => (
        <button
          type="button"
          className={`skill-control-metric ${activeView === metric.key ? 'is-active' : ''}`}
          key={`${metric.valueKey}-${index}`}
          onClick={() => onSelect(metric.key)}
        >
          <span className={`skill-control-metric__value ${metric.warning && summary[metric.valueKey] > 0 ? 'is-warning' : ''}`}>
            {summary[metric.valueKey] || 0}
          </span>
          <span className="skill-control-metric__label">{metric.label}</span>
        </button>
      ))}
    </div>
  )
}
