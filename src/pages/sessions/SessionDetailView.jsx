/**
 * 对话回顾 · 对话页（钻入式详情）
 *
 * 负责：
 * - 顶部固定块：「‹ 对话回顾」/ 项目方块 + 标题 / 项目 · 分支 · 时间 + 复制 resume 参数（主按钮）与新终端启动
 * - 正文：从尾部读 200 条停在底部；滚到顶加载更早的并保持位置；从搜索进来时往前读到命中处
 * - 打开期间每 10 秒、窗口回到前台时补读新消息；原本停在底部才滚到底
 * - 复制 / 启动的 Toast；原目录已删、读不到工作目录时禁用
 * - 键盘：Esc 返回、⌘⇧C 复制、⌘↩ 新终端启动
 *
 * @module pages/sessions/SessionDetailView
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import Button from '../../components/Button/Button'
import StateView from '../../components/StateView/StateView'
import { toast } from '../../components/Toast'
import MessageFlow from './MessageFlow'
import { FOLDER } from './SessionListView'
import { displayTitle, formatWhen, iconColor, resumeCommand } from './sessionView'

const PAGE_SIZE = 200
const REFRESH_MS = 10_000
// 离底部这么近就算「停在底部」
const BOTTOM_SLACK = 24

function Skeleton() {
  return (
    <>
      <div className="np-ask np-sk-text np-sk--pulse">占位占位占位占位占位占位</div>
      <div className="sr-ans">
        <span className="np-sk np-sk--pulse sr-sk-sender" />
        <div className="sr-sk-lines">
          {['92%', '78%', '64%'].map((w) => <span key={w} className="np-sk np-sk--pulse" style={{ width: w }} />)}
        </div>
      </div>
    </>
  )
}

/**
 * 对话页
 * @param {Object} props
 * @param {object} props.session - listRecent 的一条
 * @param {{offset: number, keyword: string}|null} props.hit - 从搜索进来时的命中
 * @param {() => void} props.onBack - 返回列表
 * @returns {JSX.Element}
 */
export default function SessionDetailView({ session, hit, onBack }) {
  const { projectId, sessionId } = session
  const now = Date.now()
  const [page, setPage] = useState({ status: 'loading', messages: [], hasMore: false, cursor: 0, error: null })
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [cwd, setCwd] = useState(null) // null = 还在读；{ cwd, cwdExists }
  const [launching, setLaunching] = useState(false)
  const bodyRef = useRef(null)
  const cwdPromise = useRef(null)
  // 渲染后要做的滚动：bottom 到底；keep 保持加载更早之前看的位置；hit 滚到命中
  const scrollIntent = useRef(null)
  const pageRef = useRef(page)
  pageRef.current = page

  const read = useCallback((opts) => window.electronAPI.readSession(projectId, sessionId, opts), [projectId, sessionId])

  const load = useCallback(async () => {
    setPage((p) => ({ ...p, status: 'loading', error: null }))
    try {
      const res = await read({ limit: PAGE_SIZE })
      if (!res?.success) throw new Error(res?.error || '读取失败')
      let { messages, hasMore, cursor } = res.data
      // 从搜索进来：往前读到包含命中那条为止
      while (hit && hasMore && cursor > hit.offset) {
        const more = await read({ limit: PAGE_SIZE, before: cursor })
        if (!more?.success) break
        messages = [...more.data.messages, ...messages]
        hasMore = more.data.hasMore
        cursor = more.data.cursor
      }
      scrollIntent.current = hit ? { type: 'hit' } : { type: 'bottom' }
      setPage({ status: 'ok', messages, hasMore, cursor, error: null })
    } catch (err) {
      setPage((p) => ({ ...p, status: 'error', error: err.message }))
    }
  }, [read, hit])

  useEffect(() => { load() }, [load])

  // 工作目录：决定两个按钮能不能用
  useEffect(() => {
    const p = window.electronAPI.readSessionCwd({ projectId, sessionId })
      .then((r) => (r?.success ? { cwd: r.cwd, cwdExists: Boolean(r.cwdExists) } : { cwd: null, cwdExists: false }))
      .catch(() => ({ cwd: null, cwdExists: false }))
    cwdPromise.current = p
    p.then((v) => { if (cwdPromise.current === p) setCwd(v) })
  }, [projectId, sessionId])

  // 用 ref 挡并发：滚到顶时一次滑动会连着触发多个 scroll 事件，state 还没更新就会重复加载同一页
  const olderInFlight = useRef(false)
  const loadOlder = useCallback(async () => {
    const cur = pageRef.current
    if (cur.status !== 'ok' || !cur.hasMore || olderInFlight.current) return
    olderInFlight.current = true
    setLoadingOlder(true)
    try {
      const res = await read({ limit: PAGE_SIZE, before: cur.cursor })
      if (res?.success) {
        const el = bodyRef.current
        scrollIntent.current = { type: 'keep', fromBottom: el ? el.scrollHeight - el.scrollTop : 0 }
        setPage((p) => {
          // 只要比当前第一条更早的，防止重复
          const first = p.messages.length ? p.messages[0].offset : Infinity
          const older = res.data.messages.filter((m) => m.offset < first)
          return { ...p, messages: [...older, ...p.messages], hasMore: res.data.hasMore, cursor: res.data.cursor }
        })
      }
    } finally {
      olderInFlight.current = false
      setLoadingOlder(false)
    }
  }, [read])

  // 补读新消息：只把比已有最后一条更晚的接在后面
  const refreshTail = useCallback(async () => {
    const cur = pageRef.current
    if (cur.status !== 'ok') return
    const res = await read({ limit: PAGE_SIZE }).catch(() => null)
    if (!res?.success) return
    const last = cur.messages.length ? cur.messages[cur.messages.length - 1].offset : -1
    const fresh = res.data.messages.filter((m) => m.offset > last)
    if (!fresh.length) return
    const el = bodyRef.current
    const atBottom = !el || el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK
    if (atBottom) scrollIntent.current = { type: 'bottom' }
    setPage((p) => ({ ...p, messages: [...p.messages, ...fresh] }))
  }, [read])

  useEffect(() => {
    const timer = setInterval(refreshTail, REFRESH_MS)
    window.addEventListener('focus', refreshTail)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', refreshTail)
    }
  }, [refreshTail])

  useLayoutEffect(() => {
    const intent = scrollIntent.current
    const el = bodyRef.current
    if (!intent || !el) return
    scrollIntent.current = null
    if (intent.type === 'bottom') el.scrollTop = el.scrollHeight
    else if (intent.type === 'keep') el.scrollTop = el.scrollHeight - intent.fromBottom
    else if (intent.type === 'hit') el.querySelector('.sr-hit-first')?.scrollIntoView?.({ block: 'center' })
  }, [page])

  const copy = useCallback(async () => {
    const info = cwd || await cwdPromise.current
    if (!info?.cwd) return
    try {
      await navigator.clipboard.writeText(resumeCommand(info.cwd, sessionId))
      toast.success('resume 命令已复制到剪贴板')
    } catch {
      toast.error('复制失败')
    }
  }, [cwd, sessionId])

  const launch = useCallback(async () => {
    const info = cwd || await cwdPromise.current
    if (!info?.cwd || !info.cwdExists || launching) return
    setLaunching(true)
    try {
      const res = await window.electronAPI.launchSessionInTerminal({ cwd: info.cwd, uuid: sessionId })
      if (res?.success) toast.success('已在新 Terminal 窗口启动 Claude Code')
      else toast.error('Terminal 启动失败，可以改用"复制 resume 参数"')
    } catch {
      toast.error('Terminal 启动失败，可以改用"复制 resume 参数"')
    } finally {
      setLaunching(false)
    }
  }, [cwd, sessionId, launching])

  // Esc 返回、⌘⇧C 复制、⌘↩ 新终端启动
  useEffect(() => {
    const onKey = (e) => {
      const mod = e.metaKey || e.ctrlKey
      if (e.key === 'Escape') { e.preventDefault(); onBack() }
      else if (mod && e.shiftKey && e.key.toLowerCase() === 'c') { e.preventDefault(); copy() }
      else if (mod && e.key === 'Enter') { e.preventDefault(); launch() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onBack, copy, launch])

  const noCwd = cwd !== null && !cwd.cwd
  const gone = cwd !== null && Boolean(cwd.cwd) && !cwd.cwdExists
  const title = displayTitle(session)
  const meta = [session.projectName, session.branch, formatWhen(session.modifiedAt, now)].filter(Boolean).join(' · ')

  return (
    <>
      <div className="np-detail-hd">
        <Button variant="ghost" className="np-btn-text" onClick={onBack}>‹ 对话回顾</Button>
        <div className="ttl">
          <span className="np-ic np-ic--s20" style={{ '--c': `var(--ic-${iconColor(session)})` }}>{FOLDER}</span>
          <span title={title}>{title}</span>
        </div>
        <div className="meta">
          <span title={session.projectPath || undefined}>{meta}</span>
          <span className="acts">
            <Button size="sm" variant="primary" className="np-btn" disabled={noCwd} title={noCwd ? '读不到这个对话的工作目录' : undefined} onClick={copy}>
              复制 resume 参数
            </Button>
            <Button
              size="sm"
              className="np-btn"
              disabled={noCwd || gone || launching}
              title={noCwd ? '读不到这个对话的工作目录' : gone ? `原项目目录已不存在：${cwd.cwd}` : undefined}
              onClick={launch}
            >
              {launching ? '启动中…' : '新终端启动'}
            </Button>
          </span>
        </div>
      </div>
      <div
        className="np-detail-body"
        ref={bodyRef}
        onScroll={(e) => { if (e.currentTarget.scrollTop <= 0) loadOlder() }}
      >
        {page.status === 'loading' ? <Skeleton /> : null}
        {page.status === 'error' ? <StateView error={page.error} onRetry={load} /> : null}
        {page.status === 'ok' ? <MessageFlow messages={page.messages} hasMore={page.hasMore} loadingOlder={loadingOlder} hit={hit} now={now} /> : null}
      </div>
    </>
  )
}
