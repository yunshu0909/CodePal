/**
 * 新增账户引导 Modal（M4）
 *
 * 用户点页头 [+ 新增账户] 时弹出，引导用户走 Codex 登录流程。
 * 实际"保存"由 chokidar 监听自动触发。
 *
 * @module pages/codex-account/CodexAddHelpModal
 */

import React from 'react'
import Modal from '../../components/Modal/Modal'
import Button from '../../components/Button/Button'

export default function CodexAddHelpModal({ open, onOpenCodex, onClose }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="新增 Codex 账户"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={onOpenCodex}>打开 Codex</Button>
        </>
      }
    >
      <p style={{ fontSize: 13, color: '#5a6070', lineHeight: 1.7 }}>
        CodePal 通过监听 <code style={{ fontSize: 11, background: '#f8f9fb', padding: '1px 4px', borderRadius: 3 }}>
          ~/.codex/auth.json
        </code> 自动发现新账户。
      </p>
      <ol style={{ margin: '12px 0', paddingLeft: 20, fontSize: 13, color: '#5a6070', lineHeight: 1.9 }}>
        <li>点下方"打开 Codex"</li>
        <li>在 Codex 里点 Logout（若已登录），然后用新账户登录</li>
        <li>登录成功后回到这里，会自动弹出"保存账户"提示</li>
      </ol>
      <div className="codex-modal-warn" style={{ background: '#eff6ff', borderColor: '#bfdbfe', color: '#2563eb' }}>
        ⓘ 登录新账户前请先切到一个已保存的账户（避免当前会话的 token 丢失）。
      </div>
    </Modal>
  )
}
