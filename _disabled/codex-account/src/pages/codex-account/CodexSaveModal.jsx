/**
 * 新账户保存 Modal（M1）
 *
 * 触发时机：
 * - chokidar 推送了"新账户检测"
 * - 或用户点未保存卡的"保存为账户"
 *
 * @module pages/codex-account/CodexSaveModal
 */

import React, { useEffect, useState } from 'react'
import Modal from '../../components/Modal/Modal'
import Button from '../../components/Button/Button'

const NAME_REGEX = /^[A-Za-z0-9._-]{1,64}$/

/**
 * @param {object} props
 * @param {boolean} props.open
 * @param {object} props.payload - { email, plan, suggestedName }
 * @param {(name: string) => Promise<{success, error?}>} props.onConfirm
 * @param {() => void} props.onClose - 用户点忽略 / 遮罩 / ESC
 */
export default function CodexSaveModal({ open, payload, onConfirm, onClose }) {
  const [name, setName] = useState('')
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      setName(payload?.suggestedName || '')
      setErr('')
      setSaving(false)
    }
  }, [open, payload])

  const handleSave = async () => {
    const v = name.trim()
    if (!NAME_REGEX.test(v)) {
      setErr('名字只能是字母/数字/下划线/点/连字符，1-64 字符')
      return
    }
    setSaving(true)
    const r = await onConfirm(v)
    setSaving(false)
    if (!r?.success) {
      setErr(mapError(r?.error))
      return
    }
    // 成功由上层关 Modal
  }

  return (
    <Modal
      open={open}
      onClose={saving ? undefined : onClose}
      title="检测到新的 Codex 账户"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>忽略</Button>
          <Button variant="primary" onClick={handleSave} loading={saving}>保存账户</Button>
        </>
      }
    >
      <p style={{ fontSize: 13, color: '#5a6070', lineHeight: 1.7 }}>
        你刚刚在 Codex 里登录了一个之前没保存过的账户：
      </p>
      <p style={{ fontSize: 13, color: '#1a1d23', marginTop: 6, fontWeight: 600 }}>
        {payload?.email}
        {payload?.plan && payload.plan !== 'unknown'
          ? <span style={{ marginLeft: 8, color: '#5a6070', fontWeight: 400 }}>（{formatPlan(payload.plan)}）</span>
          : null}
      </p>
      <p style={{ fontSize: 13, color: '#5a6070', marginTop: 10, lineHeight: 1.7 }}>
        保存后以后就能切换并重启到这个账户。
      </p>

      <label className="codex-modal-input-label">账户名</label>
      <input
        className="codex-modal-input"
        value={name}
        onChange={(e) => { setName(e.target.value); setErr('') }}
        disabled={saving}
        autoFocus
      />
      <div className="codex-modal-help">只能用字母、数字、下划线、点号、连字符，最长 64 字符</div>
      {err && <div className="codex-modal-err">{err}</div>}
    </Modal>
  )
}

function mapError(code) {
  switch (code) {
    case 'NAME_EXISTS': return '这个名字已被占用，换一个'
    case 'INVALID_NAME': return '名字不符合格式要求'
    case 'AUTH_JSON_NOT_FOUND': return '未检测到 Codex 登录，请先登录 Codex'
    default: return code ? `保存失败：${code}` : '保存失败，请稍后再试'
  }
}

function formatPlan(plan) {
  return plan.charAt(0).toUpperCase() + plan.slice(1)
}
