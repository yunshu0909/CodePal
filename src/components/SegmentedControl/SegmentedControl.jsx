/**
 * 分段控件（全局元素，设计总纲 3.18）
 *
 * 负责：
 * - 同一列表切视图或筛选，2–4 段；更多选项用弹出按钮
 * - 灰轨 + 白滑块，高 24；键盘左右键切换
 *
 * 使用示例：
 *   <SegmentedControl ariaLabel="工具" value={tool} onChange={setTool}
 *     options={[{ value: 'all', label: '全部' }, { value: 'claude', label: 'Claude Code' }]} />
 *
 * @module components/SegmentedControl
 */

import React, { useRef } from 'react'
import './SegmentedControl.css'

/**
 * @param {Array<{value: string, label: string}>} options - 各段
 * @param {string} value - 当前选中的值
 * @param {(value: string) => void} onChange - 切换回调
 * @param {string} ariaLabel - 整组的无障碍名称
 * @param {boolean} [disabled=false]
 * @returns {JSX.Element}
 */
export default function SegmentedControl({ options, value, onChange, ariaLabel, disabled = false }) {
  // 键盘切换后把焦点移到新选中的那段
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
    <div className="segmented" role="radiogroup" aria-label={ariaLabel} aria-disabled={disabled || undefined}>
      {options.map((option, index) => {
        const selected = option.value === value
        return (
          <button
            key={option.value}
            ref={(el) => { refs.current[index] = el }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            disabled={disabled}
            className={`segmented__item${selected ? ' is-selected' : ''}`}
            onClick={() => !selected && onChange(option.value)}
            onKeyDown={(event) => handleKeyDown(event, index)}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
