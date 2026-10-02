/**
 * 新建项目页面（Native+，表单页 · 提交类）
 *
 * 负责：组装表单卡、会生成什么（目录树）与底部动作行；状态与动作在 useProjectInit。
 * 设计定稿：specs/v2.1.5-设计-新建项目/新建项目-定稿/（W1–W11）。
 *
 * @module pages/ProjectInitPage
 */

import PageShell from '../components/PageShell'
import Button from '../components/Button/Button'
import ProjectInitForm from './projectInit/ProjectInitForm'
import ProjectTree from './projectInit/ProjectTree'
import useProjectInit from './projectInit/useProjectInit'
import './projectInit/projectInit.css'

/**
 * 动作行左边那一句话
 */
function ActionMessage({ message, onCopy }) {
  if (!message) return <span />
  if (message.kind === 'ok' || message.kind === 'nocommit') {
    return (
      <span className={`np-actionbar-msg np-actionbar-msg--${message.kind === 'ok' ? 'ok' : 'warn'}`} data-testid="pi-message">
        <span className="pi-msg-line">
          <span className="pi-msg-path">已创建在 {message.path}</span>
          <Button size="sm" variant="ghost" className="np-btn-text" onClick={onCopy}>复制路径</Button>
        </span>
        {message.kind === 'nocommit'
          ? <span className="sub">Git 没配名字和邮箱，没做初始提交；配好后到项目里补一次</span>
          : null}
      </span>
    )
  }
  const cls = `np-actionbar-msg np-actionbar-msg--${message.kind === 'bad' ? 'bad' : 'hint'}`
  return <span className={cls} data-testid="pi-message">{message.text}</span>
}

/**
 * 新建项目页面
 * @returns {JSX.Element}
 */
export default function ProjectInitPage() {
  const state = useProjectInit()
  const fullPath = state.values.projectName.trim()
    ? `${state.values.targetPath.replace(/\/+$/, '')}/${state.values.projectName.trim()}`
    : ''

  return (
    <PageShell title="新建项目" native className="pi-page">
      <div className="np-scroll">
        <div className="np-glabel">基本信息</div>
        <ProjectInitForm {...state} />
        <div className="np-glabel">
          <span className="pi-glabel-title">会生成什么</span>
          {fullPath ? <span className="pi-path">{fullPath}</span> : null}
        </div>
        <ProjectTree projectName={state.values.projectName} gitMode={state.values.gitMode} codeDirName={state.values.codeDirName} />
        <div className="np-actionbar">
          <ActionMessage message={state.message} onCopy={state.copyPath} />
          <Button size="sm" variant="primary" className="np-btn" onClick={state.create} disabled={!state.canCreate}>
            {state.creating ? '创建中…' : '创建项目'}
          </Button>
        </div>
      </div>
    </PageShell>
  )
}
