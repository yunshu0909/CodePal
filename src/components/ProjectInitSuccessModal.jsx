/**
 * 项目初始化结果弹窗组件
 *
 * 负责：
 * - 在初始化成功后展示确认弹窗
 * - 在初始化失败后展示错误弹窗
 * - 展示项目路径与创建摘要
 * - 提供确认关闭、重试等回调
 *
 * @module components/ProjectInitResultModal
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
 * @param {() => void} [props.onOpenDirectory] - 点击打开目录回调
 * @returns {JSX.Element|null}
 */
export function ProjectInitSuccessModal({
  visible,
  projectPath,
  createdDirectoryCount,
  configStatus,
  onConfirm,
  onOpenDirectory,
}) {
  if (!visible) {
    return null
  }

  return (
    <div className="pi-modal-overlay" data-testid="project-init-success-modal-overlay">
      <div className="pi-result-modal" data-testid="project-init-success-modal">
        {/* 成功图标 */}
        <div className="pi-result-modal__icon pi-result-modal__icon--success" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>

        {/* 标题 */}
        <div className="pi-result-modal__title">项目初始化完成</div>

        {/* 信息区 */}
        <div className="pi-result-modal__info">
          <div className="pi-result-modal__info-row">
            <span className="pi-result-modal__info-label">项目位置</span>
            <span className="pi-result-modal__info-value" title={projectPath} data-testid="project-init-success-path">{projectPath}</span>
          </div>
          <div className="pi-result-modal__info-row">
            <span className="pi-result-modal__info-label">创建目录</span>
            <span className="pi-result-modal__info-value" data-testid="project-init-success-dir-count">{createdDirectoryCount} 个</span>
          </div>
          <div className="pi-result-modal__info-row">
            <span className="pi-result-modal__info-label">配置文件</span>
            <span className="pi-result-modal__info-value" data-testid="project-init-success-config-status">{configStatus}</span>
          </div>
        </div>

        {/* 按钮区 */}
        <div className="pi-result-modal__actions pi-result-modal__actions--single">
          {onOpenDirectory ? (
            <>
              <button
                type="button"
                className="pi-result-modal__btn pi-result-modal__btn--secondary"
                onClick={onConfirm}
                data-testid="project-init-success-close-button"
              >
                关闭
              </button>
              <button
                type="button"
                className="pi-result-modal__btn pi-result-modal__btn--primary"
                onClick={onOpenDirectory}
                data-testid="project-init-success-open-dir-button"
              >
                打开目录
              </button>
            </>
          ) : (
            <button
              type="button"
              className="pi-result-modal__btn pi-result-modal__btn--primary"
              onClick={onConfirm}
              data-testid="project-init-success-confirm-button"
            >
              确认
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * 项目初始化失败弹窗
 * @param {Object} props - 组件属性
 * @param {boolean} props.visible - 是否显示弹窗
 * @param {string} props.errorTitle - 错误标题
 * @param {string} props.errorMessage - 错误信息
 * @param {string} [props.errorHint] - 错误提示建议
 * @param {() => void} props.onClose - 点击关闭回调
 * @param {() => void} [props.onRetry] - 点击重试回调
 * @returns {JSX.Element|null}
 */
export function ProjectInitErrorModal({
  visible,
  errorTitle,
  errorMessage,
  errorHint,
  onClose,
  onRetry,
}) {
  if (!visible) {
    return null
  }

  return (
    <div className="pi-modal-overlay" data-testid="project-init-error-modal-overlay">
      <div className="pi-result-modal" data-testid="project-init-error-modal">
        {/* 失败图标 */}
        <div className="pi-result-modal__icon pi-result-modal__icon--error" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </div>

        {/* 标题 */}
        <div className="pi-result-modal__title">{errorTitle || '项目创建失败'}</div>

        {/* 错误信息区 */}
        <div className="pi-result-modal__error">
          <div className="pi-result-modal__error-text">{errorMessage}</div>
          {errorHint && (
            <div className="pi-result-modal__error-hint">提示：{errorHint}</div>
          )}
        </div>

        {/* 按钮区 */}
        <div className="pi-result-modal__actions">
          <button
            type="button"
            className="pi-result-modal__btn pi-result-modal__btn--secondary"
            onClick={onClose}
            data-testid="project-init-error-close-button"
          >
            关闭
          </button>
          {onRetry && (
            <button
              type="button"
              className="pi-result-modal__btn pi-result-modal__btn--danger"
              onClick={onRetry}
              data-testid="project-init-error-retry-button"
            >
              重试
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// 默认导出成功弹窗保持兼容性
export default ProjectInitSuccessModal
