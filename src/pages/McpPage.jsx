/**
 * MCP 管理页面
 *
 * 负责：
 * - 展示 MCP 列表（名称、类型、命令/URL、启用状态）
 * - 提供 Toggle 开关控制各工具启用状态
 * - 搜索过滤功能
 * - 统计栏展示
 * - 加载态/空态/错误态处理
 *
 * @module pages/McpPage
 */

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import Toggle from '../components/Toggle'
import Toast from '../components/Toast'
import Tag from '../components/Tag/Tag'
import SearchInput from '../components/SearchInput/SearchInput'
import StateView from '../components/StateView/StateView'
import '../styles/mcp-page.css'
import PageShell from '../components/PageShell'

/**
 * 工具名称映射
 * @type {Object<string, string>}
 */
const TOOL_NAME_MAP = {
  claude: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  droid: 'Droid'
}

const TOGGLE_DEBOUNCE_MS = 300

/**
 * 错误码转用户提示（扫描阶段）
 * @param {string|null|undefined} errorCode - 错误码
 * @param {string|null|undefined} fallback - 后端返回的错误信息
 * @returns {string}
 */
function mapScanErrorMessage(errorCode, fallback) {
  if (errorCode === 'TOOLS_NOT_INSTALLED') {
    return '未找到 Claude Code、Codex、Cursor 或 Droid 的配置文件'
  }
  if (errorCode === 'CONFIG_PARSE_FAILED') {
    return fallback || '配置文件解析失败'
  }
  return fallback || '扫描配置文件失败'
}

/**
 * 错误码转用户提示（Toggle 阶段）
 * @param {string|null|undefined} errorCode - 错误码
 * @param {string|null|undefined} fallback - 后端返回的错误信息
 * @returns {string}
 */
function mapToggleErrorMessage(errorCode, fallback) {
  if (errorCode === 'PERMISSION_DENIED') {
    return '权限不足'
  }
  if (errorCode === 'DISK_FULL') {
    return '磁盘空间不足'
  }
  if (errorCode === 'FILE_LOCKED') {
    return '文件被锁定'
  }
  if (errorCode === 'INVALID_JSON_FORMAT' || errorCode === 'INVALID_TOML_FORMAT') {
    return fallback || '配置文件解析失败'
  }
  if (errorCode === 'SOURCE_CONFIG_NOT_FOUND') {
    return fallback || '未找到可复制的 MCP 配置，请先在另一工具中完成有效配置'
  }
  return fallback || '操作失败'
}

/**
 * MCP 管理页面组件
 * @param {Object} props - 组件属性
 * @param {boolean} [props.isActive=true] - 当前 Tab 是否激活
 * @returns {React.ReactElement}
 */
export default function McpPage({ isActive = true }) {
  // MCP 列表
  const [mcpList, setMcpList] = useState([])
  // 工具安装状态（仅包含可正常读取配置的工具）
  const [toolsInstalled, setToolsInstalled] = useState({ claude: false, codex: false, cursor: false, droid: false })
  // 搜索关键词
  const [searchQuery, setSearchQuery] = useState('')
  // 加载态
  const [loading, setLoading] = useState(true)
  // 错误信息
  const [error, setError] = useState(null)
  // 正在提交写入的 Toggle key
  const [inFlightMap, setInFlightMap] = useState(new Map())
  // Toast 提示
  const [toast, setToast] = useState(null)

  // 是否已有首次加载结果（用于“切回 Tab 静默刷新”）
  const hasLoadedOnceRef = useRef(false)
  // 上一帧激活状态
  const prevIsActiveRef = useRef(isActive)
  // 防抖定时器：key = `${mcpId}-${tool}`
  const debounceTimersRef = useRef(new Map())
  // 防抖期内待提交的最后状态
  const pendingToggleRef = useRef(new Map())
  // 写入中的 key（避免并发写同一开关）
  const inFlightKeySetRef = useRef(new Set())

  /**
   * 更新 inFlight 状态
   * @param {string} toggleKey - toggle 唯一键
   * @param {boolean} inFlight - 是否写入中
   */
  const setToggleInFlight = useCallback((toggleKey, inFlight) => {
    if (inFlight) {
      inFlightKeySetRef.current.add(toggleKey)
      setInFlightMap((prev) => new Map(prev).set(toggleKey, true))
      return
    }

    inFlightKeySetRef.current.delete(toggleKey)
    setInFlightMap((prev) => {
      const next = new Map(prev)
      next.delete(toggleKey)
      return next
    })
  }, [])

  /**
   * 加载 MCP 数据
   * @param {{silent?: boolean}} options - 加载选项
   */
  const loadMcpData = useCallback(async ({ silent = false } = {}) => {
    if (!silent) {
      setLoading(true)
      setError(null)
    }

    try {
      const result = await window.electronAPI.mcp.scanConfigs()

      if (!result.success) {
        const message = mapScanErrorMessage(result.errorCode, result.error)
        if (silent) {
          // 静默刷新失败时不打断页面，仅提示一次
          setToast({ message, type: 'warning' })
        } else {
          setError(message)
        }
        return
      }

      setMcpList(result.mcpList || [])
      setToolsInstalled(result.toolsInstalled || { claude: false, codex: false, cursor: false, droid: false })

      // 保留页面可用性：部分成功时只提示 warning，不阻断展示
      if (Array.isArray(result.warnings) && result.warnings.length > 0) {
        setToast({ message: result.warnings[0], type: 'warning' })
      }

      if (!silent) {
        setError(null)
      }
    } catch (err) {
      const message = err.message || '未知错误'
      if (silent) {
        setToast({ message, type: 'warning' })
      } else {
        setError(message)
      }
    } finally {
      if (!silent) {
        setLoading(false)
      }
      hasLoadedOnceRef.current = true
    }
  }, [])

  // 首次进入页面：正常加载
  useEffect(() => {
    loadMcpData({ silent: false })
  }, [loadMcpData])

  // 切回 MCP Tab：静默刷新（不展示 loading）
  useEffect(() => {
    const wasActive = prevIsActiveRef.current
    if (!wasActive && isActive && hasLoadedOnceRef.current) {
      loadMcpData({ silent: true })
    }
    prevIsActiveRef.current = isActive
  }, [isActive, loadMcpData])

  // 组件卸载时清理所有防抖定时器
  useEffect(() => {
    return () => {
      for (const timerId of debounceTimersRef.current.values()) {
        clearTimeout(timerId)
      }
      debounceTimersRef.current.clear()
      pendingToggleRef.current.clear()
    }
  }, [])

  /**
   * 搜索过滤后的 MCP 列表
   */
  const filteredMcpList = useMemo(() => {
    if (!searchQuery.trim()) return mcpList
    const query = searchQuery.toLowerCase()
    return mcpList.filter(
      (mcp) =>
        mcp.name.toLowerCase().includes(query) ||
        (mcp.command && mcp.command.toLowerCase().includes(query)) ||
        (mcp.url && mcp.url.toLowerCase().includes(query))
    )
  }, [mcpList, searchQuery])

  /**
   * 统计栏数据（搜索不影响总数）
   */
  const stats = useMemo(() => {
    const total = mcpList.length
    const claudeCount = mcpList.filter((m) => m.installedIn?.claude).length
    const codexCount = mcpList.filter((m) => m.installedIn?.codex).length
    const cursorCount = mcpList.filter((m) => m.installedIn?.cursor).length
    const droidCount = mcpList.filter((m) => m.installedIn?.droid).length
    return { total, claudeCount, codexCount, cursorCount, droidCount }
  }, [mcpList])

  /**
   * 执行防抖后的 Toggle 提交
   * @param {string} toggleKey - toggle 唯一键
   */
  const flushToggle = useCallback(async (toggleKey) => {
    const pending = pendingToggleRef.current.get(toggleKey)
    if (!pending) return

    pendingToggleRef.current.delete(toggleKey)
    debounceTimersRef.current.delete(toggleKey)

    // 快速来回点击后回到原状态，不触发写入
    if (pending.finalState === pending.startState) {
      return
    }

    setToggleInFlight(toggleKey, true)

    try {
      const result = await window.electronAPI.mcp.toggleMcp(
        pending.mcpId,
        pending.tool,
        pending.finalState
      )

      if (!result.success) {
        // 写入失败：回滚到本次防抖窗口开始前的状态
        setMcpList((prev) =>
          prev.map((mcp) =>
            mcp.id === pending.mcpId
              ? {
                  ...mcp,
                  installedIn: {
                    ...mcp.installedIn,
                    [pending.tool]: pending.startState
                  }
                }
              : mcp
          )
        )
        setToast({
          message: mapToggleErrorMessage(result.errorCode, result.error),
          type: 'error'
        })
        return
      }

      if (result.warningCode === 'CONFIG_RELOADED') {
        setToast({ message: result.warning || '配置已重新加载', type: 'warning' })
      } else {
        setToast({
          message: `已${pending.finalState ? '启用' : '停用'} ${pending.mcpId} → ${TOOL_NAME_MAP[pending.tool]}`,
          type: 'success'
        })
      }
    } catch (err) {
      setMcpList((prev) =>
        prev.map((mcp) =>
          mcp.id === pending.mcpId
            ? {
                ...mcp,
                installedIn: {
                  ...mcp.installedIn,
                  [pending.tool]: pending.startState
                }
              }
            : mcp
        )
      )
      setToast({ message: err.message || '操作失败', type: 'error' })
    } finally {
      setToggleInFlight(toggleKey, false)
    }
  }, [setToggleInFlight])

  /**
   * 处理 Toggle 切换（乐观更新 + 300ms 内只执行最后一次）
   * @param {string} mcpId - MCP ID
   * @param {string} tool - 目标工具（claude/codex）
   * @param {boolean} currentState - 当前状态
   */
  const handleToggle = useCallback((mcpId, tool, currentState) => {
    const toggleKey = `${mcpId}-${tool}`

    if (inFlightKeySetRef.current.has(toggleKey)) {
      return
    }

    const newState = !currentState

    // 乐观更新：点击后立即反映到 UI
    setMcpList((prev) =>
      prev.map((mcp) =>
        mcp.id === mcpId
          ? { ...mcp, installedIn: { ...mcp.installedIn, [tool]: newState } }
          : mcp
      )
    )

    const previousPending = pendingToggleRef.current.get(toggleKey)
    const startState = previousPending ? previousPending.startState : currentState

    pendingToggleRef.current.set(toggleKey, {
      mcpId,
      tool,
      startState,
      finalState: newState
    })

    const previousTimer = debounceTimersRef.current.get(toggleKey)
    if (previousTimer) {
      clearTimeout(previousTimer)
    }

    const timerId = setTimeout(() => {
      flushToggle(toggleKey)
    }, TOGGLE_DEBOUNCE_MS)

    debounceTimersRef.current.set(toggleKey, timerId)
  }, [flushToggle])

  /**
   * 渲染 MCP 表格
   */
  const renderTable = () => (
    <table className="mcp-table">
      <thead>
        <tr>
          <th>名称</th>
          <th>类型</th>
          {toolsInstalled.claude && (
            <th className="col-tool">
              <div className="tool-header">
                <span className="tool-dot tool-dot--claude" />
                Claude Code
              </div>
            </th>
          )}
          {toolsInstalled.codex && (
            <th className="col-tool">
              <div className="tool-header">
                <span className="tool-dot tool-dot--codex" />
                Codex
              </div>
            </th>
          )}
          {toolsInstalled.cursor && (
            <th className="col-tool">
              <div className="tool-header">
                <span className="tool-dot tool-dot--cursor" />
                Cursor
              </div>
            </th>
          )}
          {toolsInstalled.droid && (
            <th className="col-tool">
              <div className="tool-header">
                <span className="tool-dot tool-dot--droid" />
                Droid
              </div>
            </th>
          )}
        </tr>
      </thead>
      <tbody>
        {filteredMcpList.map((mcp) => (
          <tr key={mcp.id}>
            <td>
              <div className="mcp-name" title={mcp.name}>{mcp.name}</div>
              <div className="mcp-detail" title={mcp.command || mcp.url || '-'}>
                {mcp.command || mcp.url || '-'}
              </div>
            </td>
            <td>
              <Tag variant={mcp.type === 'stdio' ? 'info' : 'warning'}>{mcp.type}</Tag>
            </td>
            {toolsInstalled.claude && (
              <td className="col-tool">
                <Toggle
                  checked={Boolean(mcp.installedIn?.claude)}
                  onChange={() => handleToggle(mcp.id, 'claude', Boolean(mcp.installedIn?.claude))}
                  disabled={inFlightMap.get(`${mcp.id}-claude`)}
                />
              </td>
            )}
            {toolsInstalled.codex && (
              <td className="col-tool">
                <Toggle
                  checked={Boolean(mcp.installedIn?.codex)}
                  onChange={() => handleToggle(mcp.id, 'codex', Boolean(mcp.installedIn?.codex))}
                  disabled={inFlightMap.get(`${mcp.id}-codex`)}
                />
              </td>
            )}
            {toolsInstalled.cursor && (
              <td className="col-tool">
                <Toggle
                  checked={Boolean(mcp.installedIn?.cursor)}
                  onChange={() => handleToggle(mcp.id, 'cursor', Boolean(mcp.installedIn?.cursor))}
                  disabled={inFlightMap.get(`${mcp.id}-cursor`)}
                />
              </td>
            )}
            {toolsInstalled.droid && (
              <td className="col-tool">
                <Toggle
                  checked={Boolean(mcp.installedIn?.droid)}
                  onChange={() => handleToggle(mcp.id, 'droid', Boolean(mcp.installedIn?.droid))}
                  disabled={inFlightMap.get(`${mcp.id}-droid`)}
                />
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  )

  return (
    <PageShell title="MCP 管理" subtitle="集中管理 MCP Server，一键同步到各工具" className="page-shell--no-padding" divider>
      {/* Toolbar: Stats + Search */}
      {!loading && !error && mcpList.length > 0 && (
        <div className="mcp-toolbar">
          <div className="stats-bar">
            <div className="stat-item">
              <span>共</span>
              <span className="stat-value">{stats.total}</span>
              <span>个 MCP</span>
            </div>
            {toolsInstalled.claude && (
              <div className="stat-item">
                <span className="tool-dot tool-dot--claude" />
                <span>Claude Code</span>
                <span className="stat-value">{stats.claudeCount}</span>
              </div>
            )}
            {toolsInstalled.codex && (
              <div className="stat-item">
                <span className="tool-dot tool-dot--codex" />
                <span>Codex</span>
                <span className="stat-value">{stats.codexCount}</span>
              </div>
            )}
            {toolsInstalled.cursor && (
              <div className="stat-item">
                <span className="tool-dot tool-dot--cursor" />
                <span>Cursor</span>
                <span className="stat-value">{stats.cursorCount}</span>
              </div>
            )}
            {toolsInstalled.droid && (
              <div className="stat-item">
                <span className="tool-dot tool-dot--droid" />
                <span>Droid</span>
                <span className="stat-value">{stats.droidCount}</span>
              </div>
            )}
          </div>
          <SearchInput
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索 MCP..."
          />
        </div>
      )}

      {/* Table Container */}
      <div className="table-container">
        <StateView
          loading={loading}
          error={error}
          onRetry={() => loadMcpData({ silent: false })}
          loadingMessage="正在扫描配置文件..."
          empty={mcpList.length === 0}
          emptyMessage="未检测到 MCP"
          emptyHint="请在 Claude Code、Codex、Cursor 或 Droid 中添加 MCP 配置"
          emptyIcon="📡"
        >
          {filteredMcpList.length === 0 && searchQuery ? (
            <StateView
              empty
              emptyMessage="没有找到匹配的 MCP"
              emptyHint="试试其他关键词"
              emptyIcon="🔍"
            />
          ) : renderTable()}
        </StateView>
      </div>

      {/* Footer */}
      {!loading && !error && mcpList.length > 0 && (
        <div className="card-footer">
          <span>开关即时写入配置文件 · 修改后可能需要重启工具生效</span>
        </div>
      )}

      {/* Toast */}
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </PageShell>
  )
}
