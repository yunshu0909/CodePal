/**
 * Claude statusLine 接管确认弹窗
 *
 * 负责：
 * - 说明接管会备份并替换用户现有 statusLine
 * - 用二次确认区分“查看说明”和“实际写配置”
 * - 接管失败时保持弹窗打开，交由页面 Toast 提示
 *
 * @module pages/usage/components/ClaudeStatusLineTakeoverModal
 */

import Modal from '../../../components/Modal/Modal'
import Button from '../../../components/Button/Button'
import './ClaudeStatusLineTakeoverModal.css'

/**
 * @param {object} props
 * @param {boolean} props.open - 是否打开
 * @param {boolean} props.loading - 接管是否进行中
 * @param {() => void} props.onClose - 取消/关闭
 * @param {() => Promise<boolean>} props.onConfirm - 明确确认后的接管动作
 * @returns {JSX.Element}
 */
export default function ClaudeStatusLineTakeoverModal({ open, loading = false, onClose, onConfirm }) {
  const handleClose = () => {
    if (!loading) onClose?.()
  }

  const handleConfirm = async () => {
    const ok = await onConfirm?.()
    if (ok) onClose?.()
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="接管 Claude statusLine"
      size="sm"
      closeOnOverlay={!loading}
      showCloseButton={!loading}
      footer={
        <>
          <Button variant="secondary" onClick={handleClose} disabled={loading}>取消</Button>
          <Button variant="primary" onClick={handleConfirm} loading={loading}>
            {loading ? '接管中...' : '确认接管'}
          </Button>
        </>
      }
    >
      <div className="claude-takeover-copy">
        <p>当前检测到自定义 statusLine。继续后 CodePal 将：</p>
        <ol>
          <li>备份现有 Claude settings.json</li>
          <li>把 statusLine 替换为 CodePal 管理脚本</li>
          <li>后续脚本升级由 CodePal 静默维护</li>
        </ol>
        <div className="claude-takeover-copy__note">此操作不会自动执行；只有点击“确认接管”才会修改配置。</div>
      </div>
    </Modal>
  )
}
