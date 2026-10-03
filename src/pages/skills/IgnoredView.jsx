/**
 * Skill 管理页右栏：已忽略（装载总览「已忽略 N 份」进入，照定稿 C8）
 *
 * 负责：
 * - 每份一行：名字、在哪（全局目录里的写「在〈工具〉里照常装载」）、完整路径、「取消忽略」
 * - 忽略只是不再提示：文件和开关都不变
 *
 * @module pages/skills/IgnoredView
 */

import React from 'react'
import Button from '../../components/Button/Button'
import { copyLabel, toolLabelOf } from './skillsModel'

/**
 * @param {object} props
 * @param {object[]} props.ignored - 快照 ignored
 * @param {Set<string>} props.pendingKeys
 * @param {(entry: object) => void} props.onUnignore
 * @returns {JSX.Element}
 */
export default function IgnoredView({ ignored, pendingKeys, onUnignore }) {
  return (
    <div className="np-pane np-pane--detail">
      <div className="np-pane-hd">
        <h2 className="ttl">已忽略</h2>
        <div className="meta"><span>{ignored.length} 份 · 只是不再提示，文件和开关都不变</span></div>
      </div>
      <div className="np-pane-body">
        <div className="np-card np-card--form">
          {ignored.map((entry) => {
            const busy = pendingKeys.has(`${entry.name}:unignore:${entry.ignoreId}`)
            const where = copyLabel(entry)
            return (
              <div key={entry.ignoreId} className="np-row sk-prow">
                <div className="lf">
                  <div className="lb">{entry.name}</div>
                  <div className="ds">{entry.scope === 'global' && entry.stillLoaded ? `${where}；在 ${toolLabelOf(entry.toolId)} 里照常装载` : where}</div>
                  <div className="sk-p">{entry.displayPath}</div>
                </div>
                <span className="acts">
                  <Button size="sm" className="np-btn" onClick={() => onUnignore(entry)} disabled={busy}>取消忽略</Button>
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
