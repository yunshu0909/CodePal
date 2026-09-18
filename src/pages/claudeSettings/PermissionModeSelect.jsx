/**
 * 默认权限模式弹出菜单
 *
 * 负责：
 * - 弹出按钮显示当前模式色块与名字；未配置 / 未知值有各自写法
 * - 菜单按固定顺序列出六个模式，当前项打勾，选中即回调
 * - 键盘上下移动、回车确认，Esc 与点菜单外关闭且不回调
 *
 * @module pages/claudeSettings/PermissionModeSelect
 */

import { useEffect, useRef, useState } from 'react'
import { PERMISSION_MODES, findMode } from './claudeSettings'

/**
 * 模式色块
 * @param {{mode: object}} props
 * @returns {JSX.Element}
 */
export function ModeIcon({ mode }) {
  return (
    <span className="cc-mi" style={{ '--c': mode.color }} aria-hidden="true">
      <svg viewBox="0 0 16 16">
        <path d={mode.icon} />
        {mode.circle && <circle cx="8" cy="8" r="2" />}
      </svg>
    </span>
  )
}

/**
 * 弹出按钮 + 菜单
 * @param {object} props
 * @param {string|null} props.mode - 当前模式 ID；null 表示未配置
 * @param {boolean} props.disabled - 写入中禁用
 * @param {(id: string) => void} props.onSelect - 选中模式
 * @returns {JSX.Element}
 */
export default function PermissionModeSelect({ mode, disabled, onSelect }) {
  // 菜单是否展开
  const [open, setOpen] = useState(false)
  // 键盘高亮项下标；展开时从当前项开始
  const [highlight, setHighlight] = useState(0)
  const rootRef = useRef(null)
  const listRef = useRef(null)
  const current = findMode(mode)

  // 点菜单外或按 Esc 关闭，不写入
  useEffect(() => {
    if (!open) return undefined
    const onDown = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // 展开后把焦点交给菜单，键盘才能直接操作
  useEffect(() => {
    if (open && listRef.current) listRef.current.focus()
  }, [open])

  const toggle = () => {
    if (disabled) return
    const index = Math.max(0, PERMISSION_MODES.findIndex((m) => m.id === mode))
    setHighlight(index)
    setOpen((v) => !v)
  }

  const choose = (id) => {
    setOpen(false)
    onSelect(id)
  }

  const onListKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight((i) => Math.min(PERMISSION_MODES.length - 1, i + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((i) => Math.max(0, i - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); choose(PERMISSION_MODES[highlight].id) }
  }

  let label
  if (current) label = <><ModeIcon mode={current} />{current.name}</>
  else if (mode) label = <span className="raw">{mode}</span>
  else label = <span className="cc-unset">未配置</span>

  return (
    <div className="cc-select" ref={rootRef}>
      <button
        type="button"
        className="cc-pop"
        data-testid="cc-permission-popup"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={toggle}
      >
        {label}
        <svg className="chev" viewBox="0 0 10 10" aria-hidden="true"><path d="M3 4 5 2l2 2M3 6l2 2 2-2" /></svg>
      </button>
      {open && (
        <div className="cc-menu" role="listbox" tabIndex={-1} ref={listRef} onKeyDown={onListKey}>
          {PERMISSION_MODES.map((m, i) => (
            <div
              key={m.id}
              role="option"
              aria-selected={m.id === mode}
              title={m.desc}
              className={`cc-mitem${i === highlight ? ' hl' : ''}`}
              onMouseEnter={() => setHighlight(i)}
              onClick={() => choose(m.id)}
            >
              <ModeIcon mode={m} />
              <div className="tx"><b>{m.name}</b><span>{m.desc}</span></div>
              <em className="ck">{m.id === mode ? '✓' : ''}</em>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
