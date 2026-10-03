/**
 * Skill 管理页右栏：收进记录（装载总览「收进记录 N 次」进入，照定稿 C19、C24）
 *
 * 负责：
 * - 每次收进一行：名字、从哪收进、什么时候；按状态给按钮或原因——可撤回 / 先撤上面那次 / 没做完（继续恢复）/
 *   撤不了（原因）/ 资产库已删（撤回只放回原件）/ 已撤回（变浅、写时间、没有按钮）
 * - 和详情里的最近收进卡用同一份状态（快照 operations）；离开页面、重启后照样在
 *
 * @module pages/skills/RecentOpsView
 */

import React from 'react'
import Button from '../../components/Button/Button'
import { copyLabel, formatOpTime, undoReasonText } from './skillsModel'

const LIVE = new Set(['undoable', 'library-deleted', 'partial'])

/**
 * @param {object} props
 * @param {object[]} props.operations - 快照 operations（时间从晚到早）
 * @param {Set<string>} props.pendingKeys
 * @param {(op: object) => void} props.onUndo
 * @param {(op: object) => void} props.onResume
 * @returns {JSX.Element}
 */
export default function RecentOpsView({ operations, pendingKeys, onUndo, onResume }) {
  const live = operations.filter((op) => LIVE.has(op.state)).length
  return (
    <div className="np-pane np-pane--detail">
      <div className="np-pane-hd">
        <h2 className="ttl">收进记录</h2>
        <div className="meta"><span>{operations.length} 次，其中 {live} 次现在能撤回或要继续恢复 · 没撤回的原件在备份里；同一个名字先撤后一次</span></div>
      </div>
      <div className="np-pane-body">
        <div className="np-card np-card--form">
          {operations.map((op) => {
            const from = copyLabel({ toolId: op.from?.toolId, scope: op.from?.scope, projectName: op.from?.projectName })
            const busy = pendingKeys.has(`${op.name}:undo:${op.operationId}`) || pendingKeys.has(`${op.name}:resume:${op.operationId}`)
            let note = null
            let action = null
            if (op.state === 'undone') {
              note = <div className="ds">已撤回 · {formatOpTime(op.undoneAt, { todayPrefix: true })}</div>
            } else if (op.state === 'waiting') {
              note = <div className="ds">先撤回上面那次</div>
              action = <Button size="sm" className="np-btn" disabled>撤回</Button>
            } else if (op.state === 'partial') {
              note = <div className="ds bad">上次没做完，还有一部分没恢复{op.reason ? `；停在这一步：${undoReasonText(op.reason, op.from?.toolId)}` : ''}</div>
              action = <Button size="sm" className="np-btn" onClick={() => onResume(op)} disabled={busy}>{busy ? '恢复中…' : '继续恢复'}</Button>
            } else if (op.state === 'blocked') {
              note = <div className="ds bad">{undoReasonText(op.reason, op.from?.toolId)}</div>
              action = <Button size="sm" className="np-btn" disabled>撤回</Button>
            } else {
              if (op.state === 'library-deleted') note = <div className="ds">资产库里已经删了；撤回只把原件放回原处</div>
              action = <Button size="sm" className="np-btn" onClick={() => onUndo(op)} disabled={busy}>{busy ? '撤回中…' : '撤回'}</Button>
            }
            return (
              <div key={op.operationId} className={`np-row sk-prow${op.state === 'undone' ? ' sk-dim' : ''}`}>
                <div className="lf">
                  <div className="lb">{op.name}</div>
                  <div className="ds">从 {from} 收进 · {formatOpTime(op.at, { todayPrefix: true })}</div>
                  {note}
                </div>
                {action && <span className="acts">{action}</span>}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
