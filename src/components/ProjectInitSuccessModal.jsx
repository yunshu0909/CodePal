/**
 * 项目初始化成功弹窗组件
 *
 * 负责：
 * - 在初始化成功后展示确认弹窗
 * - 展示项目路径与创建摘要
 * - 提供确认关闭回调
 *
 * @module components/ProjectInitSuccessModal
 */

import React from 'react'

/**
 * 项目初始化成功弹窗
 * @param {Object} props - 组件属性
 * @param {boolean} props.visible - 是否显示弹窗
 * @param {string} props.projectPath - 项目根目录路径
 * @param {number} props.createdDirectoryCount - 本次创建目录数
 * @param {'已生成'|'未生成'} props.configStatus - 配置文件生成状态
 * @param {() => void} props.onConfirm - 点击确认回调
 * @returns {JSX.Element|null}
 */
export default function ProjectInitSuccessModal({
  visible,
  projectPath,
  createdDirectoryCount,
  configStatus,
  onConfirm,
}) {
  if (!visible) {
    return null
  }

  return (
    <div className="pi-modal-overlay" data-testid="project-init-success-modal-overlay">
      <div className="pi-success-modal" data-testid="project-init-success-modal">
        <div className="pi-success-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>

        <h2 className="pi-success-title">项目初始化完成</h2>
        <p className="pi-success-desc">目录结构已创建，可以开始导入和管理你的技能了</p>

        <div className="pi-success-summary">
          <div className="pi-summary-row">
            <span className="pi-summary-label">项目位置</span>
            <span className="pi-summary-value" data-testid="project-init-success-path">{projectPath}</span>
          </div>
          <div className="pi-summary-row">
            <span className="pi-summary-label">创建目录</span>
            <span className="pi-summary-value" data-testid="project-init-success-dir-count">{createdDirectoryCount} 个</span>
          </div>
          <div className="pi-summary-row">
            <span className="pi-summary-label">配置文件</span>
            <span className="pi-summary-value" data-testid="project-init-success-config-status">{configStatus}</span>
          </div>
        </div>

        <button
          type="button"
          className="pi-btn pi-btn-primary pi-success-confirm-btn"
          onClick={onConfirm}
          data-testid="project-init-success-confirm-button"
        >
          确认
        </button>
      </div>
    </div>
  )
}
