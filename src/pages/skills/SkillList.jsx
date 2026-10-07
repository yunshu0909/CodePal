/**
 * Skill 管理页左栏
 *
 * 负责：
 * - 栏头（不跟着列表滚）：搜索框（⌘F 聚焦、Esc 清空由页面处理）→ 一行「装载总览」→ 页签（v2.1.11，2026-10-03 用户定第 4 版）
 * - 页签：要处理 | 在用 | 没用（读不出次数时 要处理 | 资产库），为 0 的不出、只剩一个时整排不出；只读组跟在最后一个页签末尾；
 *   次数没读到时页签那一行是骨架；搜索时三组一起列、带组标题，页签变淡、数字换成搜到几个
 * - Skill 一条：名字、一句话用途、每个工具的状态点、次数、问题标签
 * - 「要处理」一条：名字、一句话用途、在哪 · 几份、和资产库的关系（不一样用橙标签）
 * - 读取中骨架、整体读取失败、资产库为空、搜索无结果
 * - ↑↓ 在列表里换选中
 *
 * @module pages/skills/SkillList
 */

import React, { useEffect, useRef } from 'react'
import Button from '../../components/Button/Button'
import StateView from '../../components/StateView/StateView'
import TabBar from '../../components/TabBar/TabBar'
import { OVERVIEW_ID, TOOLS, groupIdsOfTab, hasDuplicate, hasMissingFolder, inboxId, inboxWhere, isOverviewLike, isReadOnly, readOnlyKind, splitHits, toolStatus } from './skillsModel'

function Highlight({ text, query }) {
  return splitHits(text, query).map((part, index) => (part.hit
    ? <mark key={index} className="np-hit">{part.text}</mark>
    : <React.Fragment key={index}>{part.text}</React.Fragment>))
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="5" cy="5" r="3.6" /><path d="M7.8 7.8 10.5 10.5" /></svg>
  )
}

/**
 * 一条 Skill
 * @returns {JSX.Element}
 */
function SkillItem({ skill, selected, onSelect, onKeyDown, snapshot, usage, usageFailed, usageStatus, query }) {
  const readOnly = isReadOnly(skill)
  const dots = TOOLS.filter((tool) => toolStatus(snapshot, tool.id) !== 'missing')
    .filter((tool) => !readOnly || skill.tools?.[tool.id]?.enabled === true)
    .filter((tool) => skill.managed || skill.tools?.[tool.id]?.state !== 'disabled' || skill.tools?.[tool.id]?.enabled)
  const total = usage?.total || 0
  let end = null
  if (readOnly) {
    end = readOnlyKind(skill).list
  } else if (usageStatus === 'loading') {
    end = <span className="np-sk np-sk--pulse" style={{ width: 48, height: 12 }} />
  } else if (usageFailed || usage?.total === null || usage?.availability === 'error') {
    end = <><span className="n">—</span> 次</>
  } else if (total > 0) {
    end = <><span className="n">{total}</span> 次</>
  }
  return (
    <div
      role="option"
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      data-id={skill.name}
      className={`np-li${selected ? ' on' : ''}`}
      onClick={() => onSelect(skill.name)}
      onKeyDown={onKeyDown}
    >
      <b><Highlight text={skill.displayName || skill.name} query={query} /></b>
      {skill.description && <span className="d"><Highlight text={skill.description} query={query} /></span>}
      <span className="m">
        {dots.map((tool) => (
          <span key={tool.id} className={`dot${skill.tools?.[tool.id]?.enabled === true ? '' : ' off'}`}>{tool.short}</span>
        ))}
        {hasDuplicate(skill) && <span className="np-tag np-tag--orange">两份</span>}
        {hasMissingFolder(skill) && <span className="np-tag np-tag--orange">找不到</span>}
        {end && <span className="end">{end}</span>}
      </span>
    </div>
  )
}

/**
 * 「要处理」里的一条
 * @returns {JSX.Element}
 */
function InboxItem({ item, selected, onSelect, onKeyDown, query }) {
  const id = inboxId(item.name)
  return (
    <div
      role="option"
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      data-id={id}
      className={`np-li${selected ? ' on' : ''}`}
      onClick={() => onSelect(id)}
      onKeyDown={onKeyDown}
    >
      <b><Highlight text={item.displayName || item.name} query={query} /></b>
      {item.description && <span className="d"><Highlight text={item.description} query={query} /></span>}
      <span className="m">
        <span className="sk-where">{inboxWhere(item)}</span>
        {item.relation === 'diff'
          ? <span className="np-tag np-tag--orange">不一样</span>
          : <span className="end">{item.relation === 'same' ? '资产库已有' : '资产库没有'}</span>}
      </span>
    </div>
  )
}

/**
 * @param {object} props
 * @param {'loading'|'error'|'ready'} props.status - 快照读取状态
 * @param {object|null} props.snapshot
 * @param {Array} props.groups - buildGroups 的结果
 * @param {Array<{value: string, label: string, count: number}>|null} props.tabs - 页签；null = 次数还没读到（骨架），[] = 整排不出
 * @param {string|null} props.tab - 当前页签
 * @param {(tab: string) => void} props.onTabChange
 * @param {string} props.selectedId - 选中的 Skill 名、要处理的一条（inbox:名字）、OVERVIEW_ID 或总览下的视图
 * @param {(id: string) => void} props.onSelect
 * @param {string} props.query
 * @param {(value: string) => void} props.onQueryChange
 * @param {Map} props.usageMap
 * @param {boolean} props.usageFailed
 * @param {'loading'|'error'|'ready'} [props.usageStatus='ready'] - 数字状态；读取中显示已签收的骨架。
 * @param {() => void} props.onRetry - 整体读取失败时重试
 * @param {object} props.searchRef - 搜索框 ref（⌘F 用）
 * @returns {JSX.Element}
 */
export default function SkillList({ status, snapshot, groups, tabs, tab, onTabChange, selectedId, onSelect, query, onQueryChange, usageMap, usageStatus = 'ready', usageFailed, onRetry, searchRef }) {
  const paneRef = useRef(null)
  const searching = Boolean(query.trim())
  const hasLibrary = (snapshot?.skills || []).some((skill) => skill.managed)
  const emptyNote = !searching && !hasLibrary ? <div className="np-empty sk-list-note">资产库还没有 Skill</div> : null
  const tabIds = (tabs || []).map((option) => option.value)
  // 不搜索时只列当前页签的组（只读组跟在最后一个页签末尾）；整排不出时列全部。
  // 次数没读到时（页签那一行是骨架）：有要处理先列要处理，没有就先把资产库照现有顺序列出来，不让列表空着等
  let shown = groups
  if (!searching && tabs === null) shown = tab === 'inbox' ? groups.filter((group) => group.id === 'inbox') : groups.filter((group) => group.id !== 'inbox')
  else if (!searching && tabIds.length > 0) shown = groups.filter((group) => groupIdsOfTab(tab, tabIds).includes(group.id))
  const order = [
    OVERVIEW_ID,
    ...shown.flatMap((group) => group.skills.map((skill) => (group.id === 'inbox' ? inboxId(skill.name) : skill.name))),
  ]
  const overviewSelected = isOverviewLike(selectedId)

  // 选中项变了（↑↓、点总览里的一行）：滚到它并把焦点给它
  useEffect(() => {
    const node = paneRef.current?.querySelector(`[data-id="${CSS.escape(selectedId)}"]`)
    if (!node) return
    if (typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' })
  }, [selectedId, tab])

  const handleKeyDown = (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const index = order.indexOf(overviewSelected ? OVERVIEW_ID : selectedId)
    const next = order[Math.min(order.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)))]
    if (!next || next === selectedId) return
    onSelect(next)
    requestAnimationFrame(() => paneRef.current?.querySelector(`[data-id="${CSS.escape(next)}"]`)?.focus())
  }

  const skeletonRows = (count) => Array.from({ length: count }, (_, index) => (
    <div key={index} className="np-li">
      <b><span className="np-sk np-sk--pulse sk-sk-120" /></b>
      <span className="d"><span className="np-sk np-sk--pulse sk-sk-160" /></span>
    </div>
  ))
  const loaded = !(status === 'loading' && !snapshot) && !(status === 'error' && !snapshot)
  const loadOf = (toolId) => (toolStatus(snapshot, toolId) === 'ok' && snapshot?.tools?.[toolId]?.load ? snapshot.tools[toolId].load.total : '—')

  let body
  if (status === 'loading' && !snapshot) {
    body = skeletonRows(8)
  } else if (status === 'error' && !snapshot) {
    body = <StateView error="没有修改任何目录" errorTitle="Skill 状态读取失败" onRetry={onRetry} />
  } else if (searching && groups.length === 0) {
    body = (
      <div className="np-hstack sk-search-empty">
        <span className="np-empty">没有符合条件的 Skill</span>
        <Button variant="ghost" className="np-btn-text" onClick={() => onQueryChange('')}>清除搜索</Button>
      </div>
    )
  } else {
    // 搜索时带组标题；不搜索时页签已经说明是哪一组，只有跟在后面的只读组带标题
    const titled = (group) => searching || group.id === 'readonly'
    body = (
      <>
        {shown.map((group) => (
          <React.Fragment key={group.id}>
            {titled(group) && <div className="np-lg"><span>{group.title}</span><span className="cnt">{group.skills.length}</span></div>}
            {group.id === 'inbox' && group.skills.map((item) => (
              <InboxItem
                key={`inbox-${item.name}`}
                item={item}
                selected={selectedId === inboxId(item.name)}
                onSelect={onSelect}
                onKeyDown={handleKeyDown}
                query={query.trim()}
              />
            ))}
            {group.id !== 'inbox' && group.skills.map((skill) => (
              <SkillItem
                key={skill.name}
                skill={skill}
                selected={selectedId === skill.name}
                onSelect={onSelect}
                onKeyDown={handleKeyDown}
                snapshot={snapshot}
                usage={usageMap.get(skill.name)}
                usageFailed={usageFailed}
                usageStatus={usageStatus}
                query={query.trim()}
              />
            ))}
          </React.Fragment>
        ))}
        {/* 资产库还没有 Skill：跟在要处理后面（定稿 A15） */}
        {emptyNote}
      </>
    )
  }

  let tabRow = null
  if (loaded && tabs === null && hasLibrary) {
    tabRow = <div className="sk-tabs-sk"><span className="np-sk np-sk--pulse sk-sk-160" /></div>
  } else if (loaded && tabs && tabs.length > 0) {
    tabRow = <TabBar ariaLabel="Skill 分组" value={tab} onChange={onTabChange} options={tabs} disabled={searching} />
  }

  return (
    <div className="np-pane np-pane--list" ref={paneRef}>
      <div className="np-pane-hd sk-list-hd">
        <label className="np-sf">
          <SearchIcon />
          <input
            ref={searchRef}
            value={query}
            placeholder="搜索名称和用途"
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Escape') onQueryChange('') }}
          />
          {query && <button type="button" className="np-sf-clear" aria-label="清空搜索框" onClick={() => onQueryChange('')}>×</button>}
        </label>
        {/* 装载总览常驻在栏头（用户 10-03）；仍是一条可选中的项，↑↓ 和下面的列表连着走 */}
        <div role="listbox" aria-label="装载总览">
          {loaded ? (
            <div
              role="option"
              aria-selected={overviewSelected}
              tabIndex={overviewSelected ? 0 : -1}
              data-id={OVERVIEW_ID}
              className={`np-li sk-ov${overviewSelected ? ' on' : ''}`}
              onClick={() => onSelect(OVERVIEW_ID)}
              onKeyDown={handleKeyDown}
            >
              <b>装载总览</b>
              <span className="r">
                {TOOLS.map((tool, index) => (
                  <React.Fragment key={tool.id}>
                    {index > 0 && <i>·</i>}
                    {tool.short} <span className="n">{loadOf(tool.id)}</span>
                  </React.Fragment>
                ))}
              </span>
            </div>
          ) : (
            <div className="np-li sk-ov"><b><span className="np-sk np-sk--pulse sk-sk-60" /></b></div>
          )}
        </div>
        {tabRow}
      </div>
      <div className="np-pane-body" role="listbox" aria-label="Skill 列表">
        {body}
      </div>
    </div>
  )
}
