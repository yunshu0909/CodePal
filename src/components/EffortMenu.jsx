/** Shared reasoning-level menu. The caller owns the anchor, open state and write operation. */
import { useLayoutEffect, useRef, useState } from 'react'
import usePopoverDismiss from '../hooks/usePopoverDismiss'

export default function EffortMenu({ value, efforts, anchorRef, onPick, onClose, className = '' }) {
  const root = useRef(null)
  const [above, setAbove] = useState(false)
  usePopoverDismiss(root, onClose, anchorRef)
  useLayoutEffect(() => {
    const menu = root.current
    const anchor = anchorRef.current
    if (!menu || !anchor) return
    const boundary = anchor.closest('.np-scroll')?.getBoundingClientRect().bottom || window.innerHeight
    const anchorRect = anchor.getBoundingClientRect()
    setAbove(
      anchorRect.bottom + 4 + menu.getBoundingClientRect().height > boundary &&
        anchorRect.top > menu.getBoundingClientRect().height
    )
    const selected = menu.querySelector('[aria-checked="true"]') || menu.querySelector('button')
    selected?.focus()
  }, [anchorRef])
  const close = () => {
    onClose()
    anchorRef.current?.focus()
  }
  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      close()
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const items = [...root.current.querySelectorAll('[role="menuitemradio"]')]
    const current = items.indexOf(document.activeElement)
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    items[next]?.focus()
  }
  return (
    <div
      ref={root}
      className={`np-menu${className ? ` ${className}` : ''}`}
      role="menu"
      aria-label="思考强度"
      onKeyDown={onKeyDown}
      style={above ? { top: 'auto', bottom: 'calc(100% + 4px)' } : undefined}
    >
      {efforts.map((effort) => (
        <button
          key={effort}
          type="button"
          role="menuitemradio"
          aria-label={effort}
          aria-checked={effort === value}
          className="np-mitem"
          onClick={() => onPick(effort)}
        >
          <span className="tx">
            <b>{effort}</b>
          </span>
          <span className="ck" aria-hidden="true">
            {effort === value ? '✓' : ''}
          </span>
        </button>
      ))}
    </div>
  )
}
