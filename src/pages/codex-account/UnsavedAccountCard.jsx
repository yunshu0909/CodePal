/**
 * 未保存激活账户卡（列表首位常驻）
 *
 * 用户在 Codex 登录新账户后点了"忽略"的场景：auth.json 存在、account_id
 * 未归属任何已保存账户。卡片提供"保存为账户"/"暂不保存"两个动作。
 *
 * @module pages/codex-account/UnsavedAccountCard
 */

import React from 'react'
import Button from '../../components/Button/Button'

/**
 * @param {object} props
 * @param {object} props.unsavedActive - { email, plan }
 * @param {() => void} props.onSaveClick
 * @param {() => void} props.onIgnore
 */
export default function UnsavedAccountCard({ unsavedActive, onSaveClick, onIgnore }) {
  const { email, plan } = unsavedActive || {}
  const planLabel = displayPlan(plan)

  return (
    <div className="codex-card codex-card--unsaved">
      <div className="codex-card__head">
        <div className="codex-card__identity">
          <div className="codex-card__name">未保存账户</div>
          <div className="codex-card__email" title={email}>{email}</div>
        </div>
        {planLabel && <span className="codex-plan-tag codex-plan-tag--unknown">{planLabel}</span>}
      </div>

      <div className="codex-unsaved-hint">
        Codex 当前正在用这个账户，但还没有加到切换列表。保存后就能切换并重启到这个账户。
      </div>

      <div className="codex-card__footer">
        <Button variant="primary" size="sm" onClick={onSaveClick}>保存为账户</Button>
        <Button variant="ghost" size="sm" onClick={onIgnore}>暂不保存</Button>
      </div>
    </div>
  )
}

function displayPlan(plan) {
  if (!plan || plan === 'unknown') return null
  return plan.charAt(0).toUpperCase() + plan.slice(1)
}
