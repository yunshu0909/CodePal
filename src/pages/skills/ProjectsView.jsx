/**
 * Skill 管理页右栏：找到的项目（装载总览「从 K 个项目里找到」进入，照定稿 B2、F1）
 *
 * 负责：
 * - 每个项目一行：名字、完整路径、在要处理里有几份；skills 目录读不了的写原因
 * - 页脚说明只看哪些目录
 *
 * @module pages/skills/ProjectsView
 */

import React from 'react'

const ERROR_TEXT = { PERMISSION_DENIED: '读不了：没有权限', NOT_FOUND: '读不了：文件夹不在了' }

/**
 * @param {object} props
 * @param {{scanned: number, found: object[]}} props.projects - 快照 projects
 * @returns {JSX.Element}
 */
export default function ProjectsView({ projects }) {
  const found = projects?.found || []
  return (
    <div className="np-pane np-pane--detail">
      <div className="np-pane-hd">
        <h2 className="ttl">找到的项目</h2>
        <div className="meta"><span>从 {projects?.scanned || 0} 个打开过的目录里找到 {found.length} 个</span></div>
      </div>
      <div className="np-pane-body">
        <div className="np-card np-card--form">
          {found.map((project) => (
            <div key={project.displayPath} className="np-row sk-prow">
              <div className="lf">
                <div className="lb">{project.name}</div>
                <div className="sk-p">{project.displayPath}</div>
                {project.error && <div className="ds bad">{ERROR_TEXT[project.error] || '读不了'}</div>}
              </div>
              <span className="sk-n-copies"><span className="sk-num">{project.copies}</span> 份</span>
            </div>
          ))}
        </div>
        <p className="np-empty sk-note">只看里面真有 .claude/skills、.agents/skills、.codex/skills 的目录；家目录和临时目录不看。</p>
      </div>
    </div>
  )
}
