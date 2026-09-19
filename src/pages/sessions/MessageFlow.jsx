/**
 * 对话回顾 · 消息流
 *
 * 负责：
 * - 提问气泡、带署名的回答（长文排版）、折叠的工具调用块、压缩分隔行
 * - 顶上一行：还有更早的在加载时「正在加载更早的消息…」，读到开头时是第一条消息的日期时间
 * - 从搜索进来时：命中字标出，第一处命中所在的块加框
 *
 * @module pages/sessions/MessageFlow
 */

import { useState } from 'react'
import MarkdownRenderer from '../../components/MarkdownRenderer/MarkdownRenderer'
import { formatDateTime, groupMessages } from './sessionView'

const RCHEV = <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M4 2.5 6.5 5 4 7.5" /></svg>
const DCHEV = <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 4 5 6.5 7.5 4" /></svg>
const CLAUDE_IC = (
  <span className="np-ic np-ic--s16" style={{ '--c': 'var(--tool-claude)' }}>
    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5 6.5 8 3 11.5M8 12h5" /></svg>
  </span>
)

/** 纯文本里的命中字包成 <mark class="np-hit"> */
function marked(text, keyword) {
  if (!keyword) return text
  const kw = keyword.toLowerCase()
  const lower = text.toLowerCase()
  const out = []
  let from = 0
  for (let i = lower.indexOf(kw); i >= 0; i = lower.indexOf(kw, i + kw.length)) {
    if (i > from) out.push(text.slice(from, i))
    out.push(<mark key={i} className="np-hit">{text.slice(i, i + kw.length)}</mark>)
    from = i + kw.length
  }
  if (from < text.length) out.push(text.slice(from))
  return out
}

/** 折叠的工具调用块 */
function ToolsBlock({ toolUses }) {
  const [openState, setOpen] = useState(false)
  return (
    <>
      <button type="button" className="sr-tools" aria-expanded={openState} onClick={() => setOpen((v) => !v)}>
        {openState ? DCHEV : RCHEV}
        <span>{`${toolUses.length} 次工具调用`}</span>
      </button>
      {openState && (
        <div className="sr-tool-list">
          {toolUses.map((t, i) => <div key={i}>{t.target ? `${t.name} · ${t.target}` : t.name}</div>)}
        </div>
      )}
    </>
  )
}

/**
 * 消息流
 * @param {Object} props
 * @param {Array<object>} props.messages - 正序消息
 * @param {boolean} props.hasMore - 前面还有更早的
 * @param {boolean} props.loadingOlder - 正在加载更早的
 * @param {{offset: number, keyword: string}|null} props.hit - 从搜索进来时的命中
 * @param {number} props.now - 当前时间
 * @returns {JSX.Element}
 */
export default function MessageFlow({ messages, hasMore, loadingOlder, hit, now }) {
  const keyword = hit?.keyword || ''
  const firstWhen = messages.find((m) => m.timestamp)?.timestamp
  return (
    <>
      {loadingOlder ? <div className="sr-sysline">正在加载更早的消息…</div> : null}
      {!hasMore && !loadingOlder && firstWhen ? <div className="np-msg-when">{formatDateTime(firstWhen, now)}</div> : null}
      {groupMessages(messages).map((b) => {
        const first = hit && b.message?.offset === hit.offset ? ' sr-hit-first' : ''
        if (b.type === 'ask') return <div key={b.key} className={`np-ask${first}`} data-offset={b.message.offset}>{marked(b.message.text, keyword)}</div>
        if (b.type === 'answer') {
          return (
            <div key={b.key} className={`sr-ans${first}`} data-offset={b.message.offset}>
              <div className="np-sender">{CLAUDE_IC}Claude</div>
              <MarkdownRenderer className="np-read" content={b.message.text} highlight={keyword} />
            </div>
          )
        }
        if (b.type === 'tools') return <ToolsBlock key={b.key} toolUses={b.toolUses} />
        return <div key={b.key} className="sr-sysline">以上内容已压缩</div>
      })}
    </>
  )
}
