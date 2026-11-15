/** Read-only evidence anchored to its row, using the shared Native+ popover surface. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export default function CheckPopover({ check, anchor, checkedText, onClose }) {
  const ref = useRef(null)
  const [position, setPosition] = useState({ left: 0, top: 0, up: false })
  const root = anchor?.closest('.ce-page')

  useLayoutEffect(() => {
    if (!root || !ref.current) return
    const row = anchor.getBoundingClientRect()
    const bounds = root.getBoundingClientRect()
    const height = ref.current.offsetHeight
    const up = row.bottom - bounds.top + height + 12 > bounds.height
    setPosition({ left: Math.max(8, Math.min(row.right - bounds.left - 250, bounds.width - 258)), top: Math.max(8, up ? row.top - bounds.top - height - 8 : row.bottom - bounds.top + 8), up })
    ref.current.focus({ preventScroll: true })
  }, [anchor, root])

  useEffect(() => {
    const key = event => {
      if (event.key === 'Escape') { onClose(); anchor?.focus({ preventScroll: true }) }
    }
    const outside = event => {
      if (!ref.current?.contains(event.target) && !anchor?.contains(event.target)) onClose()
    }
    const scroll = event => { if (!ref.current?.contains(event.target)) onClose() }
    document.addEventListener('keydown', key)
    document.addEventListener('pointerdown', outside)
    root?.addEventListener('scroll', scroll, true)
    window.addEventListener('resize', onClose)
    return () => {
      document.removeEventListener('keydown', key)
      document.removeEventListener('pointerdown', outside)
      root?.removeEventListener('scroll', scroll, true)
      window.removeEventListener('resize', onClose)
    }
  }, [anchor, onClose, root])

  if (!root) return null
  return createPortal(
    <div ref={ref} tabIndex={-1} role="dialog" aria-label={`${check.title}详情`} className={`np-pop np-pop--arrow ce-pop${position.up ? ' ce-pop--up' : ''}`} style={{ left: position.left, top: position.top }}>
      <div className="np-pop-title">{check.title}</div>
      <dl className="ce-evidence">
        {check.evidence.map(([name, value], index) => <div key={`${name}-${index}`}><dt>{name}</dt><dd>{value}</dd></div>)}
        {checkedText && <div><dt>检测时间</dt><dd className="ce-number">{checkedText}</dd></div>}
      </dl>
      <div className="np-pop-hint">{check.hint}</div>
    </div>, root,
  )
}
