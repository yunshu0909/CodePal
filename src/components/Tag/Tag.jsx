/**
 * 状态/类型标签组件
 *
 * 负责：
 * - 统一页面中各种状态标签、类型标签的视觉表现
 * - 通过 variant 控制颜色语义
 * - 通过 size 控制尺寸
 *
 * 使用示例：
 *   <Tag variant="success">已推送</Tag>
 *   <Tag variant="info">stdio</Tag>
 *   <Tag variant="warning" size="md">待处理</Tag>
 *
 * @module components/Tag
 */

import React from 'react'
import './Tag.css'

/**
 * 标签组件
 * @param {'success'|'danger'|'warning'|'info'|'default'} variant - 颜色语义
 * @param {'sm'|'md'} size - 尺寸
 * @param {string} className - 额外类名
 * @param {React.ReactNode} children - 标签文本
 */
export default function Tag({ variant = 'default', size = 'sm', className = '', children }) {
  return (
    <span
      className={['tag', `tag--${variant}`, `tag--${size}`, className]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </span>
  )
}
