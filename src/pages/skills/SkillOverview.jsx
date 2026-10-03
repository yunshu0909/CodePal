/**
 * Skill 管理页右栏：装载总览
 *
 * 负责：
 * - 栏头「HH:MM 读取」+「重新读取」（读取中 / 失败原位换字）
 * - 每个工具一张卡：装载的 Skill 数、约多少 tokens、来源色条与来源行（插件不算）；资产库外装着的单列「不在资产库」一行
 * - 工具没找到 / 读不出 / 同步目录读不出的就地表达
 * - 第三块（v2.1.11）：N 个 Skill 要处理（点了选中第一个）、从 K 个项目里找到、收进记录 N 次、已忽略 N 份（各开一个右栏视图）；
 *   同一工具装了两份（点了跳到它）；没有要处理时标题叫「找到的项目」
 *
 * @module pages/skills/SkillOverview
 */

import React from 'react'
import Button from '../../components/Button/Button'
import { formatTokens, hasDuplicate, inboxItemsOf, isExternal, syncedUnreadable, toolStatus } from './skillsModel'
import { ToolIcon } from './SkillDetail'

const pad = (value) => String(value).padStart(2, '0')

function ChevronIcon() {
  return <svg className="sk-chev" viewBox="0 0 10 10" aria-hidden="true"><path d="M3.5 2 6.5 5l-3 3" /></svg>
}

/** 「不在资产库」那一行的说明：要处理里还有就照定稿写；只剩忽略的只提已忽略；都没有只说收进后能开关 */
function outsideNote(snapshot) {
  if (inboxItemsOf(snapshot).length > 0) return '在「要处理」或「已忽略」里，收进后在这页开关'
  if ((snapshot?.ignored || []).length > 0) return '在「已忽略」里，收进后在这页开关'
  return '收进后在这页开关'
}

/**
 * 一张工具卡
 * @returns {JSX.Element}
 */
function ToolCard({ toolId, label, snapshot, loading, onRetry }) {
  const status = toolStatus(snapshot, toolId)
  const load = snapshot?.tools?.[toolId]?.load
  const header = (right) => (
    <div className="np-card-hd">
      <span className="np-card-title"><ToolIcon toolId={toolId} />{label}</span>
      {right}
    </div>
  )
  if (loading) {
    return (
      <div className="np-card sk-tool-card">
        {header(<span className="np-sk np-sk--pulse sk-sk-90" />)}
        <div className="sk-stack"><i className="sk-seg-empty" /></div>
      </div>
    )
  }
  if (status === 'missing') {
    return <div className="np-card sk-tool-card">{header(<span className="np-st off"><i />没找到 Codex</span>)}</div>
  }
  if (status === 'unreadable' || !load) {
    return (
      <div className="np-card sk-tool-card">
        {header(<span className="sk-count sk-count--na">—</span>)}
        <div className="np-errline">
          <span className="sk-grow">{label} 状态无法读取，其他数据仍可使用</span>
          <Button size="sm" className="np-btn" onClick={onRetry}>重试</Button>
        </div>
      </div>
    )
  }
  const readOnlyKey = toolId === 'claude-code' ? 'synced' : 'system'
  const readOnlyCount = load[readOnlyKey]
  const syncedBroken = toolId === 'claude-code' && syncedUnreadable(snapshot)
  // 资产库外装着的（全局目录里资产库没有的）：收进前在这页没有开关，单列一行，个人只算资产库里的。
  // 主进程不带要处理清单的旧快照没有这一层区分，照旧都算个人
  const outside = snapshot?.inbox
    ? (snapshot?.skills || []).filter((skill) => isExternal(skill) && skill.tools?.[toolId]?.enabled === true).length
    : 0
  const rows = [
    { key: 'personal', label: '个人', ds: '在这页开关', value: Math.max(0, load.personal - outside), seg: 'sk-seg-personal' },
    ...(outside > 0 ? [{ key: 'outside', label: '不在资产库', ds: outsideNote(snapshot), value: outside, seg: 'sk-seg-outside' }] : []),
    toolId === 'claude-code'
      ? { key: 'synced', label: 'claude.ai 同步', ds: syncedBroken ? 'claude.ai 同步的 Skill 读不出' : '在 claude.ai 的设置里关', bad: syncedBroken, value: syncedBroken ? '—' : readOnlyCount, seg: 'sk-seg-readonly' }
      : { key: 'system', label: '系统自带', ds: 'Codex 自带，关不了', value: readOnlyCount, seg: 'sk-seg-readonly' },
  ]
  const numeric = rows.filter((row) => typeof row.value === 'number' && row.value > 0)
  return (
    <div className="np-card sk-tool-card">
      {header(
        <span className="sk-load">
          <span className="sk-count">{load.total}</span>
          <span className="sk-load-unit">个 Skill · 约 <span className="sk-num">{formatTokens(load.tokens)}</span> tokens</span>
        </span>
      )}
      <div className="sk-stack">
        {numeric.length === 0
          ? <i className="sk-seg-empty" />
          : numeric.map((row) => <i key={row.key} className={row.seg} style={{ flexGrow: row.value }} />)}
      </div>
      <div className="sk-rows">
        {rows.map((row) => (
          <div key={row.key} className="np-row">
            <div className="lf">
              <div className="lb"><span className={`sk-key ${row.seg}`} />{row.label}</div>
              <div className={`ds${row.bad ? ' bad' : ''}`}>{row.ds}</div>
            </div>
            <span className="sk-n">{row.value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** 第三块里一行整行可点的记录 */
function RecRow({ label, ds, onClick, end }) {
  return (
    <div
      className="np-row np-row--rec"
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(event) => { if (event.key === 'Enter') onClick() }}
    >
      <div className="lf"><div className="lb">{label}</div><div className="ds">{ds}</div></div>
      <span className="np-rec-end">{end}<ChevronIcon /></span>
    </div>
  )
}

/**
 * @param {object} props
 * @param {object|null} props.snapshot
 * @param {boolean} props.loading - 首次读取中
 * @param {'idle'|'busy'|'error'} props.refreshState
 * @param {() => void} props.onRefresh
 * @param {(name: string) => void} props.onSelect - 点两份那一行：选中那个 Skill
 * @param {() => void} props.onOpenInbox - 点「N 个 Skill 要处理」：选中第一个
 * @param {(view: 'projects'|'recent'|'ignored') => void} props.onOpenView - 打开总览下的视图
 * @returns {JSX.Element}
 */
export default function SkillOverview({ snapshot, loading, refreshState, onRefresh, onSelect, onOpenInbox, onOpenView }) {
  const readAt = snapshot?.generatedAt ? new Date(snapshot.generatedAt) : null
  const duplicates = (snapshot?.skills || []).filter(hasDuplicate)
  const items = inboxItemsOf(snapshot)
  const copies = items.reduce((sum, item) => sum + (item.copies || []).length, 0)
  const projects = snapshot?.projects || null
  const found = projects?.found || []
  const operations = snapshot?.operations || []
  const ignored = snapshot?.ignored || []
  const todoCount = items.length + duplicates.length
  const showBlock = todoCount > 0 || Boolean(projects) || operations.length > 0 || ignored.length > 0
  const describeDuplicate = (skill) => {
    const toolId = Object.entries(skill.tools || {}).find(([, state]) => state?.duplicate)?.[0]
    return `${toolId === 'codex' ? 'Codex' : 'Claude Code'} 里有两份，内容不一样`
  }

  return (
    <div className="np-pane np-pane--detail">
      <div className="np-pane-hd">
        <h2 className="ttl">装载总览</h2>
        <div className="meta">
          <span>{readAt ? <><span className="num">{pad(readAt.getHours())}:{pad(readAt.getMinutes())}</span> 读取</> : '读取中'}</span>
          <span className="acts">
            {refreshState === 'busy'
              ? <Button size="sm" className="np-btn" disabled>读取中…</Button>
              : <Button size="sm" className="np-btn" onClick={onRefresh} disabled={loading}>{refreshState === 'error' ? '重试' : '重新读取'}</Button>}
          </span>
        </div>
      </div>
      <div className="np-pane-body">
        {refreshState === 'error' && <div className="np-errline sk-block">读取失败，下面是上次读到的结果</div>}
        <ToolCard toolId="claude-code" label="Claude Code" snapshot={snapshot} loading={loading} onRetry={onRefresh} />
        <ToolCard toolId="codex" label="Codex" snapshot={snapshot} loading={loading} onRetry={onRefresh} />
        {!loading && showBlock && (
          <>
            {todoCount > 0
              ? <div className="np-glabel">要处理<span className="cnt">{todoCount}</span></div>
              : <div className="np-glabel">找到的项目</div>}
            <div className="np-card np-card--form">
              {items.length > 0 && (
                <RecRow
                  label={`${items.length} 个 Skill 要处理`}
                  ds={`${copies} 份，在全局目录和 ${found.length} 个项目里；左栏「要处理」逐个看`}
                  onClick={onOpenInbox}
                />
              )}
              {projects && (
                <RecRow
                  label={`从 ${found.length} 个项目里找到`}
                  ds={`看了你用 Claude Code、Codex 打开过的 ${projects.scanned} 个目录`}
                  onClick={() => onOpenView('projects')}
                />
              )}
              {operations.length > 0 && (
                <RecRow label={`收进记录 ${operations.length} 次`} ds="收进过的都在这里，可以撤回" onClick={() => onOpenView('recent')} />
              )}
              {ignored.length > 0 && (
                <RecRow label={`已忽略 ${ignored.length} 份`} ds="不再出现在要处理里，点开可以取消忽略" onClick={() => onOpenView('ignored')} />
              )}
              {duplicates.map((skill) => (
                <div
                  key={skill.name}
                  className="np-row np-row--rec"
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelect(skill.name)}
                  onKeyDown={(event) => { if (event.key === 'Enter') onSelect(skill.name) }}
                >
                  <div className="lf">
                    <div className="lb">{skill.name}</div>
                    <div className="ds">{describeDuplicate(skill)}</div>
                  </div>
                  <span className="np-rec-end"><span className="np-st warn"><i />装了两份</span><ChevronIcon /></span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
