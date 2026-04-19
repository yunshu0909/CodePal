/**
 * Session 浏览页面
 *
 * 负责：
 * - 左栏：项目列表 → 展开后显示 session 列表
 * - 右栏：选中 session 后展示对话内容
 * - MVP 版本：验证 session 读取和展示的可行性
 *
 * @module pages/SessionBrowserPage
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import PageShell from '../components/PageShell'
import StateView from '../components/StateView/StateView'
import Modal from '../components/Modal/Modal'
import Button from '../components/Button/Button'
import Toast from '../components/Toast'
import MarkdownRenderer from '../components/MarkdownRenderer/MarkdownRenderer'
import useResizableSidebar from '../hooks/useResizableSidebar'
import '../styles/session-browser.css'

const SEARCH_DEBOUNCE_MS = 300

/**
 * 高亮文本中的关键词
 * @param {string} text - 原始文本
 * @param {string} keyword - 要高亮的关键词
 * @returns {React.ReactNode}
 */
function HighlightText({ text, keyword }) {
  if (!keyword || !text) return text
  const lowerText = text.toLowerCase()
  const lowerKw = keyword.toLowerCase()
  const idx = lowerText.indexOf(lowerKw)
  if (idx === -1) return text
  return (
    <>
      {text.slice(0, idx)}
      <mark className="sb-highlight">{text.slice(idx, idx + keyword.length)}</mark>
      {text.slice(idx + keyword.length)}
    </>
  )
}

/**
 * 格式化时间戳为可读格式
 * @param {string} ts - ISO 时间戳
 * @returns {string}
 */
function formatTime(ts) {
  if (!ts) return ''
  try {
    const d = new Date(ts)
    const month = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    const hour = String(d.getHours()).padStart(2, '0')
    const min = String(d.getMinutes()).padStart(2, '0')
    return `${month}-${day} ${hour}:${min}`
  } catch {
    return ''
  }
}

/**
 * 将消息列表分组：连续的纯工具调用消息合并为一个折叠组
 * @param {Array} msgs - 原始消息列表
 * @returns {Array<{kind: 'message', msg: Object} | {kind: 'tool-group', msgs: Array, totalTools: number}>}
 */
function groupMessages(msgs) {
  const result = []
  let toolBuf = []

  const flushToolBuf = () => {
    if (toolBuf.length === 0) return
    const totalTools = toolBuf.reduce((sum, m) => sum + (m.toolUseCount || 0), 0)
    result.push({ kind: 'tool-group', msgs: [...toolBuf], totalTools })
    toolBuf = []
  }

  for (const msg of msgs) {
    const isToolOnly = msg.type === 'assistant' && !msg.content
    if (isToolOnly) {
      toolBuf.push(msg)
    } else {
      flushToolBuf()
      result.push({ kind: 'message', msg })
    }
  }
  flushToolBuf()
  return result
}

/**
 * 折叠的工具调用组
 * @param {Object} props
 * @param {Array} props.msgs - 被折叠的消息
 * @param {number} props.totalTools - 工具调用总次数
 */
function ToolCallGroup({ msgs, totalTools }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="sb-tool-group">
      <button
        className="sb-tool-group-bar"
        onClick={() => setExpanded(prev => !prev)}
      >
        <span className="sb-tool-group-icon">{expanded ? '▼' : '▶'}</span>
        <span className="sb-tool-group-label">
          🔧 {totalTools} 次工具调用（{msgs.length} 条消息）
        </span>
      </button>
      {expanded && (
        <div className="sb-tool-group-detail">
          {msgs.map((msg, i) => (
            <div key={i} className="sb-tool-group-item">
              <span className="sb-tool-group-time">{formatTime(msg.timestamp)}</span>
              <span className="sb-tool-group-count">🔧 ×{msg.toolUseCount || 0}</span>
              {msg.model && <span className="sb-message-model">{msg.model}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * 消息列表：自动分组，连续工具调用折叠
 * 搜索模式下自动滚动到首条匹配消息
 * @param {Object} props
 * @param {Array} props.messages - 原始消息列表
 * @param {string} [props.highlightKeyword] - 搜索关键词（用于定位和高亮）
 */
function MessageList({ messages, highlightKeyword }) {
  const grouped = useMemo(() => groupMessages(messages), [messages])
  const matchRef = useRef(null)
  const hasScrolled = useRef(false)

  // 找到首条包含关键词的消息索引（在分组后的列表中）
  const firstMatchIdx = useMemo(() => {
    if (!highlightKeyword) return -1
    const lowerKw = highlightKeyword.toLowerCase()
    return grouped.findIndex(item =>
      item.kind === 'message' && item.msg.content?.toLowerCase().includes(lowerKw)
    )
  }, [grouped, highlightKeyword])

  // 切换 session 或关键词变化时，重置滚动标记并执行滚动
  useEffect(() => {
    hasScrolled.current = false
    // 下一帧执行滚动，确保 DOM 已更新
    if (firstMatchIdx >= 0) {
      requestAnimationFrame(() => {
        if (matchRef.current && !hasScrolled.current) {
          hasScrolled.current = true
          matchRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' })
        }
      })
    }
  }, [messages, highlightKeyword, firstMatchIdx])

  return (
    <div className="sb-messages">
      {grouped.map((item, idx) => {
        if (item.kind === 'tool-group') {
          return <ToolCallGroup key={idx} msgs={item.msgs} totalTools={item.totalTools} />
        }
        const msg = item.msg
        const isMatch = idx === firstMatchIdx
        return (
          <div
            key={idx}
            ref={isMatch ? matchRef : null}
            className={`sb-message sb-message--${msg.type}${isMatch ? ' sb-message--match' : ''}`}
          >
            <div className="sb-message-header">
              <span className="sb-message-role">
                {msg.type === 'user' ? '👤 User' : '🤖 Claude'}
              </span>
              {msg.model && (
                <span className="sb-message-model">{msg.model}</span>
              )}
              {msg.toolUseCount > 0 && (
                <span className="sb-message-tools">🔧 ×{msg.toolUseCount}</span>
              )}
              <span className="sb-message-time">{formatTime(msg.timestamp)}</span>
            </div>
            <div className="sb-message-body">
              <MarkdownRenderer content={msg.content} />
            </div>
          </div>
        )
      })}
    </div>
  )
}

export default function SessionBrowserPage() {
  // 项目列表
  const [projects, setProjects] = useState([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [projectsError, setProjectsError] = useState(null)
  // 当前选中的项目
  const [selectedProjectId, setSelectedProjectId] = useState(null)
  // session 列表
  const [sessions, setSessions] = useState([])
  const [sessionsLoading, setSessionsLoading] = useState(false)
  // 当前选中的 session（搜索结果点击时也用这组状态）
  const [selectedSessionId, setSelectedSessionId] = useState(null)
  // 当前查看的 projectId（搜索结果可能跨项目，需要单独记录）
  const [viewingProjectId, setViewingProjectId] = useState(null)
  // 对话消息
  const [messages, setMessages] = useState([])
  const [messagesLoading, setMessagesLoading] = useState(false)
  // 搜索
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [searchLoading, setSearchLoading] = useState(false)
  const debounceRef = useRef(null)
  // 防竞态：loadSession 的请求序号，只有最新请求的结果才写入 state
  const loadSessionSeqRef = useRef(0)
  // 删除确认弹窗
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [deleting, setDeleting] = useState(false)
  // Toast 提示
  const [toast, setToast] = useState(null)
  // v1.4.5 启动此对话：当前 session 的工作目录信息（null 表示未加载或读不到）
  const [resumeCwdInfo, setResumeCwdInfo] = useState(null)

  // 是否处于搜索模式
  const isSearchMode = searchQuery.trim().length > 0
  // 可拖拽侧边栏
  const { sidebarWidth, resizerProps } = useResizableSidebar(280, 200, 500)

  // 加载项目列表
  useEffect(() => {
    loadProjects()
  }, [])

  // 组件卸载时清理 debounce 定时器
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  const loadProjects = async () => {
    setProjectsLoading(true)
    setProjectsError(null)
    try {
      const result = await window.electronAPI.listSessionProjects()
      if (result.success) {
        setProjects(result.data)
      } else {
        setProjectsError(result.error)
      }
    } catch (err) {
      setProjectsError(err.message)
    } finally {
      setProjectsLoading(false)
    }
  }

  // 搜索 debounce
  const handleSearchChange = useCallback((e) => {
    const value = e.target.value
    setSearchQuery(value)

    if (debounceRef.current) clearTimeout(debounceRef.current)

    if (!value.trim()) {
      setSearchResults([])
      setSearchLoading(false)
      return
    }

    setSearchLoading(true)
    debounceRef.current = setTimeout(async () => {
      try {
        const result = await window.electronAPI.searchSessions(value.trim())
        if (result.success) {
          setSearchResults(result.data)
        }
      } catch (err) {
        console.error('Search failed:', err)
      } finally {
        setSearchLoading(false)
      }
    }, SEARCH_DEBOUNCE_MS)
  }, [])

  // 选中项目后加载 session 列表
  const handleProjectClick = useCallback(async (projectId) => {
    if (selectedProjectId === projectId) {
      setSelectedProjectId(null)
      setSessions([])
      setSelectedSessionId(null)
      setMessages([])
      return
    }

    setSelectedProjectId(projectId)
    setSelectedSessionId(null)
    setMessages([])
    setSessionsLoading(true)

    try {
      const result = await window.electronAPI.listSessions(projectId)
      if (result.success) {
        setSessions(result.data)
      }
    } catch (err) {
      console.error('Failed to load sessions:', err)
    } finally {
      setSessionsLoading(false)
    }
  }, [selectedProjectId])

  // 选中 session 后加载对话（通用：树状视图和搜索结果都用）
  // 用 seq 防竞态：快速切换 session 时，只有最新一次请求的结果写入 state
  const loadSession = useCallback(async (projectId, sessionId) => {
    const seq = ++loadSessionSeqRef.current
    setViewingProjectId(projectId)
    setSelectedSessionId(sessionId)
    setMessagesLoading(true)
    setResumeCwdInfo(null)

    try {
      const result = await window.electronAPI.readSession(projectId, sessionId)
      if (seq !== loadSessionSeqRef.current) return
      if (result.success) {
        setMessages(result.data)
      }
    } catch (err) {
      if (seq !== loadSessionSeqRef.current) return
      console.error('Failed to read session:', err)
    } finally {
      if (seq === loadSessionSeqRef.current) {
        setMessagesLoading(false)
      }
    }

    // 并行拉 cwd（v1.4.5）：失败静默，最多让启动区消失，不影响主流程
    if (window.electronAPI?.readSessionCwd) {
      try {
        const cwdResult = await window.electronAPI.readSessionCwd({ projectId, sessionId })
        if (seq === loadSessionSeqRef.current && cwdResult?.success) {
          setResumeCwdInfo({ cwd: cwdResult.cwd, cwdExists: cwdResult.cwdExists })
        }
      } catch {
        // 忽略：启动区不展示即可
      }
    }
  }, [])

  // v1.4.5：复制 resume 命令到剪贴板
  const handleCopyResumeCommand = useCallback(async () => {
    if (!resumeCwdInfo?.cwd || !selectedSessionId) return
    const cmd = `cd "${resumeCwdInfo.cwd}" && claude --resume ${selectedSessionId}`
    try {
      await navigator.clipboard.writeText(cmd)
      setToast({ message: 'resume 命令已复制到剪贴板', type: 'success' })
    } catch {
      setToast({
        message: `复制失败，请手动在终端执行 claude --resume ${selectedSessionId}`,
        type: 'error',
      })
    }
  }, [resumeCwdInfo, selectedSessionId])

  // v1.4.5：在新终端启动 Claude Code
  const handleLaunchInTerminal = useCallback(async () => {
    if (!resumeCwdInfo?.cwd || !resumeCwdInfo.cwdExists || !selectedSessionId) return
    try {
      const result = await window.electronAPI.launchSessionInTerminal({
        cwd: resumeCwdInfo.cwd,
        uuid: selectedSessionId,
      })
      if (result?.success) {
        setToast({ message: '已在新 Terminal 窗口启动 Claude Code', type: 'success' })
      } else {
        setToast({
          message: 'Terminal 启动失败，可以改用"复制 resume 参数"',
          type: 'error',
        })
      }
    } catch {
      setToast({
        message: 'Terminal 启动失败，可以改用"复制 resume 参数"',
        type: 'error',
      })
    }
  }, [resumeCwdInfo, selectedSessionId])

  // 树状视图点击 session
  const handleSessionClick = useCallback((sessionId) => {
    loadSession(selectedProjectId, sessionId)
  }, [selectedProjectId, loadSession])

  // 搜索结果点击
  const handleSearchResultClick = useCallback((result) => {
    loadSession(result.projectId, result.sessionId)
  }, [loadSession])

  // 删除 session
  const handleDeleteSession = useCallback(async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      const result = await window.electronAPI.deleteSession(deleteTarget.projectId, deleteTarget.sessionId)
      if (result.success) {
        setSessions(prev => prev.filter(s => s.id !== deleteTarget.sessionId))
        setProjects(prev => prev.map(p =>
          p.id === deleteTarget.projectId ? { ...p, sessionCount: p.sessionCount - 1 } : p
        ))
        if (selectedSessionId === deleteTarget.sessionId) {
          setSelectedSessionId(null)
          setMessages([])
        }
      } else {
        setToast({ message: '删除失败：' + (result.error || '未知错误'), type: 'error' })
      }
    } catch (err) {
      setToast({ message: '删除失败：' + err.message, type: 'error' })
    } finally {
      setDeleting(false)
      setDeleteTarget(null)
    }
  }, [deleteTarget, selectedSessionId])

  return (
    <PageShell
      title="对话回顾"
      subtitle="查看 Claude Code 的对话历史"
      divider
      className="page-shell--no-padding"
    >
      <div className="sb-layout">
        {/* 左栏 */}
        <div className="sb-sidebar" style={{ width: sidebarWidth, minWidth: sidebarWidth }}>
          {/* 搜索框 */}
          <div className="sb-search">
            <span className="sb-search-icon">🔍</span>
            <input
              className="sb-search-input"
              type="text"
              placeholder="搜索对话内容..."
              value={searchQuery}
              onChange={handleSearchChange}
            />
            {searchQuery && (
              <button
                className="sb-search-clear"
                onClick={() => {
                  if (debounceRef.current) clearTimeout(debounceRef.current)
                  setSearchQuery('')
                  setSearchResults([])
                  setSearchLoading(false)
                }}
              >
                ✕
              </button>
            )}
          </div>

          {/* 搜索模式：显示搜索结果 */}
          {isSearchMode && (
            <div className="sb-search-results">
              {searchLoading && (
                <div className="sb-search-state">
                  <div className="sb-spinner" />
                  <div className="sb-search-state-text">搜索中...</div>
                </div>
              )}
              {!searchLoading && searchResults.length === 0 && (
                <div className="sb-search-state">
                  <div className="sb-search-state-icon">🔍</div>
                  <div className="sb-search-state-text">无匹配结果</div>
                  <div className="sb-search-state-hint">试试换个关键词</div>
                </div>
              )}
              {!searchLoading && searchResults.map((r, idx) => (
                <button
                  key={`${r.projectId}-${r.sessionId}-${idx}`}
                  className={`sb-search-result-item ${
                    viewingProjectId === r.projectId && selectedSessionId === r.sessionId ? 'active' : ''
                  }`}
                  onClick={() => handleSearchResultClick(r)}
                >
                  <div className="sb-search-result-project">{r.projectName}</div>
                  <div className="sb-search-result-snippet">
                    <HighlightText text={r.snippet} keyword={searchQuery.trim()} />
                  </div>
                  <div className="sb-session-meta">
                    <span>{formatTime(r.timestamp)}</span>
                    <span>{r.role === 'user' ? '👤' : '🤖'}</span>
                  </div>
                </button>
              ))}
            </div>
          )}

          {/* 非搜索模式：显示项目/session 树 */}
          {!isSearchMode && (
            <StateView
              loading={projectsLoading}
              error={projectsError}
              onRetry={loadProjects}
              empty={projects.length === 0}
              emptyMessage="未找到 Claude Code 项目"
            >
              <div className="sb-project-list">
                {projects.map(project => (
                  <div key={project.id} className="sb-project-group">
                    <button
                      className={`sb-project-item ${selectedProjectId === project.id ? 'active' : ''}`}
                      onClick={() => handleProjectClick(project.id)}
                    >
                      <span className="sb-project-icon">
                        {selectedProjectId === project.id ? '▼' : '▶'}
                      </span>
                      <span className="sb-project-name">{project.name}</span>
                      <span className="sb-project-count">{project.sessionCount}</span>
                    </button>

                    {selectedProjectId === project.id && (
                      <div className="sb-session-list">
                        {sessionsLoading ? (
                          <div className="sb-session-loading">加载中...</div>
                        ) : (
                          sessions.map(session => (
                            <div key={session.id} className="sb-session-item-wrapper">
                              <button
                                className={`sb-session-item ${selectedSessionId === session.id ? 'active' : ''}`}
                                onClick={() => handleSessionClick(session.id)}
                              >
                                <div className="sb-session-prompt">{session.firstPrompt}</div>
                                <div className="sb-session-meta">
                                  <span>{formatTime(session.modifiedAt)}</span>
                                  <span>{session.lineCount} 行</span>
                                </div>
                              </button>
                              <button
                                className="sb-session-delete"
                                title="删除此对话"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setDeleteTarget({ projectId: selectedProjectId, sessionId: session.id, prompt: session.firstPrompt })
                                }}
                              >
                                ✕
                              </button>
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </StateView>
          )}
        </div>

        {/* 拖拽分隔线 */}
        <div {...resizerProps} />

        {/* 右栏：对话内容 */}
        <div className="sb-content">
          {!selectedSessionId && (
            <div className="sb-empty-state">
              <div className="sb-empty-icon">💬</div>
              <div className="sb-empty-text">选择一个对话查看内容</div>
            </div>
          )}

          {selectedSessionId && (
            <div className="sb-content-header">
              <span className="sb-content-header-project">
                {projects.find(p => p.id === viewingProjectId)?.name || viewingProjectId}
              </span>
              <span className="sb-content-header-sep">/</span>
              <span className="sb-content-header-id">{selectedSessionId.slice(0, 8)}</span>
              <span className="sb-content-header-count">
                {messages.length} 条消息
              </span>
              {resumeCwdInfo?.cwd && (
                <>
                  <button
                    type="button"
                    className="tag-btn"
                    onClick={handleCopyResumeCommand}
                    title={`复制：cd "${resumeCwdInfo.cwd}" && claude --resume ${selectedSessionId}`}
                  >
                    复制 resume 参数
                  </button>
                  <button
                    type="button"
                    className="tag-btn"
                    onClick={handleLaunchInTerminal}
                    disabled={!resumeCwdInfo.cwdExists}
                    title={
                      resumeCwdInfo.cwdExists
                        ? '在新 Terminal 窗口里启动 Claude Code 并恢复此对话'
                        : `原项目目录已不存在：${resumeCwdInfo.cwd}`
                    }
                  >
                    新终端启动
                  </button>
                </>
              )}
            </div>
          )}

          {selectedSessionId && messagesLoading && (
            <div className="sb-skeleton-area">
              {[1, 2, 3].map(i => (
                <div key={i} className="sb-skeleton-message">
                  <div className="sb-skeleton sb-skeleton-line sb-skeleton-line--short" />
                  <div className="sb-skeleton-gap" />
                  <div className="sb-skeleton sb-skeleton-line sb-skeleton-line--full" />
                  <div className="sb-skeleton sb-skeleton-line sb-skeleton-line--medium" />
                </div>
              ))}
            </div>
          )}

          {selectedSessionId && !messagesLoading && (
            <MessageList
              messages={messages}
              highlightKeyword={isSearchMode ? searchQuery.trim() : ''}
            />
          )}
        </div>
      </div>
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}

      {/* 删除确认弹窗 */}
      <Modal
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title="删除对话"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDeleteTarget(null)}>取消</Button>
            <Button variant="danger" loading={deleting} onClick={handleDeleteSession}>删除</Button>
          </>
        }
      >
        <p>确定要删除这条对话吗？此操作不可恢复。</p>
        {deleteTarget?.prompt && (
          <p style={{ color: 'var(--color-text-secondary)', fontSize: 13, marginTop: 8 }}>
            {deleteTarget.prompt}
          </p>
        )}
      </Modal>
    </PageShell>
  )
}
