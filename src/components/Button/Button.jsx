/**
 * 通用按钮组件
 *
 * 负责：
 * - 提供统一的按钮变体（primary / secondary / danger / ghost）
 * - 提供统一的尺寸规格（sm / md / lg）
 * - 处理 loading 态（显示 spinner，自动 disabled）
 * - 处理 disabled 态（样式 + 阻止点击）
 *
 * 使用示例：
 *   <Button variant="primary" onClick={handleSave}>保存</Button>
 *   <Button variant="danger" size="sm" onClick={handleDelete}>删除</Button>
 *   <Button variant="secondary" loading={isSaving}>保存中</Button>
 *
 * @module components/Button
 */

import React from 'react'
import './Button.css'

/**
 * 通用按钮
 * @param {'primary'|'secondary'|'danger'|'ghost'} variant - 视觉变体
 * @param {'sm'|'md'|'lg'} size - 尺寸
 * @param {boolean} loading - 加载中（显示 spinner，禁止点击）
 * @param {boolean} disabled - 禁用
 * @param {string} className - 额外类名
 * @param {React.ReactNode} children - 按钮内容
 * @param {React.ButtonHTMLAttributes} rest - 其余原生 button 属性
 */
export default function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  disabled = false,
  className = '',
  children,
  ...rest
}) {
  const isDisabled = disabled || loading

  return (
    <button
      className={[
        'btn',
        `btn--${variant}`,
        `btn--${size}`,
        loading ? 'btn--loading' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      disabled={isDisabled}
      {...rest}
    >
      {/* loading 时在文字前展示 spinner */}
      {loading && <span className="btn__spinner" aria-hidden="true" />}
      <span className="btn__label">{children}</span>
    </button>
  )
}
