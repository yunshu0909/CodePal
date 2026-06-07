/**
 * 账户重命名 Modal（M2）
 *
 * @module pages/codex-account/CodexRenameModal
 */

import React, { useEffect, useState } from 'react'
import Modal from '../../components/Modal/Modal'
import Button from '../../components/Button/Button'

const NAME_REGEX = /^[A-Za-z0-9._-]{1,64}$/

export default function CodexRenameModal({ open, oldName, onConfirm, onClose }) {
  const [name, setName] = useState('')
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      setName(oldName || '')
      setErr('')
      setSaving(false)
    }
  }, [open, oldName])

  const handleSave = async () => {
    const v = name.trim()
    if (!NAME_REGEX.test(v)) {
      setErr('名字只能是字母/数字/下划线/点/连字符，1-64 字符')
      return
    }
    if (v === oldName) { onClose?.(); return }

    setSaving(true)
    const r = await onConfirm(oldName, v)
    setSaving(false)
    if (!r?.success) {
      setErr(mapError(r?.error))
      return
    }
  }

  return (
    <Modal
      open={open}
      onClose={saving ? undefined : onClose}
      title="重命名账户"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>取消</Button>
          <Button variant="primary" onClick={handleSave} loading={saving}>保存</Button>
        </>
      }
    >
      <p style={{ fontSize: 13, color: '#5a6070', lineHeight: 1.7 }}>
        当前名字：<strong style={{ color: '#1a1d23' }}>{oldName}</strong>
      </p>
      <p style={{ fontSize: 13, color: '#5a6070', lineHeight: 1.7, marginTop: 4 }}>
        改名不会影响 Codex 本身，只改 CodePal 显示用的别名。
      </p>

      <label className="codex-modal-input-label">新名字</label>
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
    case 'NAME_EXISTS': return '这个名字已被占用'
    case 'INVALID_NAME': return '名字不符合格式要求'
    case 'ACCOUNT_NOT_FOUND': return '账户不存在（可能已被删除）'
    default: return code ? `重命名失败：${code}` : '重命名失败'
  }
}
