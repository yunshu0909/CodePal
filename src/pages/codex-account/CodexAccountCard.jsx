/**
 * Codex 单个账户卡
 *
 * 负责：
 * - 展示账户名、email、套餐、5h/7d 倒计时、上次切入时间
 * - 区分激活态 / 失效态 / 切换中态 / dim 态
 * - 提供"切换并重启"按钮 + [⋯] 更多操作（重命名 / 删除 / 重新登录）
 *
 * @module pages/codex-account/CodexAccountCard
 */

import React, { useEffect, useRef, useState } from 'react'
import Button from '../../components/Button/Button'
import { fiveHourWindowText, sevenDayWindowText, lastSwitchText } from './codexTimeFormat'

/**
 * 单卡渲染
 * @param {object} props
 * @param {object} props.account - { name, email, plan, expired, lastSwitchAt }
 * @param {boolean} props.isActive
 * @param {boolean} props.isSwitching
 * @param {boolean} props.dim
 * @param {(targetName: string) => void} props.onSwitch
 * @param {(name: string) => void} props.onRename
 * @param {(name: string) => void} props.onDelete
 * @param {(name: string) => void} props.onReLogin
 */
export default function CodexAccountCard({
  account,
  isActive = false,
  isSwitching = false,
  dim = false,
  onSwitch,
  onRename,
  onDelete,
  onReLogin,
}) {
  // 更多操作菜单是否展开
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

  const { name, email, plan, expired, lastSwitchAt } = account

  const cardCls = [
    'codex-card',
    isActive && !expired ? 'codex-card--active' : '',
    isSwitching ? 'codex-card--switching' : '',
    dim ? 'codex-card--dim' : '',
    expired ? 'codex-card--error' : '',
  ].filter(Boolean).join(' ')

  const fiveH = fiveHourWindowText(lastSwitchAt)
  const sevenD = sevenDayWindowText(lastSwitchAt)

  return (
    <div className={cardCls}>
      <div className="codex-card__head">
        <div className="codex-card__identity">
          <div className="codex-card__name" title={name}>{name}</div>
          <div className="codex-card__email" title={email}>{email}</div>
        </div>
        {renderPlanTag(plan, expired)}
      </div>

      <div className="codex-card__windows">
        <div className="codex-window-row">
          <span className="codex-window-row__label">5 小时窗口</span>
          <span className={`codex-window-row__value${fiveH.urgent ? ' codex-window-row__value--urgent' : ''}`}>
            {expired ? '—' : fiveH.text}
          </span>
        </div>
        <div className="codex-window-row">
          <span className="codex-window-row__label">7 天窗口</span>
          <span className="codex-window-row__value">
            {expired ? '—' : sevenD.text}
          </span>
        </div>
      </div>

      <div className="codex-card__meta">
        <span className="codex-card__meta-label">上次切入</span>
        <span className="codex-card__meta-value">{lastSwitchText(lastSwitchAt)}</span>
      </div>

      <div className="codex-card__footer">
        {renderFooterMain({ isActive, expired, onSwitch, onReLogin, name })}
        <div className="codex-card__menu" ref={menuRef}>
          <button
            className="codex-btn-menu"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="更多操作"
            disabled={isSwitching}
          >⋯</button>
          {menuOpen && (
            <div className="codex-menu-popup">
              {expired ? (
                <button
                  className="codex-menu-item"
                  onClick={() => { setMenuOpen(false); onReLogin?.(name) }}
                >重新登录此账户</button>
              ) : (
                <button
                  className="codex-menu-item"
                  onClick={() => { setMenuOpen(false); onRename?.(name) }}
                >重命名</button>
              )}
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

function renderFooterMain({ isActive, expired, onSwitch, onReLogin, name }) {
  if (expired) {
    // V1.6.2 修复 C4：失效卡片把"重新登录"按钮放到主区域显眼位置
    return (
      <Button variant="danger" size="sm" onClick={() => onReLogin?.(name)}>
        重新登录
      </Button>
    )
  }
  if (isActive) {
    return <span className="codex-card__status codex-card__status--active">当前使用中</span>
  }
  return (
    <Button variant="secondary" size="sm" onClick={() => onSwitch?.(name)}>
      切换并重启
    </Button>
  )
}

function renderPlanTag(plan, expired) {
  if (expired) return <span className="codex-plan-tag codex-plan-tag--danger">已失效</span>
  const known = ['plus', 'pro', 'team', 'free']
  const cls = known.includes(plan)
    ? `codex-plan-tag codex-plan-tag--${plan}`
    : 'codex-plan-tag codex-plan-tag--unknown'
  return <span className={cls}>{planDisplay(plan)}</span>
}

function planDisplay(plan) {
  if (!plan || plan === 'unknown') return '—'
  return plan.charAt(0).toUpperCase() + plan.slice(1)
}
