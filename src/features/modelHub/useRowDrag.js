/**
 * 审核在用的拖动排序（状态清单 C6、E2；后-15 整串保存）
 *
 * - 按住把手：这一行浮起，按鼠标纵坐标算出放下的位置（蓝线）；松手把整串新顺序交给 onCommit
 * - 拖动中按 Esc：放回原位，不保存
 * - 把手上按 ↑ ↓：一次移一位，马上保存；首尾不越界
 * - disabled（保存中）时什么都不做
 *
 * 只管交互和位置计算，不碰数据与保存；行的位置读 rowRef 登记的元素。
 *
 * @module features/modelHub/useRowDrag
 */
import { useCallback, useEffect, useRef, useState } from 'react'

/** 把 from 位置的一项挪到 to 位置，返回新数组 */
export function move(list, from, to) {
  const next = [...list]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

/**
 * @param {string[]} ids 当前顺序
 * @param {{onCommit: (order: string[]) => void, disabled?: boolean}} options
 * @returns {{rowRef: Function, gripProps: Function, dragging: string|null, dropIndex: number|null}}
 */
export default function useRowDrag(ids, { onCommit, disabled = false }) {
  const rows = useRef(new Map())
  const [drag, setDrag] = useState(null)

  const rowRef = useCallback(
    (id) => (el) => {
      if (el) rows.current.set(id, el)
      else rows.current.delete(id)
    },
    [],
  )

  /** 放下位置 = 其余行里中线在鼠标上方的行数 */
  const indexAt = useCallback(
    (id, clientY) => {
      let index = 0
      for (const other of ids) {
        if (other === id) continue
        const rect = rows.current.get(other)?.getBoundingClientRect()
        if (rect && rect.top + rect.height / 2 < clientY) index += 1
      }
      return index
    },
    [ids],
  )

  useEffect(() => {
    if (!drag) return undefined
    const onMove = (event) => setDrag((current) => current && { ...current, index: indexAt(current.id, event.clientY) })
    const onUp = (event) => {
      setDrag(null)
      const from = ids.indexOf(drag.id)
      const to = indexAt(drag.id, event.clientY)
      if (from !== -1 && to !== from) onCommit(move(ids, from, to))
    }
    const onKey = (event) => {
      if (event.key === 'Escape') setDrag(null)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.removeEventListener('keydown', onKey)
    }
  }, [drag, ids, indexAt, onCommit])

  const gripProps = (id) => ({
    disabled,
    onMouseDown: (event) => {
      if (disabled || event.button !== 0) return
      event.preventDefault()
      setDrag({ id, index: ids.indexOf(id) })
    },
    onKeyDown: (event) => {
      if (disabled || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
      event.preventDefault()
      const from = ids.indexOf(id)
      const to = from + (event.key === 'ArrowUp' ? -1 : 1)
      if (from === -1 || to < 0 || to >= ids.length) return
      onCommit(move(ids, from, to))
    },
  })

  return { rowRef, gripProps, dragging: drag?.id ?? null, dropIndex: drag?.index ?? null }
}
