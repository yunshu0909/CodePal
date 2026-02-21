/**
 * Toggle 开关组件
 *
 * 负责：
 * - 提供启用/停用状态的视觉开关
 * - 支持禁用状态
 * - 平滑的过渡动画
 *
 * @module components/Toggle
 */

import React from 'react'
import './Toggle.css'

/**
 * Toggle 开关组件
 * @param {Object} props - 组件属性
 * @param {boolean} props.checked - 是否开启
 * @param {function} props.onChange - 状态变化回调函数
 * @param {boolean} [props.disabled=false] - 是否禁用
 * @returns {React.ReactElement}
 */
export default function Toggle({ checked, onChange, disabled = false }) {
  /**
   * 处理点击事件
   */
  const handleClick = () => {
    if (!disabled && onChange) {
      onChange(!checked)
    }
  }

  return (
    <div
      className={`toggle ${checked ? 'on' : ''} ${disabled ? 'disabled' : ''}`}
      onClick={handleClick}
      role="switch"
      aria-checked={checked}
      aria-disabled={disabled}
    >
      <div className="toggle-thumb" />
    </div>
  )
}
