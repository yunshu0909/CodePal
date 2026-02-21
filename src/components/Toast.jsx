/**
 * 提示消息组件
 *
 * 负责：
 * - 显示临时提示消息（支持 info/success/error/warning 四种类型）
 * - 自动消失动画
 * - 根据类型显示对应图标和颜色
 *
 * @module Toast
 */

import React, { useEffect, useState } from 'react'

// 各类型对应的图标
const icons = {
  info: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <line x1="12" y1="16" x2="12" y2="12"/>
      <line x1="12" y1="8" x2="12.01" y2="8"/>
    </svg>
  ),
  success: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
  ),
  error: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <line x1="15" y1="9" x2="9" y2="15"/>
      <line x1="9" y1="9" x2="15" y2="15"/>
    </svg>
  ),
  warning: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
      <line x1="12" y1="9" x2="12" y2="13"/>
      <line x1="12" y1="17" x2="12.01" y2="17"/>
    </svg>
  ),
}

/**
 * Toast 提示组件
 * @param {Object} props - 组件属性
 * @param {string} props.message - 提示消息内容
 * @param {Function} props.onClose - 关闭回调
 * @param {'info'|'success'|'error'|'warning'} [props.type='info'] - 提示类型
 * @returns {JSX.Element} Toast 提示
 */
export default function Toast({ message, onClose, type = 'info' }) {
  // 控制显示/隐藏动画状态
  const [show, setShow] = useState(false)

  useEffect(() => {
    requestAnimationFrame(() => setShow(true))
    const timer = setTimeout(() => {
      setShow(false)
      setTimeout(onClose, 300)
    }, 3000)
    return () => clearTimeout(timer)
  }, [onClose])

  const icon = icons[type] || icons.info

  return (
    <div className={`toast toast--${type} ${show ? 'show' : ''}`}>
      <span className="toast__icon">{icon}</span>
      <span className="toast__message">{message}</span>
    </div>
  )
}
