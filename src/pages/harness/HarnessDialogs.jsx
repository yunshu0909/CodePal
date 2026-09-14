/**
 * Harness 确认弹窗：转为托管、卸载
 *
 * 会改动系统服务或删除文件的操作先确认；「同时清除 ~/.dsh」是一次性选项，用 Checkbox 且默认不勾。
 *
 * @module pages/harness/HarnessDialogs
 */

import Button from '../../components/Button/Button'
import Checkbox from '../../components/Checkbox'
import Modal from '../../components/Modal/Modal'

const Mono = ({ children }) => <span className="harness-mono">{children}</span>

export function TakeoverDialog({ open, version, loading, onCancel, onConfirm }) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title="交给 CodePal 管理"
      size="sm"
      footer={(
        <>
          <Button variant="secondary" onClick={onCancel}>取消</Button>
          <Button variant="primary" loading={loading} onClick={onConfirm}>确认接管</Button>
        </>
      )}
    >
      <div className="harness-confirm">
        <p>CodePal 会另装一份托管运行时，再把系统服务切换过去。源码目录保持原样，不会被提交、暂存或删除。</p>
        <ul>
          <li>保留 <Mono>~/.dsh</Mono> 里的会话、凭证和模型配置</li>
          <li>只安装不低于 <Mono>{version || '当前源码版'}</Mono> 的版本，不会降级</li>
          <li>先备份 launchd 启动项，切换失败自动恢复原服务</li>
        </ul>
      </div>
    </Modal>
  )
}

export function UninstallDialog({ open, kind, purgeData, loading, onTogglePurge, onCancel, onConfirm }) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title="卸载 DeepSeek Harness"
      size="sm"
      footer={(
        <>
          <Button variant="secondary" onClick={onCancel}>取消</Button>
          <Button variant="danger" loading={loading} onClick={onConfirm}>确认卸载</Button>
        </>
      )}
    >
      <div className="harness-confirm">
        {kind === 'source' ? (
          <>
            <p>会先停止它，再移除 CodePal 识别到的启动项。</p>
            <ul>
              <li>启动项原文件先备份，需要时可以手动恢复</li>
              <li>源码目录不会删除</li>
            </ul>
          </>
        ) : (
          <p>将删除 CodePal 安装的 DeepSeek Harness，运行中的实例会先被停止。</p>
        )}
        {/* Checkbox 是纯展示的 div：由外层承担勾选框语义与键盘操作 */}
        <label
          className="harness-purge"
          role="checkbox"
          aria-checked={purgeData}
          tabIndex={0}
          onClick={onTogglePurge}
          onKeyDown={(event) => {
            if (event.key !== ' ' && event.key !== 'Enter') return
            event.preventDefault()
            onTogglePurge()
          }}
        >
          <Checkbox checked={purgeData} />
          <span className="harness-purge__text">
            <span className="harness-purge__title">同时清除 <Mono>~/.dsh</Mono></span>
            <span className="harness-purge__desc">会话历史、凭证和模型配置会一起删除，不可恢复</span>
          </span>
        </label>
      </div>
    </Modal>
  )
}
