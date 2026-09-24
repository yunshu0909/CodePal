/**
 * 对话回顾页的状态
 *
 * 负责：
 * - 最近对话列表：模块级缓存（再次进页面先出上次的列表），进页面与窗口回到前台时静默刷新
 * - 项目筛选与「显示自动调用的对话」：存 localStorage，读写失败用默认值
 * - 搜索：停 300ms 才搜，范围跟随筛选，只认最后一次请求的结果
 * - 列表页 / 对话页切换；返回时列表滚动位置由页面按 listScrollRef 恢复
 *
 * @module hooks/useSessionBrowser
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { buildProjectMenu, filterSessions } from '../pages/sessions/sessionView'

const FILTER_KEY = 'codepal.sessions.filter'
const SEARCH_DEBOUNCE_MS = 300
const DEFAULT_FILTER = { projectPath: null, includeAuto: false }

// 模块级缓存：离开再回来时先显示上次的列表，后台静默刷新
let cache = null

/** 清掉列表缓存（测试用） */
export function resetSessionCacheForTests() {
  cache = null
}

function readFilter() {
  try {
    const raw = window.localStorage.getItem(FILTER_KEY)
    if (!raw) return DEFAULT_FILTER
    const v = JSON.parse(raw)
    return { projectPath: typeof v.projectPath === 'string' ? v.projectPath : null, includeAuto: Boolean(v.includeAuto) }
  } catch {
    return DEFAULT_FILTER
  }
}

function writeFilter(filter) {
  try {
    window.localStorage.setItem(FILTER_KEY, JSON.stringify(filter))
  } catch {
    // 存不下就只在本次打开期间生效
  }
}

/**
 * 对话回顾页状态
 * @returns {object} 列表、筛选、搜索、当前画面与动作
 */
export default function useSessionBrowser() {
  const [data, setData] = useState(cache)
  const [error, setError] = useState(null)
  const [filter, setFilterState] = useState(readFilter)
  const [query, setQuery] = useState('')
  // 搜索：idle / searching / done；results 已和列表元数据合并
  const [search, setSearch] = useState({ status: 'idle', hits: [], error: null })
  // 搜索失败后点「重试」：改这个数让搜索副作用重跑
  const [searchAttempt, setSearchAttempt] = useState(0)
  const [view, setView] = useState({ page: 'list' })
  const listScrollRef = useRef(0)
  const searchSeq = useRef(0)

  const refresh = useCallback(async () => {
    try {
      const res = await window.electronAPI.listRecentSessions()
      if (res?.success) {
        cache = res.data
        setData(res.data)
        setError(null)
      } else if (!cache) {
        setError(res?.error || '读取失败')
      }
    } catch (err) {
      if (!cache) setError(err.message)
    }
  }, [])

  const retry = useCallback(() => {
    setError(null)
    refresh()
  }, [refresh])

  // 进页面刷新一次；在列表页时窗口回到前台再静默刷新
  useEffect(() => { refresh() }, [refresh])
  useEffect(() => {
    if (view.page !== 'list') return undefined
    const onFocus = () => refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [view.page, refresh])

  const sessions = data?.sessions || []
  const menu = useMemo(() => buildProjectMenu(sessions), [sessions])
  // 记住的项目已经没有手动对话了：当作全部项目
  const effectiveFilter = useMemo(() => (
    filter.projectPath && !menu.some((m) => m.projectPath === filter.projectPath) ? { ...filter, projectPath: null } : filter
  ), [filter, menu])
  const visible = useMemo(() => filterSessions(sessions, effectiveFilter), [sessions, effectiveFilter])

  const setFilter = useCallback((patch) => {
    setFilterState((prev) => {
      const next = { ...prev, ...patch }
      writeFilter(next)
      return next
    })
  }, [])

  // 搜索：去空格后为空就回到列表；否则停 300ms 再搜，只认最后一次
  const trimmed = query.trim()
  useEffect(() => {
    const seq = ++searchSeq.current
    if (!trimmed) {
      setSearch({ status: 'idle', hits: [], error: null })
      return undefined
    }
    setSearch({ status: 'searching', hits: [], error: null })
    const timer = setTimeout(async () => {
      try {
        const res = await window.electronAPI.searchSessions(trimmed, { projectPath: effectiveFilter.projectPath, includeAuto: effectiveFilter.includeAuto })
        if (seq !== searchSeq.current) return
        // 搜索失败不能显示成「无匹配结果」：单独一个 error 状态，页面沿用列表读取失败的整块状态
        if (res?.success) setSearch({ status: 'done', hits: res.data, error: null })
        else setSearch({ status: 'error', hits: [], error: res?.error || '读取失败' })
      } catch (error) {
        if (seq === searchSeq.current) setSearch({ status: 'error', hits: [], error: error?.message || '读取失败' })
      }
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [trimmed, effectiveFilter.projectPath, effectiveFilter.includeAuto, searchAttempt])

  const retrySearch = useCallback(() => setSearchAttempt((n) => n + 1), [])

  // 搜索结果和列表元数据合并（标题、项目、时间都从列表来）
  const results = useMemo(() => {
    const byKey = new Map(sessions.map((s) => [`${s.projectId}/${s.sessionId}`, s]))
    return search.hits
      .map((h) => {
        const s = byKey.get(`${h.projectId}/${h.sessionId}`)
        return s ? { session: s, snippet: h.snippet, offset: h.offset } : null
      })
      .filter(Boolean)
  }, [search.hits, sessions])

  const open = useCallback((session, hit = null, scrollTop = 0) => {
    listScrollRef.current = scrollTop
    setView({ page: 'detail', session, hit })
  }, [])
  const back = useCallback(() => setView({ page: 'list' }), [])

  return {
    loading: !data && !error,
    error,
    retry,
    projectsDirExists: data ? data.projectsDirExists : true,
    sessions,
    visible,
    menu,
    filter: effectiveFilter,
    setFilter,
    query,
    setQuery,
    searching: Boolean(trimmed),
    searchStatus: search.status,
    searchError: search.error,
    retrySearch,
    results,
    // 服务端返回的原始条数：到上限时提示缩小范围
    hitCount: search.hits.length,
    view,
    open,
    back,
    listScrollRef,
  }
}
