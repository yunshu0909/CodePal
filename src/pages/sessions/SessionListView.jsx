/**
 * 对话回顾 · 列表页
 *
 * 负责：
 * - 筛选行：搜索框 + 项目筛选
 * - 按天分组的两行记录行（项目方块 / 标题 / 预览行 / 项目名 · 时间 · ›）
 * - 骨架、读取失败、三种空态、搜索中 / 结果 / 无结果
 * - 键盘：↑↓ 在行间移动、Enter 打开、⌘F 聚焦搜索、搜索框里 Esc 清空
 *
 * @module pages/sessions/SessionListView
 */

import { Fragment, useEffect, useLayoutEffect, useRef } from 'react'
import Button from '../../components/Button/Button'
import StateView from '../../components/StateView/StateView'
import ProjectFilterMenu from './ProjectFilterMenu'
import { displayTitle, formatRowTime, groupSessions, iconColor } from './sessionView'

const SEARCH_CAP = 50
export const FOLDER = <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.5h4l1.5 1.5h5.5v6.5h-11z" /></svg>
const CHAT = <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />
const SEARCH = <svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="5" cy="5" r="3.6" /><path d="m7.8 7.8 2.6 2.6" /></svg>
const RCHEV = <svg className="chev" viewBox="0 0 10 10" aria-hidden="true"><path d="M4 2.5 6.5 5 4 7.5" /></svg>

/** 命中字包成 <mark class="np-hit">（不分大小写） */
function highlight(text, keyword) {
  const kw = keyword.toLowerCase()
  if (!kw) return text
  const out = []
  const lower = text.toLowerCase()
  let from = 0
  for (let i = lower.indexOf(kw); i >= 0; i = lower.indexOf(kw, i + kw.length)) {
    if (i > from) out.push(text.slice(from, i))
    out.push(<mark key={i} className="np-hit">{text.slice(i, i + kw.length)}</mark>)
    from = i + kw.length
  }
  if (from < text.length) out.push(text.slice(from))
  return out
}

/** 行间移动焦点 */
function moveFocus(current, step) {
  const rows = Array.from(current.closest('.sr-list')?.querySelectorAll('.np-row--rec') || [])
  const next = rows[rows.indexOf(current) + step]
  if (next) next.focus()
}

/**
 * 一行对话
 * @param {Object} props
 * @param {object} props.session - listRecent 的一条
 * @param {React.ReactNode} [props.desc] - 预览行（搜索时是命中句）
 * @param {number} props.now - 当前时间
 * @param {() => void} props.onOpen - 打开
 */
function SessionRow({ session, desc, now, onOpen }) {
  const title = displayTitle(session)
  return (
    <div
      className="np-row np-row--rec"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); moveFocus(e.currentTarget, 1) }
        else if (e.key === 'ArrowUp') { e.preventDefault(); moveFocus(e.currentTarget, -1) }
        else if (e.key === 'Enter') { e.preventDefault(); onOpen() }
      }}
    >
      <span className="np-ic np-ic--s20" style={{ '--c': `var(--ic-${iconColor(session)})` }}>{FOLDER}</span>
      <div className="lf">
        <div className="lb" title={title}>{title}</div>
        {desc ? <div className="ds">{desc}</div> : null}
      </div>
      <span className="np-rec-end">
        {session.auto ? <span className="np-tag np-tag--gray">自动</span> : null}
        <span title={session.projectPath || undefined}>{session.projectName}</span>
        <span className="num">{formatRowTime(session.modifiedAt, now)}</span>
        {RCHEV}
      </span>
    </div>
  )
}

function Skeleton() {
  return (
    <>
      <div className="np-glabel"><span className="np-sk np-sk--pulse sr-sk-label" /></div>
      <div className="np-card np-card--form">
        {[200, 160, 220, 180, 150].map((w) => (
          <div key={w} className="np-row np-row--rec">
            <span className="np-sk np-sk--pulse sr-sk-ic" />
            <div className="lf sr-sk-lines sr-sk-lines--list">
              <span className="np-sk np-sk--pulse" style={{ width: w }} />
              <span className="np-sk np-sk--pulse sr-sk-sub" style={{ width: w - 60 }} />
            </div>
          </div>
        ))}
      </div>
    </>
  )
}

/**
 * 列表页
 * @param {Object} props
 * @param {object} props.state - useSessionBrowser 的返回
 * @returns {JSX.Element}
 */
export default function SessionListView({ state }) {
  const scrollRef = useRef(null)
  const inputRef = useRef(null)
  const now = Date.now()
  const { loading, error, retry, projectsDirExists, sessions, visible, menu, filter, setFilter, query, setQuery, searching, searchStatus, results, hitCount, open, listScrollRef } = state

  // 回到列表时恢复滚动位置
  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = listScrollRef.current
  }, [listScrollRef])

  // ⌘F 聚焦搜索框
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        inputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const openRow = (session, hit) => open(session, hit, scrollRef.current?.scrollTop || 0)
  const keyword = query.trim()

  let body
  if (loading) {
    body = <Skeleton />
  } else if (error) {
    body = <StateView error={error} onRetry={retry} />
  } else if (searching) {
    if (searchStatus !== 'done') body = <div className="np-empty">搜索中...</div>
    else if (results.length === 0) {
      body = (
        <div className="np-empty sr-empty-line">
          无匹配结果 <Button variant="ghost" className="np-btn-text" onClick={() => setQuery('')}>清除搜索</Button>
        </div>
      )
    } else {
      body = (
        <>
          <div className="np-glabel">搜索结果<span className="cnt">{results.length}</span></div>
          <div className="np-card np-card--form">
            {results.map((r) => (
              <SessionRow key={`${r.session.projectId}/${r.session.sessionId}`} session={r.session} desc={highlight(r.snippet, keyword)} now={now}
                onOpen={() => openRow(r.session, { offset: r.offset, keyword })} />
            ))}
          </div>
          {hitCount >= SEARCH_CAP ? <div className="np-empty sr-cap">只显示前 50 条，换个更具体的词试试</div> : null}
        </>
      )
    }
  } else if (visible.length === 0) {
    const onlyAuto = projectsDirExists && sessions.length > 0 && !filter.includeAuto
    const hint = !projectsDirExists
      ? '没有找到 Claude Code 的对话记录'
      : onlyAuto ? '只有插件、脚本自动调用产生的对话' : '在终端里用 Claude Code 聊过之后，会出现在这里'
    body = (
      <StateView
        empty
        emptyMessage="还没有对话"
        emptyHint={hint}
        emptyIcon={CHAT}
        emptyAction={onlyAuto ? <Button size="sm" onClick={() => setFilter({ includeAuto: true })}>显示自动调用的对话</Button> : null}
      />
    )
  } else {
    body = groupSessions(visible, now).map((g) => (
      <Fragment key={g.label}>
        <div className="np-glabel">{g.label}<span className="cnt">{g.items.length}</span></div>
        <div className="np-card np-card--form">
          {g.items.map((s) => (
            <SessionRow key={`${s.projectId}/${s.sessionId}`} session={s} desc={s.preview} now={now} onOpen={() => openRow(s)} />
          ))}
        </div>
      </Fragment>
    ))
  }

  return (
    <div className="np-scroll sr-list" ref={scrollRef}>
      <div className="np-filterbar">
        <div className="np-sf">
          {SEARCH}
          <input
            ref={inputRef}
            value={query}
            placeholder="搜索对话"
            aria-label="搜索对话"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setQuery('') } }}
          />
          {query ? <button type="button" className="np-sf-clear" aria-label="清空搜索框" onClick={() => setQuery('')}>×</button> : null}
        </div>
        <ProjectFilterMenu menu={menu} filter={filter} onChange={setFilter} />
      </div>
      {body}
    </div>
  )
}
