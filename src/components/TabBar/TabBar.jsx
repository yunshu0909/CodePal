/**
 * 页签（通用组件，设计总纲 3.16；Skills 左栏首用，2026-10-03 用户在对比板选定第 4 版）
 *
 * 负责：
 * - 同一列表按组切换：文字页签，选中的变黑加粗、下面一条蓝线；整行底下一条细线隔开下面的内容
 * - 每个页签可带一个数字（条数）；键盘左右键切换
 * - 和 <SegmentedControl> 的分工：分段控件是灰轨白滑块，用在工具栏、卡里的视图 / 筛选；
 *   页签用在一栏的顶上、把下面整列内容分组
 *
 * 使用示例：
 *   <TabBar ariaLabel="分组" value={tab} onChange={setTab}
 *     options={[{ value: 'inbox', label: '要处理', count: 35 }, { value: 'used', label: '在用', count: 5 }]} />
 *
 * @module components/TabBar
 */

import React, { useRef } from 'react'
import './TabBar.css'

/**
 * @param {Array<{value: string, label: string, count?: number}>} options - 各页签
 * @param {string} value - 当前选中的值
 * @param {(value: string) => void} onChange - 切换回调
 * @param {string} ariaLabel - 整组的无障碍名称
 * @param {boolean} [disabled=false] - 变淡且不能点（比如搜索时）
 * @returns {JSX.Element}
 */
export default function TabBar({ options, value, onChange, ariaLabel, disabled = false }) {
  // 键盘切换后把焦点移到新选中的那个
  const refs = useRef([])

  const handleKeyDown = (event, index) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (!step) return
    event.preventDefault()
    const next = (index + step + options.length) % options.length
    onChange(options[next].value)
    refs.current[next]?.focus()
  }

  return (
    <div className="tabbar" role="tablist" aria-label={ariaLabel} aria-disabled={disabled || undefined}>
      {options.map((option, index) => {
        const selected = option.value === value
        return (
          <button
            key={option.value}
            ref={(el) => { refs.current[index] = el }}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            disabled={disabled}
            className={`tabbar__item${selected ? ' is-selected' : ''}`}
            onClick={() => !selected && onChange(option.value)}
            onKeyDown={(event) => handleKeyDown(event, index)}
          >
            {option.label}
            {typeof option.count === 'number' && <span className="tabbar__count">{option.count}</span>}
          </button>
        )
      })}
    </div>
  )
}
