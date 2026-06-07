/**
 * V1.7 单个账户卡
 *
 * 与 V1.6 CodexAccountCard 的差异：
 * - 三档状态徽章（CodexStatusBadgeV17）替代旧的 plan + expired
 * - "切换"按钮直接切（不重启 Codex.app）；切换语义 = 改 active.json 指针
 * - 黄/红状态时主操作变"立即重新验证"
 * - ⋯ 菜单：重命名 / 删除（删除走冷备份 90 天）
 * - 红色不再"凭证已失效"卡死，而是引导用户在 CodePal 内重新登录（如未来 UI 接 beginLogin）
 *
 * @module pages/codex-account/CodexAccountCardV17
 */

import React, { useEffect, useRef, useState } from 'react'
import Button from '../../components/Button/Button'
import CodexStatusBadgeV17 from './CodexStatusBadgeV17'

/**
 * @param {object} props
 * @param {{ name: string, email: string, plan: string, accountId: string, active: boolean, status: object }} props.account
 * @param {boolean} props.isSwitching
 * @param {(name: string) => Promise<void>} props.onSwitch
 * @param {(name: string) => Promise<void>} props.onRefresh   - 立即重新验证（force refresh）
 * @param {(name: string) => void} props.onRename
 * @param {(name: string) => void} props.onDelete
 * @param {(name: string) => void} props.onReloginPrompt      - 引导用户在 CodePal 内重登（开启 beginLogin 闭环；红卡专用）
 */
export default function CodexAccountCardV17({
  account,
  isSwitching = false,
  onSwitch,
  onRefresh,
  onRename,
  onDelete,
  onReloginPrompt,
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef(null)

  useEffect(() => {
    if (!menuOpen) return
    const handleClick = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false)
    }
    document.addEventListener('click', handleClick)
    return () => document.removeEventListener('click', handleClick)
  }, [menuOpen])

  const { name, email, plan, active, status } = account
  const color = status?.color ?? 'yellow'

  const cardCls = [
    'codex-card',
    active && color !== 'red' ? 'codex-card--active' : '',
    isSwitching ? 'codex-card--switching' : '',
    color === 'red' ? 'codex-card--error' : '',
  ].filter(Boolean).join(' ')

  return (
    <div className={cardCls}>
      <div className="codex-card__head">
        <div className="codex-card__identity">
          <div className="codex-card__name" title={name}>{name}</div>
          <div className="codex-card__email" title={email}>{email || '—'}</div>
        </div>
        <CodexStatusBadgeV17 status={status} />
      </div>

      <div className="codex-card__meta">
        <span className="codex-card__meta-label">套餐</span>
        <span className="codex-card__meta-value">{planDisplay(plan)}</span>
      </div>

      <div className="codex-card__footer">
        {renderFooterMain({ active, color, name, isSwitching, onSwitch, onRefresh, onReloginPrompt })}
        <div className="codex-card__menu" ref={menuRef}>
          <button
            className="codex-btn-menu"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="更多操作"
            disabled={isSwitching}
          >⋯</button>
          {menuOpen && (
            <div className="codex-menu-popup">
              <button
                className="codex-menu-item"
                onClick={() => { setMenuOpen(false); onRefresh?.(name) }}
              >立即重新验证</button>
              <button
                className="codex-menu-item"
                onClick={() => { setMenuOpen(false); onRename?.(name) }}
              >重命名</button>
              <button
                className="codex-menu-item codex-menu-item--danger"
                onClick={() => { setMenuOpen(false); onDelete?.(name) }}
              >删除账户</button>
            </div>
          )}
        </div>
      </div>

      {isSwitching && (
        <div className="codex-switching-overlay">
          <span className="codex-spinner" />
          <span>切换中…</span>
        </div>
      )}
    </div>
  )
}

function renderFooterMain({ active, color, name, isSwitching, onSwitch, onRefresh, onReloginPrompt }) {
  if (active) {
    return <span className="codex-card__status codex-card__status--active">当前使用中</span>
  }
  if (color === 'red') {
    return (
      <Button variant="secondary" size="sm" onClick={() => onReloginPrompt?.(name)}>
        在 CodePal 内重新登录
      </Button>
    )
  }
  if (color === 'yellow') {
    return (
      <Button variant="secondary" size="sm" disabled={isSwitching} onClick={() => onSwitch?.(name)}>
        切换 · 立即验证
      </Button>
    )
  }
  return (
    <Button variant="primary" size="sm" disabled={isSwitching} onClick={() => onSwitch?.(name)}>
      切换
    </Button>
  )
}

function planDisplay(plan) {
  if (!plan || plan === 'unknown') return '—'
  return plan.charAt(0).toUpperCase() + plan.slice(1)
}
