/**
 * 通用弹窗组件
 *
 * 负责：
 * - 提供遮罩 + 面板的通用底座
 * - 支持 header（标题 + 关闭按钮）、body、footer 三段式布局
 * - ESC 键关闭
 * - 点击遮罩关闭（可配置）
 * - 打开时锁定 body 滚动
 * - 淡入动画
 *
 * 使用示例：
 *   <Modal open={isOpen} onClose={handleClose} title="添加路径"
 *     footer={<><Button variant="secondary" onClick={handleClose}>取消</Button>
 *               <Button variant="primary" onClick={handleConfirm}>确认</Button></>}
 *   >
 *     <p>弹窗内容</p>
 *   </Modal>
 *
 * @module components/Modal
 */

import React, { useEffect, useCallback } from 'react'
import './Modal.css'

/**
 * 通用弹窗
 * @param {boolean} open - 是否显示
 * @param {() => void} onClose - 关闭回调
 * @param {string} title - 标题（可选，不传则不渲染 header）
 * @param {'sm'|'md'|'lg'} size - 面板宽度
 * @param {React.ReactNode} footer - 底部插槽（操作按钮区）
 * @param {boolean} closeOnOverlay - 点击遮罩是否关闭，默认 true
 * @param {boolean} showCloseButton - 是否显示右上角关闭按钮，默认 true
 * @param {React.ReactNode} children - 弹窗主体内容
 */
export default function Modal({
  open,
  onClose,
  title,
  size = 'md',
  footer,
  closeOnOverlay = true,
  showCloseButton = true,
  children,
}) {
  // ESC 键关闭
  const handleKeyDown = useCallback(
    (e) => {
      if (e.key === 'Escape') onClose?.()
    },
    [onClose]
  )

  useEffect(() => {
    if (!open) return
    document.addEventListener('keydown', handleKeyDown)
    // 打开时锁定 body 滚动
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = ''
    }
  }, [open, handleKeyDown])

  if (!open) return null

  const handleOverlayClick = (e) => {
    // 只响应点击遮罩本身（不冒泡自面板内部）
    if (closeOnOverlay && e.target === e.currentTarget) {
      onClose?.()
    }
  }

  return (
    <div className="modal-overlay" onClick={handleOverlayClick} role="dialog" aria-modal="true">
      <div className={`modal-panel modal-panel--${size}`}>
        {/* Header：有 title 或 showCloseButton 时渲染 */}
        {(title || showCloseButton) && (
          <div className="modal-header">
            {title && <h2 className="modal-title">{title}</h2>}
            {showCloseButton && (
              <button className="modal-close" onClick={onClose} aria-label="关闭">
                ✕
              </button>
            )}
          </div>
        )}

        {/* Body */}
        <div className="modal-body">{children}</div>

        {/* Footer */}
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  )
}
