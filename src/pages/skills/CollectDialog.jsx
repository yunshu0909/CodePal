/**
 * 收进确认框（照定稿 specs/v2.1.10-Skills要处理与收进/Skills要处理-定稿/ C1、C4、C13–C15）
 *
 * 负责：
 * - 标题「收进 名字（工具 · 位置）？」；不一样时先选留哪份（两个选项写明各影响哪个工具），没选时「收进」灰
 * - Codex 改过的那份加一句提醒，不预选；第一次收进写明会新建资产库；全局位置被占着时写「收不了」、收进灰
 * - 列出要发生的事：放进资产库 / 资产库里已经有一样的；在哪个工具里打开；原件怎么处理（能撤回）
 * - 结果：内容刚变了 → 清空选择、写一句请重新选；可重试的失败 → 留着选择、写原因；其余交给页面关框并提示
 * 用现有 Modal（size=sm）+ Button；进行中不能关。
 *
 * @module pages/skills/CollectDialog
 */

import React, { useState } from 'react'
import Modal from '../../components/Modal/Modal'
import Button from '../../components/Button/Button'
import { copyLabel, toolLabelOf } from './skillsModel'

const RETRY_REASON = {
  SOURCE_BUSY: '原件正被别的程序占用',
  EBUSY: '原件正被别的程序占用',
  PERMISSION_DENIED: '没有权限',
  EACCES: '没有权限',
  EPERM: '没有权限',
  SOURCE_NOT_FOUND: '找不到这一份',
  OPERATION_PARTIAL: '这个 Skill 上次的操作还没做完',
}

/**
 * @param {object} props
 * @param {{name: string, relation: string, linkedTools?: string[]}} props.item
 * @param {object} props.copy - 要收进的那一份
 * @param {boolean} props.firstCollect - 资产库还不存在
 * @param {string} props.libraryDisplay - 资产库位置（~ 写法）
 * @param {() => void} props.onCancel
 * @param {(keep: 'library'|'source'|undefined) => Promise<{close: boolean, notice?: object}>} props.onConfirm
 *   页面执行命令后告诉确认框关不关；不关时带 notice：{ kind: 'changed' }、{ kind: 'blocked' } 或 { kind: 'retry', code }
 * @returns {JSX.Element}
 */
export default function CollectDialog({ item, copy, firstCollect, libraryDisplay, onCancel, onConfirm }) {
  const [pick, setPick] = useState(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState(null)
  const tool = toolLabelOf(copy.toolId)
  const diff = copy.relation === 'diff'
  const others = (item.linkedTools || []).filter((toolId) => toolId !== copy.toolId).map(toolLabelOf)
  // 全局位置被占：读快照时就知道的，或点收进后主进程核对出来的
  const blocked = Boolean(copy.blockedBy) || notice?.kind === 'blocked'

  const lines = []
  if (firstCollect) lines.push(`第一次收进：会新建资产库 ${libraryDisplay || '~/Documents/SkillManager/'}`)
  if (copy.relation === 'none') lines.push('放进资产库')
  else if (copy.relation === 'same') lines.push('资产库里已经有一样的，不再放一份')
  lines.push(`在 ${tool} 里打开，之后 ${tool} 的所有项目都能用`)
  lines.push(copy.scope === 'project'
    ? `原件从 ${copy.projectName} 项目移走，放进备份，能撤回`
    : '原件换成指向资产库的链接，旧内容放进备份，能撤回')

  const confirm = async () => {
    setBusy(true)
    setNotice(null)
    const result = await onConfirm(diff ? pick : undefined)
    setBusy(false)
    if (result?.close) return
    if (result?.notice?.kind === 'changed') setPick(null)
    setNotice(result?.notice || null)
  }

  const option = (key, title, ds) => (
    <div
      className={`sk-opt${pick === key ? ' on' : ''}`}
      role="radio"
      aria-checked={pick === key}
      tabIndex={0}
      onClick={() => { if (!busy) setPick(key) }}
      onKeyDown={(event) => { if (event.key === 'Enter' && !busy) setPick(key) }}
    >
      <span className="sk-radio" />
      <div><b>{title}</b><div className="ds">{ds}</div></div>
    </div>
  )

  let message = null
  if (blocked) {
    message = <p className="sk-err">收不了：{toolLabelOf(copy.blockedBy?.toolId || copy.toolId)} 全局目录里已经有一份自己的 {item.name}，先处理那一份</p>
  } else if (notice?.kind === 'changed') {
    message = <p className="sk-err">内容刚变了，上面已经按现在的样子更新，请重新选</p>
  } else if (notice?.kind === 'retry') {
    message = <p className="sk-err">没有收进：{RETRY_REASON[notice.code] || '出了点问题'}。选好的还在，可以再试一次</p>
  }

  return (
    <Modal
      open
      onClose={() => { if (!busy) onCancel() }}
      title={`收进 ${item.name}（${copyLabel(copy)}）？`}
      size="sm"
      closeOnOverlay={!busy}
      showCloseButton={false}
      footer={(
        <>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>取消</Button>
          <Button variant="primary" onClick={confirm} disabled={busy || blocked || (diff && !pick)}>{busy ? '收进中…' : '收进'}</Button>
        </>
      )}
    >
      <div className="sk-dlg">
        {diff && (
          <>
            <p className="sk-dlg-q">资产库里已经有一份内容不一样的，留哪一份？</p>
            {option('library', '留资产库里的', `原件放进备份，${tool} 改用资产库里的`)}
            {option('source', '换成这一份', `资产库里的被换掉${others.length > 0 ? `；${others.join('、')} 也会改用这一份` : ''}`)}
            {copy.adaptedHint && (
              <p className="sk-warn">这一份可能为 Codex 改过工具名或路径，两种选法都可能让某个工具用不了。拿不准就取消，原件留在项目里。</p>
            )}
          </>
        )}
        <ul className="sk-ul">{lines.map((line) => <li key={line}>{line}</li>)}</ul>
        {message}
      </div>
    </Modal>
  )
}
