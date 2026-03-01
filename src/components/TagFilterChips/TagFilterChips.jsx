/**
 * 标签筛选 Chips 组件
 *
 * 负责：
 * - 渲染「全部」+ 各标签筛选 chip
 * - 显示每个标签下的技能计数
 * - 溢出时折叠为「+N」下拉
 * - 折叠中包含当前选中标签时高亮「+N」
 *
 * @module components/TagFilterChips
 */

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import './TagFilterChips.css'

/**
 * 标签筛选 Chips
 * @param {Array} tags - 标签定义列表 [{id, name}]
 * @param {Object} skillTags - 技能-标签映射 {skillId: tagId}
 * @param {string|null} activeTagId - 当前筛选标签 ID（null = 全部）
 * @param {Function} onSelect - 选中回调 (tagId|null) => void
 */
export default function TagFilterChips({ tags, skillTags, activeTagId, onSelect }) {
  // 溢出的标签索引起点
  const [overflowStart, setOverflowStart] = useState(null)
  // +N 下拉是否展开
  const [moreOpen, setMoreOpen] = useState(false)

  const containerRef = useRef(null)
  const chipsRef = useRef([])

  /** 计算每个标签的技能数 */
  const tagCounts = useMemo(() => {
    const counts = {}
    for (const tagId of Object.values(skillTags)) {
      counts[tagId] = (counts[tagId] || 0) + 1
    }
    return counts
  }, [skillTags])

  /** 检测溢出，计算哪些 chips 需要折叠 */
  const checkOverflow = useCallback(() => {
    const container = containerRef.current
    if (!container) return

    const containerWidth = container.clientWidth
    // 预留 +N 按钮的空间（约 60px）
    const maxWidth = containerWidth - 60
    let totalWidth = 0
    let breakIndex = null

    const chips = container.querySelectorAll('.tag-chip:not(.tag-chip-more)')
    for (let i = 0; i < chips.length; i++) {
      totalWidth += chips[i].offsetWidth + 8 // 8px gap
      if (totalWidth > maxWidth && i > 0) {
        breakIndex = i
        break
      }
    }

    setOverflowStart(breakIndex)
  }, [])

  useEffect(() => {
    checkOverflow()

    const observer = new ResizeObserver(checkOverflow)
    if (containerRef.current) {
      observer.observe(containerRef.current)
    }
    return () => observer.disconnect()
  }, [checkOverflow, tags])

  // 点击外部关闭 +N 下拉
  useEffect(() => {
    if (!moreOpen) return
    const handleClick = (e) => {
      if (!e.target.closest('.tag-chip-more-wrap')) {
        setMoreOpen(false)
      }
    }
    document.addEventListener('click', handleClick)
    return () => document.removeEventListener('click', handleClick)
  }, [moreOpen])

  // 「全部」chip + 各标签 chip
  const allChips = [
    { id: null, name: '全部', count: null },
    ...tags.map((t) => ({ id: t.id, name: t.name, count: tagCounts[t.id] || 0 })),
  ]

  // 可见 / 溢出分割
  const visibleChips = overflowStart ? allChips.slice(0, overflowStart) : allChips
  const overflowChips = overflowStart ? allChips.slice(overflowStart) : []

  // 当前筛选标签在折叠区
  const activeInOverflow = overflowChips.some((c) => c.id === activeTagId)

  return (
    <div className="tag-filter-chips" ref={containerRef}>
      {visibleChips.map((chip) => (
        <button
          key={chip.id ?? '__all__'}
          className={`tag-chip ${activeTagId === chip.id ? 'active' : ''}`}
          onClick={() => onSelect(chip.id)}
        >
          {chip.name}
          {chip.count !== null && (
            <span className="tag-chip-count">({chip.count})</span>
          )}
        </button>
      ))}

      {overflowChips.length > 0 && (
        <div className="tag-chip-more-wrap">
          <button
            className={`tag-chip tag-chip-more ${activeInOverflow ? 'active' : ''}`}
            onClick={(e) => { e.stopPropagation(); setMoreOpen(!moreOpen) }}
          >
            +{overflowChips.length} ▾
          </button>
          {moreOpen && (
            <div className="tag-chip-more-dropdown">
              {overflowChips.map((chip) => (
                <button
                  key={chip.id ?? '__all__'}
                  className={`tag-chip-more-item ${activeTagId === chip.id ? 'active' : ''}`}
                  onClick={() => { onSelect(chip.id); setMoreOpen(false) }}
                >
                  <span>{chip.name}</span>
                  {chip.count !== null && (
                    <span className="tag-chip-more-item-count">{chip.count}</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
