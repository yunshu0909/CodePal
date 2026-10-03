/**
 * Skill 管理页右栏：「要处理」里一个名字的详情（照定稿 specs/v2.1.10-Skills要处理与收进/Skills要处理-定稿/）
 *
 * 负责：
 * - 栏头：名字 +「要处理 · 和资产库的关系 · N 份」
 * - 最近收进卡（RecentCard，也给资产库已有的详情用）：可撤回 / 撤不了带原因 / 没做完带继续恢复 / 撤回中；
 *   这个名字处理完时多「下一个要处理」
 * - 要处理的副本：每份在哪、完整路径、和资产库的关系、差在哪些文件（先列 4 个，可点开全部）、收进 / 忽略；
 *   同名都不在资产库时标「这 N 份内容一样 / 不一样」
 * - 启用：资产库已有时用资产库那份的开关（占位原因见 SkillDetail 的 ToolRow）；资产库没有时只写在哪能用和装载状态，
 *   不给开关（「要什么」：页面上能操作的只剩资产库里的 Skill）
 * - 没做完时这个名字的收进、忽略、开关都先停着
 *
 * @module pages/skills/InboxDetail
 */

import React, { useState } from 'react'
import Button from '../../components/Button/Button'
import { ToolIcon, ToolRow } from './SkillDetail'
import { RELATION_TEXT, TOOLS, copyLabel, diffFiles, diffSummary, formatOpTime, undoReasonText } from './skillsModel'

const LOAD_TEXT = { loaded: '装载中', disabled: '已停用', unknown: '状态未知' }

/**
 * 最近收进卡
 * @param {object} props
 * @param {object} props.op - 快照 operations 里的一条
 * @param {boolean} props.busy - 撤回 / 继续恢复进行中
 * @param {boolean} props.showNext - 这个名字处理完了、要处理里还有别的
 * @param {() => void} props.onUndo
 * @param {() => void} props.onResume
 * @param {() => void} props.onNext
 * @returns {JSX.Element}
 */
export function RecentCard({ op, busy, showNext, onUndo, onResume, onNext }) {
  const time = formatOpTime(op.at)
  const from = copyLabel({ toolId: op.from?.toolId, scope: op.from?.scope, projectName: op.from?.projectName })
  if (op.state === 'partial') {
    return (
      <div className="np-card np-card--form sk-recent">
        <div className="np-row">
          <div className="lf">
            <div className="lb">{op.partialKind === 'undo' ? '上次撤回没做完' : '上次收进没做完'}</div>
            <div className="ds">从 {from} 收进 · {time}；还有一部分没恢复，原件在备份里；恢复好之前这个 Skill 的其他操作都先停着</div>
            {op.reason && <div className="ds bad">停在这一步：{undoReasonText(op.reason, op.from?.toolId)}；处理好后再点「继续恢复」</div>}
          </div>
          <span className="acts sk-acts">
            <Button size="sm" className="np-btn" onClick={onResume} disabled={busy}>{busy ? '恢复中…' : '继续恢复'}</Button>
          </span>
        </div>
      </div>
    )
  }
  const blocked = op.state === 'blocked' || op.state === 'waiting'
  return (
    <div className="np-card np-card--form sk-recent">
      <div className="np-row">
        <div className="lf">
          <div className="lb">最近收进</div>
          <div className="ds">从 {from} 收进 · {time}；原件在备份里；已开着的会话重开后才用上新版本</div>
          {blocked && <div className="ds bad">现在撤不了：{undoReasonText(op.state === 'waiting' ? 'later-operation' : op.reason, op.from?.toolId)}</div>}
        </div>
        <span className="acts sk-acts">
          <Button size="sm" className="np-btn" onClick={onUndo} disabled={busy || blocked}>{busy ? '撤回中…' : '撤回'}</Button>
          {showNext && <Button size="sm" variant="ghost" className="np-btn-text" onClick={onNext}>下一个要处理</Button>}
        </span>
      </div>
    </div>
  )
}

/**
 * 一份的差异文件：先列 4 个，多了可以点开
 * @returns {JSX.Element|null}
 */
function DiffFiles({ diff }) {
  const [open, setOpen] = useState(false)
  const files = diffFiles(diff)
  if (files.length === 0) return null
  const shown = open ? files : files.slice(0, 4)
  return (
    <div className="sk-files">
      {shown.map((entry) => (
        <div key={`${entry.kind}-${entry.file}`} className="sk-f"><span className="sk-fk">{entry.kind}</span>{entry.file}</div>
      ))}
      {!open && files.length > 4 && (
        <div className="sk-f sk-more" role="button" tabIndex={0} onClick={() => setOpen(true)} onKeyDown={(event) => { if (event.key === 'Enter') setOpen(true) }}>
          还有 {files.length - 4} 个文件 ›
        </div>
      )}
    </div>
  )
}

/** 一份副本的一行 */
function CopyRow({ copy, frozen, pending, onCollect, onIgnore }) {
  let relation
  if (copy.relation === 'none') {
    relation = (
      <>
        <div className="ds">资产库没有</div>
        {copy.peerDiff && <><div className="ds warn">{diffSummary(copy.peerDiff, '第一份')}</div><DiffFiles diff={copy.peerDiff} /></>}
      </>
    )
  }
  else if (copy.relation === 'same') relation = <div className="ds">和资产库一样</div>
  else relation = <><div className="ds warn">{diffSummary(copy.diff)}</div><DiffFiles diff={copy.diff} /></>
  return (
    <div className="np-row sk-copy">
      <div className="lf">
        <div className="lb">{copyLabel(copy)}</div>
        <div className="sk-p">{copy.displayPath}</div>
        {copy.targetDisplay && <div className="sk-p sk-to">→ {copy.targetDisplay}</div>}
        {relation}
      </div>
      <span className="acts sk-acts">
        <Button size="sm" className="np-btn" onClick={onCollect} disabled={frozen || pending}>{pending ? '收进中…' : '收进'}</Button>
        <Button size="sm" variant="ghost" className="np-btn-text" onClick={onIgnore} disabled={frozen || pending}>忽略</Button>
      </span>
    </div>
  )
}

/** 资产库没有时的启用卡：每个工具写在哪能用、装载状态，不给开关 */
function StatusCard({ copies }) {
  const rows = TOOLS.map((tool) => {
    const own = copies.filter((copy) => copy.toolId === tool.id)
    if (own.length === 0) return null
    const places = [...new Set(own.map((copy) => (copy.scope === 'project' ? `${copy.projectName} 项目` : '全局目录')))]
    const state = own.some((copy) => copy.loadState === 'loaded') ? 'loaded' : own[0].loadState || 'loaded'
    const where = state === 'loaded' ? `在${places.join('、')}里能用` : `在${places.join('、')}里，${LOAD_TEXT[state]}`
    return (
      <div key={tool.id} className="np-row">
        <div className="lf sk-tool">
          <ToolIcon toolId={tool.id} />
          <div className="lf"><div className="lb">{tool.label}</div><div className="ds">{where}；收进后可在这里开关</div></div>
        </div>
        {state === 'loaded' ? <span className="np-st"><i />装载中</span> : <span className="np-st off"><i />{LOAD_TEXT[state]}</span>}
      </div>
    )
  }).filter(Boolean)
  if (rows.length === 0) return null
  return (
    <>
      <div className="np-glabel">启用</div>
      <div className="np-card np-card--form">{rows}</div>
    </>
  )
}

/**
 * @param {object} props
 * @param {object} props.item - 快照 inbox.items 里的一条
 * @param {object|null} props.skill - 资产库已有时，快照里同名的 Skill
 * @param {object|null} props.snapshot
 * @param {object|null} props.op - 这个名字最近一次还没撤回的收进
 * @param {Set<string>} props.pendingKeys
 * @param {(copy: object) => void} props.onCollect
 * @param {(copy: object) => void} props.onIgnore
 * @param {() => void} props.onUndo
 * @param {() => void} props.onResume
 * @param {(toolId: string, enabled: boolean) => void} props.onToggle
 * @param {(toolId: string) => void} props.onFixGate - 占位里「换成链接」
 * @returns {JSX.Element}
 */
export default function InboxDetail({ item, skill, snapshot, op, pendingKeys, onCollect, onIgnore, onUndo, onResume, onToggle, onFixGate }) {
  const copies = item.copies || []
  const frozen = op?.state === 'partial'
  const opBusy = Boolean(op && (pendingKeys.has(`${item.name}:undo:${op.operationId}`) || pendingKeys.has(`${item.name}:resume:${op.operationId}`)))
  return (
    <div className="np-pane np-pane--detail">
      <div className="np-pane-hd">
        <h2 className="ttl">{item.displayName || item.name}</h2>
        <div className="meta"><span>要处理 · {RELATION_TEXT[item.relation]} · {copies.length} 份</span></div>
      </div>
      <div className="np-pane-body">
        {op && <RecentCard op={op} busy={opBusy} showNext={false} onUndo={onUndo} onResume={onResume} />}

        <div className="np-glabel">
          要处理的副本<span className="cnt">{copies.length}</span>
          {item.peers && copies.length > 1 && <span className="sk-peer">这 {copies.length} 份内容{item.peers === 'same' ? '一样' : '不一样'}</span>}
        </div>
        <div className="np-card np-card--form">
          {copies.map((copy) => (
            <CopyRow
              key={copy.sourceId}
              copy={copy}
              frozen={frozen}
              pending={pendingKeys.has(`${item.name}:collect:${copy.sourceId}`) || pendingKeys.has(`${item.name}:ignore:${copy.sourceId}`)}
              onCollect={() => onCollect(copy)}
              onIgnore={() => onIgnore(copy)}
            />
          ))}
        </div>

        {skill?.managed ? (
          <>
            <div className="np-glabel">启用</div>
            <div className="np-card np-card--form">
              {TOOLS.map((tool) => (
                <ToolRow
                  key={tool.id}
                  tool={tool}
                  skill={skill}
                  snapshot={snapshot}
                  pending={pendingKeys.has(`${skill.name}:${tool.id}`)}
                  frozen={frozen}
                  onToggle={onToggle}
                  onFixGate={onFixGate}
                />
              ))}
            </div>
            <div className="np-glabel">位置</div>
            <div className="np-card np-card--form">
              {(skill.locations || []).filter((location) => location.toolId === 'central').map((location) => (
                <div key={location.path} className="np-row sk-prow">
                  <div className="lf"><div className="lb">资产库</div><div className="sk-p">{location.path}</div></div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <StatusCard copies={copies} />
        )}

        <div className="np-glabel">说明</div>
        <div className="np-read sk-desc"><p>{item.description || skill?.description || '暂无说明'}</p></div>
      </div>
    </div>
  )
}
