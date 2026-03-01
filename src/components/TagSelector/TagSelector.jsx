/**
 * 行内标签选择器组件
 *
 * 负责：
 * - 在 skill 行内展示当前标签（蓝色 pill）或「+ 标签」占位
 * - 点击展开下拉选择标签
 * - 支持分配、切换、移除标签
 * - 点击外部自动关闭下拉
 *
 * @module components/TagSelector
 */

import React, { useState, useEffect, useRef } from 'react'
import './TagSelector.css'

/**
 * 行内标签选择器
 * @param {string} skillId - 技能 ID
 * @param {string|null} currentTagId - 当前标签 ID
 * @param {Array} tags - 所有标签定义 [{id, name}]
 * @param {Function} onAssign - 分配标签回调 (skillId, tagId) => void
 * @param {Function} onRemove - 移除标签回调 (skillId) => void
 */
export default function TagSelector({ skillId, currentTagId, tags, onAssign, onRemove }) {
  // 下拉是否展开
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)

  const currentTag = currentTagId ? tags.find((t) => t.id === currentTagId) : null

  // 点击外部关闭下拉
  useEffect(() => {
    if (!open) return
    const handleClick = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        setOpen(false)
      }
    }
    document.addEventListener('click', handleClick)
    return () => document.removeEventListener('click', handleClick)
  }, [open])

  const handleToggle = (e) => {
    e.stopPropagation()
    setOpen(!open)
  }

  const handleSelect = (e, tagId) => {
    e.stopPropagation()
    // 点击已选中的标签不执行操作
    if (tagId === currentTagId) {
      setOpen(false)
      return
    }
    onAssign(skillId, tagId)
    setOpen(false)
  }

  const handleRemove = (e) => {
    e.stopPropagation()
    onRemove(skillId)
    setOpen(false)
  }

  return (
    <div className="tag-selector-wrap" ref={wrapRef}>
      {/* Trigger */}
      <button
        className={`tag-pill ${currentTag ? 'has-tag' : 'no-tag'}`}
        onClick={handleToggle}
      >
        {currentTag ? (
          <>
            {currentTag.name}
            <span className="tag-pill-arrow">▾</span>
          </>
        ) : (
          <>＋ 标签</>
        )}
      </button>

      {/* Dropdown */}
      {open && (
        <div className="tag-dropdown">
          {tags.length === 0 ? (
            <div className="tag-dropdown-empty">
              暂无标签，请先创建
            </div>
          ) : (
            <>
              {tags.map((tag) => (
                <button
                  key={tag.id}
                  className={`tag-dropdown-item ${tag.id === currentTagId ? 'current' : ''}`}
                  onClick={(e) => handleSelect(e, tag.id)}
                >
                  {tag.id === currentTagId && <span className="tag-dropdown-check">✓</span>}
                  <span>{tag.name}</span>
                </button>
              ))}
              {currentTag && (
                <>
                  <div className="tag-dropdown-divider" />
                  <button
                    className="tag-dropdown-item remove"
                    onClick={handleRemove}
                  >
                    移除标签
                  </button>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
