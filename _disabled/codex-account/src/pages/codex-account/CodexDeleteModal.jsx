/**
 * 删除账户确认 Modal（M3）
 *
 * @module pages/codex-account/CodexDeleteModal
 */

import React, { useState } from 'react'
import Modal from '../../components/Modal/Modal'
import Button from '../../components/Button/Button'

export default function CodexDeleteModal({ open, name, onConfirm, onClose }) {
  const [deleting, setDeleting] = useState(false)

  const handleConfirm = async () => {
    setDeleting(true)
    await onConfirm(name)
    setDeleting(false)
  }

  return (
    <Modal
      open={open}
      onClose={deleting ? undefined : onClose}
      title={`删除账户 ${name}？`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={deleting}>取消</Button>
          <Button
            variant="primary"
            onClick={handleConfirm}
            loading={deleting}
            style={{ background: '#dc2626', borderColor: '#dc2626' }}
          >
            删除
          </Button>
        </>
      }
    >
      <p style={{ fontSize: 13, color: '#5a6070', lineHeight: 1.7 }}>
        这会从 CodePal 里移除这个账户的凭证快照。<br />
        Codex 的对话历史保留在本地，不会丢失。
      </p>
      <div className="codex-modal-warn">
        ⓘ 凭证文件会自动备份到 <code style={{ fontSize: 11 }}>~/.codex-switcher/backups/</code>，
        7 天内可手动恢复。如果你还想再用这个账户，直接在 Codex 里重新登录即可。
      </div>
    </Modal>
  )
}
