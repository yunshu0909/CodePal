/**
 * 权限模式（启动模式）配置页面
 *
 * 负责：
 * - 展示当前 Claude Code 的启动模式配置
 * - 支持切换 4 种启动模式：只读规划、每次询问、自动编辑、全自动
 * - 处理 6 种页面状态：正常态、加载态、未配置态、未知模式态、读取失败态、切换中
 * - 配置写入 ~/.claude/settings.json 的 permissions.defaultMode 字段
 *
 * 模式说明：
 * - plan: 只读规划（--plan），绿色 #059669
 * - default: 每次询问（默认），蓝色 #2563eb
 * - acceptEdits: 自动编辑（--accept-edits），橙色 #d97706
 * - bypassPermissions: 全自动（--bypass-permissions），红色 #dc2626
 *
 * @module pages/PermissionModePage
 */

import React, { useState, useEffect, useCallback } from 'react'
import '../styles/permission-mode.css'
import PageShell from '../components/PageShell'
import Button from '../components/Button/Button'
import Tag from '../components/Tag/Tag'
import StateView from '../components/StateView/StateView'

// 模式定义（顺序固定）
const PERMISSION_MODES = [
  {
    id: 'plan',
    name: '只读规划',
    description: 'Claude 只读文件并给出规划，不执行任何操作',
    color: '#059669',
    icon: EyeIcon,
  },
  {
    id: 'default',
    name: '每次询问',
    description: 'Claude 每次执行操作前都会征求你的确认',
    color: '#2563eb',
    icon: MessageCircleIcon,
  },
  {
    id: 'acceptEdits',
    name: '自动编辑',
    description: '自动接受文件改动，命令执行网络访问仍需要确认',
    color: '#d97706',
    icon: FilePenIcon,
  },
  {
    id: 'bypassPermissions',
    name: '全自动',
    description: 'Claude 自动执行所有操作，无需确认（谨慎使用）',
    color: '#dc2626',
    icon: ZapIcon,
  },
]

// Toast 显示时长（毫秒）
const TOAST_DURATION = { success: 2000, error: 4000, warning: 4000 }

/**
 * 只读规划 - Eye 图标
 * @returns {JSX.Element}
 */
function EyeIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/>
      <circle cx="12" cy="12" r="3"/>
    </svg>
  )
}

/**
 * 每次询问 - MessageCircle 图标
 * @returns {JSX.Element}
 */
function MessageCircleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>
    </svg>
  )
}

/**
 * 自动编辑 - FilePen 图标
 * @returns {JSX.Element}
 */
function FilePenIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12.5 22H18a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v9.5"/>
      <path d="M14 2v4a2 2 0 0 0 2 2h4"/>
      <path d="M13.378 15.378a2.12 2.12 0 0 0-3 0L8 17.757V22h4.243l2.379-2.379a2.12 2.12 0 0 0 0-3Z"/>
    </svg>
  )
}

/**
 * 全自动 - Zap 图标
 * @returns {JSX.Element}
 */
function ZapIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
    </svg>
  )
}

/**
 * Spinner 加载图标
 * @returns {JSX.Element}
 */
function SpinnerIcon() {
  return (
    <svg className="spinner" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="2" x2="12" y2="6"/>
      <line x1="12" y1="18" x2="12" y2="22"/>
      <line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/>
      <line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/>
      <line x1="2" y1="12" x2="6" y2="12"/>
      <line x1="18" y1="12" x2="22" y2="12"/>
      <line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/>
      <line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/>
    </svg>
  )
}

/**
 * Toast 提示组件
 * @param {Object} props - 组件属性
 * @param {string} props.message - 提示消息内容
 * @param {Function} props.onClose - 关闭回调
 * @param {'info'|'success'|'error'|'warning'} [props.type='info'] - 提示类型
 * @returns {JSX.Element}
 */
function Toast({ message, onClose, type = 'info' }) {
  const [show, setShow] = useState(false)

  useEffect(() => {
    requestAnimationFrame(() => setShow(true))
    const duration = TOAST_DURATION[type] || TOAST_DURATION.info
    const timer = setTimeout(() => {
      setShow(false)
      setTimeout(onClose, 300)
    }, duration)
    return () => clearTimeout(timer)
  }, [onClose, type])

  // 各类型对应的图标
  const icons = {
    info: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10"/>
        <line x1="12" y1="16" x2="12" y2="12"/>
        <line x1="12" y1="8" x2="12.01" y2="8"/>
      </svg>
    ),
    success: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
    ),
    error: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10"/>
        <line x1="15" y1="9" x2="9" y2="15"/>
        <line x1="9" y1="9" x2="15" y2="15"/>
      </svg>
    ),
    warning: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
        <line x1="12" y1="9" x2="12" y2="13"/>
        <line x1="12" y1="17" x2="12.01" y2="17"/>
      </svg>
    ),
  }

  return (
    <div className={`toast toast--${type} ${show ? 'show' : ''}`}>
      <span className="toast__icon">{icons[type] || icons.info}</span>
      <span className="toast__message">{message}</span>
    </div>
  )
}

/**
 * 权限模式页面组件
 * @returns {JSX.Element}
 */
export default function PermissionModePage() {
  // 当前模式
  const [currentMode, setCurrentMode] = useState(null)
  // 是否为已配置状态
  const [isConfigured, setIsConfigured] = useState(false)
  // 是否为已知模式（用于未知模式态）
  const [isKnownMode, setIsKnownMode] = useState(true)
  // 初始加载中
  const [isLoading, setIsLoading] = useState(true)
  // 切换中状态
  const [isSwitching, setIsSwitching] = useState(false)
  // 正在切换到的目标模式
  const [switchingTarget, setSwitchingTarget] = useState(null)
  // 读取失败错误信息
  const [error, setError] = useState(null)
  // Toast 状态
  const [toast, setToast] = useState(null)

  /**
   * 加载权限模式配置
   * 如果未配置，自动写入「每次询问」作为默认值
   * @param {{silent?: boolean}} options - 加载选项
   */
  const loadConfig = useCallback(async ({ silent = false } = {}) => {
    try {
      if (!silent) {
        setIsLoading(true)
      }
      setError(null)

      const result = await window.electronAPI.getPermissionModeConfig()

      if (result.success) {
        // 未配置时，自动写入「每次询问」
        if (!result.isConfigured) {
          const setResult = await window.electronAPI.setPermissionMode('default')
          if (setResult.success) {
            setCurrentMode('default')
            setIsConfigured(true)
            setIsKnownMode(true)
          } else {
            // 自动写入失败，仍按未配置状态显示
            setCurrentMode(null)
            setIsConfigured(false)
            setIsKnownMode(true)
          }
        } else {
          setCurrentMode(result.mode)
          setIsConfigured(result.isConfigured)
          setIsKnownMode(result.isKnownMode !== false)
        }
      } else {
        setError({
          type: result.errorCode || 'READ_ERROR',
          message: result.error || '无法读取当前配置',
        })
        if (!silent) {
          setToast({ message: result.error || '无法读取当前配置', type: 'error' })
        }
      }
    } catch (err) {
      const errorMessage = err?.message || '加载配置失败'
      setError({
        type: 'READ_ERROR',
        message: errorMessage,
      })
      if (!silent) {
        setToast({ message: errorMessage, type: 'error' })
      }
    } finally {
      setIsLoading(false)
    }
  }, [])

  // 页面挂载时加载配置
  useEffect(() => {
    loadConfig({ silent: false })
  }, [loadConfig])

  /**
   * 处理模式切换
   * @param {string} mode - 目标模式
   */
  const handleSwitchMode = async (mode) => {
    // 幂等保护：已是当前模式不触发
    if (mode === currentMode && isConfigured) {
      return
    }

    // 防重：切换中不响应
    if (isSwitching) {
      return
    }

    try {
      setIsSwitching(true)
      setSwitchingTarget(mode)

      const result = await window.electronAPI.setPermissionMode(mode)

      if (result.success) {
        // 更新当前模式
        setCurrentMode(mode)
        setIsConfigured(true)
        setIsKnownMode(true)

        // 显示成功 Toast
        const modeName = PERMISSION_MODES.find((m) => m.id === mode)?.name || mode
        setToast({ message: `已切换至「${modeName}」`, type: 'success' })
      } else {
        // 显示错误 Toast
        const errorMessages = {
          PERMISSION_DENIED: '切换失败，无法写入配置文件（权限不足）',
          DISK_FULL: '切换失败，磁盘空间不足',
          BACKUP_FAILED: '切换失败，无法备份原配置',
          WRITE_ERROR: '切换失败，无法写入配置文件',
          INVALID_MODE: '无效的模式选择',
        }
        setToast({
          message: errorMessages[result.errorCode] || result.error || '切换失败',
          type: 'error',
        })
      }
    } catch (err) {
      setToast({
        message: err?.message || '切换失败，未知错误',
        type: 'error',
      })
    } finally {
      setIsSwitching(false)
      setSwitchingTarget(null)
    }
  }

  /**
   * 获取当前模式显示名称
   * @returns {string}
   */
  const getCurrentModeDisplayName = () => {
    // 未配置时，显示「每次询问」作为默认
    const effectiveMode = !isConfigured ? 'default' : currentMode
    if (!isKnownMode && isConfigured) {
      return currentMode || '未知模式'
    }
    const mode = PERMISSION_MODES.find((m) => m.id === effectiveMode)
    return mode?.name || effectiveMode || '未知'
  }

  /**
   * 获取当前模式颜色
   * @returns {string}
   */
  const getCurrentModeColor = () => {
    if (!isKnownMode && isConfigured) {
      return '#f59e0b' // 橙色（警告）
    }
    // 未配置时，使用「每次询问」的蓝色
    const effectiveMode = !isConfigured ? 'default' : currentMode
    const mode = PERMISSION_MODES.find((m) => m.id === effectiveMode)
    return mode?.color || '#6b7280'
  }

  /**
   * 渲染状态卡片
   * @returns {JSX.Element}
   */
  const renderStatusCard = () => {
    const isWarn = !isKnownMode && isConfigured

    return (
      <section
        className={`card status-card ${isWarn ? 'status-card--warn' : ''}`}
        data-testid="permission-status-card"
      >
        <div className="status-label">当前模式</div>
        <div className="status-value" style={{ color: getCurrentModeColor() }} data-testid="permission-current-mode">
          {getCurrentModeDisplayName()}
        </div>
      </section>
    )
  }

  /**
   * 渲染警告 Banner（未知模式时）
   * @returns {JSX.Element|null}
   */
  const renderWarnBanner = () => {
    if (isKnownMode || !isConfigured) {
      return null
    }

    return (
      <div className="warn-banner" data-testid="permission-warn-banner">
        <span className="warn-banner__icon">⚠️</span>
        <span className="warn-banner__text">
          检测到未知的启动模式「{currentMode}」，请选择有效的模式进行切换
        </span>
      </div>
    )
  }

  /**
   * 渲染模式列表
   * @returns {JSX.Element}
   */
  const renderModeList = () => {
    return (
      <section className="mode-section" data-testid="permission-mode-section">
        <h2 className="section-title">选择启动模式</h2>
        {renderWarnBanner()}
        <div className="mode-list" data-testid="permission-mode-list">
          {PERMISSION_MODES.map((mode) => {
            const isSelected = currentMode === mode.id && isConfigured && isKnownMode
            const isTargetSwitching = switchingTarget === mode.id

            return (
              <div
                key={mode.id}
                className={`mode-item ${isSelected ? 'is-selected' : ''}`}
                data-testid={`permission-mode-item-${mode.id}`}
              >
                <div
                  className="mode-icon"
                  style={{ backgroundColor: mode.color }}
                >
                  <mode.icon />
                </div>
                <div className="mode-info">
                  <div className="mode-name">{mode.name}</div>
                  <div className="mode-desc">{mode.description}</div>
                </div>
                <div className="mode-actions">
                  {isSelected ? (
                    <Tag variant="success" data-testid={`permission-tag-current-${mode.id}`}>当前使用</Tag>
                  ) : (
                    <Button
                      variant="primary"
                      size="sm"
                      loading={isTargetSwitching}
                      disabled={isSwitching}
                      onClick={() => handleSwitchMode(mode.id)}
                      data-testid={`permission-switch-button-${mode.id}`}
                    >
                      启用
                    </Button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </section>
    )
  }

  return (
    <PageShell title="启动模式" subtitle="配置 Claude Code 的默认启动权限模式" data-testid="permission-mode-page">
      {/* 内容区域 */}
      <StateView
        loading={isLoading}
        error={error?.message}
        onRetry={() => loadConfig({ silent: false })}
        loadingMessage="正在读取配置..."
      >
        {renderStatusCard()}
        {renderModeList()}
      </StateView>

      {/* Toast */}
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </PageShell>
  )
}
