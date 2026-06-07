/**
 * 新建项目实时预览树（数据驱动）
 *
 * 负责：渲染将创建的目录结构预览，节点来自 TREE_NODES，按当前勾选/Git 模式过滤。
 *
 * @module pages/projectInit/ProjectTreePreview
 */

import React from 'react'
import { TREE_NODES } from './projectInitConstants'

/**
 * 单个树节点行
 * @param {{node: object}} props
 */
function TreeRow({ node }) {
  const indentClass = node.indent === 2 ? 'pi-tree-indent-2' : 'pi-tree-indent'
  const isDir = node.kind === 'dir'
  const iconClass = `${isDir ? 'pi-tree-folder' : 'pi-tree-file'}${node.success ? ' pi-tree-success' : ''}`
  return (
    <div className={`pi-tree-item ${indentClass} pi-tree-connector`} data-testid={node.testId || undefined}>
      <span className={iconClass}>{isDir ? '📁' : '📄'}</span>
      <span className={node.success ? 'pi-tree-success' : undefined}>{node.name}</span>
      <span className="pi-tree-annotation">{node.annotation}</span>
    </div>
  )
}

/**
 * 预览面板
 * @param {Object} props
 * @param {string} props.projectName - 预览根目录名
 * @param {Object} props.templateSelection - 模板勾选状态
 * @param {string} props.gitMode - Git 模式
 * @param {boolean} props.isExpanded - 是否展开
 * @param {() => void} props.onToggle - 展开/收起切换
 * @returns {JSX.Element}
 */
export default function ProjectTreePreview({ projectName, templateSelection, gitMode, isExpanded, onToggle }) {
  const state = { templateSelection, gitMode }
  const visibleNodes = TREE_NODES.filter((node) => !node.visibleWhen || node.visibleWhen(state))

  return (
    <section
      className={`pi-preview-panel ${isExpanded ? 'expanded' : 'collapsed'}`}
      data-testid="project-init-preview-panel"
    >
      <div className="pi-preview-header" onClick={onToggle} style={{ cursor: 'pointer' }}>
        <span>👁</span> 实时预览
        <span className="pi-preview-toggle">{isExpanded ? '▲' : '▼'}</span>
      </div>
      {isExpanded && (
        <div className="pi-preview-content" data-testid="project-tree-preview">
          <div className="pi-tree">
            <div className="pi-tree-item root" data-testid="project-tree-root">
              <span className="pi-tree-folder">📁</span>
              <span>{projectName}</span> /
            </div>
            {visibleNodes.map((node) => (
              <TreeRow key={node.key} node={node} />
            ))}
          </div>
        </div>
      )}
    </section>
  )
}
