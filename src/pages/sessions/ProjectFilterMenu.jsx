/**
 * 对话回顾 · 项目筛选弹出按钮与下拉菜单
 *
 * 负责：
 * - 弹出按钮显示当前项目名或「全部项目」
 * - 菜单：全部项目 / 各项目（上级目录 · N 个对话）/ 显示自动调用的对话（可勾选）
 * - 点任一项即生效并关闭；点菜单外或按 Esc 关闭
 *
 * @module pages/sessions/ProjectFilterMenu
 */

import { useEffect, useRef, useState } from 'react'

const CHEV = <svg className="chev" viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 4 5 6.5 7.5 4" /></svg>

/**
 * 项目筛选
 * @param {Object} props
 * @param {Array<{projectPath: string, projectName: string, parentDir: string, count: number}>} props.menu - 项目菜单数据
 * @param {{projectPath: string|null, includeAuto: boolean}} props.filter - 当前筛选
 * @param {(patch: object) => void} props.onChange - 改筛选
 * @returns {JSX.Element}
 */
export default function ProjectFilterMenu({ menu, filter, onChange }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)
  const current = menu.find((m) => m.projectPath === filter.projectPath)

  // 点菜单外、按 Esc 关闭
  useEffect(() => {
    if (!open) return undefined
    const onDown = (e) => { if (!wrapRef.current?.contains(e.target)) setOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) } }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const choose = (patch) => {
    onChange(patch)
    setOpen(false)
  }

  return (
    <span className="sr-pop" ref={wrapRef}>
      <button type="button" className="np-popbtn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {current ? current.projectName : '全部项目'}
        {CHEV}
      </button>
      {open && (
        <div className="np-menu sr-menu" role="menu">
          <button type="button" role="menuitem" className="np-mitem" onClick={() => choose({ projectPath: null })}>
            <span className="tx"><b>全部项目</b></span>
            <span className="ck">{current ? '' : '✓'}</span>
          </button>
          <div className="np-msep" />
          {menu.map((m) => (
            <button key={m.projectPath} type="button" role="menuitem" className="np-mitem" title={m.projectPath} onClick={() => choose({ projectPath: m.projectPath })}>
              <span className="tx"><b>{m.projectName}</b><span>{`${m.parentDir} · ${m.count} 个对话`}</span></span>
              <span className="ck">{current?.projectPath === m.projectPath ? '✓' : ''}</span>
            </button>
          ))}
          <div className="np-msep" />
          <button type="button" role="menuitemcheckbox" aria-checked={filter.includeAuto} className="np-mitem" onClick={() => choose({ includeAuto: !filter.includeAuto })}>
            <span className="tx"><b>显示自动调用的对话</b><span>插件、脚本在后台调用 Claude Code 产生的</span></span>
            <span className="ck">{filter.includeAuto ? '✓' : ''}</span>
          </button>
        </div>
      )}
    </span>
  )
}
