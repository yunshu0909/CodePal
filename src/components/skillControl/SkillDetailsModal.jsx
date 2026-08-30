/**
 * Skill 详情与处理说明弹窗
 *
 * 负责把用途、真实来源、生效条件和可执行处理方式放在同一处解释。
 *
 * @module components/skillControl/SkillDetailsModal
 */

import React from 'react'
import Modal from '../Modal/Modal'
import Tag from '../Tag/Tag'

function toolName(toolId) {
  return toolId === 'codex' ? 'Codex' : 'Claude Code'
}

function sourceLabel(origin) {
  if (origin.origin === 'plugin') return origin.pluginName ? `父 Plugin：${origin.pluginName}` : 'Plugin Skill'
  if (origin.origin === 'system' || origin.origin === 'bundled') return '系统 Skill'
  if (origin.origin === 'project') return '项目 Skill'
  if (origin.origin === 'command') return '旧 Command'
  if (origin.origin === 'legacy') return '兼容目录'
  return '个人目录'
}

/**
 * @param {object} props 组件属性
 * @returns {JSX.Element}
 */
export default function SkillDetailsModal({ skill, onClose }) {
  if (!skill) return null
  const origins = skill.origins || []
  const pluginOrigin = origins.find((origin) => origin.origin === 'plugin')
  const systemOrigin = origins.find((origin) => origin.origin === 'system' || origin.origin === 'bundled')
  const projectOrigin = origins.find((origin) => origin.origin === 'project')
  const mutableOrigin = origins.find((origin) => origin.mutable !== false)
  const purpose = skill.desc || skill.description || origins.find((origin) => origin.description)?.description || '暂无说明'

  let effectiveText = '当前未在 Claude Code 或 Codex 中启用。'
  let handlingTitle = skill.managed ? '可在对应工具列中单独启停。' : '可收进资产库后统一维护。'
  let handlingText = skill.managed
    ? '中央资产保留不变，工具列开关只控制该工具是否加载。'
    : '收进资产库会复制完整内容并建立中央维护版本，不会删除软链接指向的上游目录。'

  if (pluginOrigin) {
    effectiveText = `来自 ${toolName(pluginOrigin.toolId)} Plugin ${pluginOrigin.pluginName || pluginOrigin.pluginId || '未知 Plugin'}。仅在父 Plugin 已安装且启用时，新任务才会加载它。`
    handlingTitle = '随 Plugin 启用'
    handlingText = '这是只读 Plugin Skill。请到 Plugin 控制中心启停父 Plugin；这里不提供独立开关。'
  } else if (systemOrigin) {
    effectiveText = `由 ${toolName(systemOrigin.toolId)} 随应用提供，新任务会按系统规则加载。`
    handlingTitle = '系统提供'
    handlingText = '这是只读系统 Skill，CodePal 只展示其用途和状态，不复制或删除系统文件。'
  } else if (projectOrigin) {
    effectiveText = `仅在项目 ${projectOrigin.project || ''} 的 Claude Code 会话中生效。`
    handlingTitle = '随项目生效'
    handlingText = '这是项目级只读来源，请在对应项目中维护。'
  } else if (mutableOrigin) {
    effectiveText = `来自 ${toolName(mutableOrigin.toolId)} 的个人目录。`
  }

  return (
    <Modal open onClose={onClose} title="Skill 详情" size="md">
      <div className="skill-details">
        <div className="skill-details__heading">
          <h3>{skill.displayName || skill.name}</h3>
          <div className="skill-details__badges">
            {origins.map((origin) => (
              <Tag key={`${origin.toolId}:${origin.origin}:${origin.pluginId || ''}`} variant={origin.origin === 'plugin' ? 'info' : 'default'}>
                {sourceLabel(origin)}
              </Tag>
            ))}
          </div>
        </div>
        <section>
          <h4>作用</h4>
          <p>{purpose}</p>
        </section>
        <section>
          <h4>在哪里生效</h4>
          <p>{effectiveText}</p>
        </section>
        <section>
          <h4>如何处理</h4>
          <div className="skill-details__handling">
            <strong>{handlingTitle}</strong>
            <p>{handlingText}</p>
          </div>
        </section>
      </div>
    </Modal>
  )
}
