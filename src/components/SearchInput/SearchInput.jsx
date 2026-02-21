/**
 * 搜索输入框组件
 *
 * 负责：
 * - 提供带搜索图标的输入框
 * - 统一 hover / focus / disabled 状态样式
 * - 支持受控用法（value + onChange）
 *
 * 使用示例：
 *   <SearchInput
 *     value={searchQuery}
 *     onChange={(e) => setSearchQuery(e.target.value)}
 *     placeholder="搜索 Skill..."
 *   />
 *
 * @module components/SearchInput
 */

import React from 'react'
import './SearchInput.css'

/**
 * 搜索输入框
 * @param {string} value - 受控值
 * @param {(e: React.ChangeEvent<HTMLInputElement>) => void} onChange - 变更回调
 * @param {string} placeholder - 占位文案
 * @param {boolean} disabled - 是否禁用
 * @param {string} className - 额外类名
 */
export default function SearchInput({
  value,
  onChange,
  placeholder = '搜索...',
  disabled = false,
  className = '',
}) {
  return (
    <div className={['search-input-wrap', disabled ? 'search-input-wrap--disabled' : '', className].filter(Boolean).join(' ')}>
      {/* 搜索图标 */}
      <svg
        className="search-input-wrap__icon"
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
      >
        <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
        <path d="M10.5 10.5L13.5 13.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      <input
        type="text"
        className="search-input-wrap__input"
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        disabled={disabled}
      />
    </div>
  )
}
