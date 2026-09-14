/**
 * 启动模式页面（Tab 容器）
 *
 * 负责：
 * - Tab 切换：权限模式 / 模型配置与推理等级
 * - 权限模式 Tab：展示、切换、重置和恢复 6 种启动模式
 * - 模型配置 Tab：委托给 ModelConfigTab 组件
 * - 统一管理 Toast 反馈
 *
 * @module pages/PermissionModePage
 */

import React, { useState, useEffect, useCallback } from 'react'
import '../styles/permission-mode.css'
import PageShell from '../components/PageShell'
import Button from '../components/Button/Button'
import Tag from '../components/Tag/Tag'
import StateView from '../components/StateView/StateView'
import ModelConfigTab from './ModelConfigTab'

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
    id: 'dontAsk',
    name: '仅预先授权',
    description: '只执行已允许的操作；遇到未授权操作时不再询问',
    color: '#64748b',
    icon: ShieldIcon,
  },
  {
    id: 'bypassPermissions',
    name: '全自动',
    description: 'Claude 自动执行所有操作，无需确认（谨慎使用）',
    color: '#dc2626',
    icon: ZapIcon,
  },
  {
    id: 'auto',
    name: '自动审批',
    description: '由 Claude 审批模型判断操作；可用性取决于客户端和账户',
    color: '#7c3aed',
    icon: SparklesIcon,
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

function ShieldIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/>
      <path d="m9 12 2 2 4-4"/>
    </svg>
  )
}

function SparklesIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m12 3-1.9 5.1L5 10l5.1 1.9L12 17l1.9-5.1L19 10l-5.1-1.9L12 3Z"/>
      <path d="m5 3-.6 1.4L3 5l1.4.6L5 7l.6-1.4L7 5l-1.4-.6L5 3Z"/>
    </svg>
  )
}

/**
 * Toast 提示组件（自定义时长：成功 2s，错误 4s）
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

  const icons = {
    info: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
      </svg>
    ),
    success: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
    ),
    error: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
      </svg>
    ),
    warning: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
        <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
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
 * 权限模式 Tab 内容
 * @param {Object} props
 * @param {(message: string, type: string) => void} props.onToast - Toast 回调
 * @returns {JSX.Element}
 */
function PermissionModeTab({ onToast }) {
  // 当前模式
  const [currentMode, setCurrentMode] = useState(null)
  // 是否为已配置状态
  const [isConfigured, setIsConfigured] = useState(false)
  // 是否为已知模式（用于未知模式态）
  const [isKnownMode, setIsKnownMode] = useState(true)
  // 是否存在 CodePal 生成的权限模式备份
  const [restoreAvailable, setRestoreAvailable] = useState(false)
  // 初始加载中
  const [isLoading, setIsLoading] = useState(true)
  // 切换中状态
  const [isSwitching, setIsSwitching] = useState(false)
  // 正在切换到的目标模式
  const [switchingTarget, setSwitchingTarget] = useState(null)
  // 读取失败错误信息
  const [error, setError] = useState(null)

  /**
   * 加载权限模式配置；未配置只展示状态，不产生写入。
   */
  const loadConfig = useCallback(async ({ silent = false } = {}) => {
    try {
      if (!silent) setIsLoading(true)
      setError(null)

      const result = await window.electronAPI.getPermissionModeConfig()

      if (result.success) {
        setCurrentMode(result.isConfigured ? result.mode : null)
        setIsConfigured(result.isConfigured === true)
        setIsKnownMode(result.isKnownMode !== false)
        setRestoreAvailable(result.restoreAvailable === true)
      } else {
        setError({ type: result.errorCode || 'READ_ERROR', message: result.error || '无法读取当前配置' })
        if (!silent) onToast(result.error || '无法读取当前配置', 'error')
      }
    } catch (err) {
      const msg = err?.message || '加载配置失败'
      setError({ type: 'READ_ERROR', message: msg })
      if (!silent) onToast(msg, 'error')
    } finally {
      setIsLoading(false)
    }
  }, [onToast])

  useEffect(() => {
    loadConfig({ silent: false })
  }, [loadConfig])

  /**
   * 处理模式切换
   * @param {string} mode - 目标模式
   */
  const handleSwitchMode = async (mode) => {
    if (mode === currentMode && isConfigured) return
    if (isSwitching) return

    try {
      setIsSwitching(true)
      setSwitchingTarget(mode)

      const result = await window.electronAPI.setPermissionMode(mode)

      if (result.success) {
        setCurrentMode(mode)
        setIsConfigured(true)
        setIsKnownMode(true)
        setRestoreAvailable(Boolean(result.backupPath) || restoreAvailable)
        const modeName = PERMISSION_MODES.find((m) => m.id === mode)?.name || mode
        if (result.managedNotice) {
          // 托管设置优先级更高（或被托管但读不出）：写入成功也可能不生效，不能宣称「已切换」
          onToast(result.managedNotice, 'error')
        } else {
          onToast(`已切换至「${modeName}」`, 'success')
        }
      } else {
        const errorMessages = {
          PERMISSION_DENIED: '切换失败，无法写入配置文件（权限不足）',
          DISK_FULL: '切换失败，磁盘空间不足',
          BACKUP_FAILED: '切换失败，无法备份原配置',
          WRITE_ERROR: '切换失败，无法写入配置文件',
          INVALID_MODE: '无效的模式选择',
        }
        onToast(errorMessages[result.errorCode] || result.error || '切换失败', 'error')
      }
    } catch (err) {
      onToast(err?.message || '切换失败，未知错误', 'error')
    } finally {
      setIsSwitching(false)
      setSwitchingTarget(null)
    }
  }

  const handleResetMode = async () => {
    if (!isConfigured || isSwitching) return
    try {
      setIsSwitching(true)
      const result = await window.electronAPI.resetPermissionMode()
      if (!result.success) {
        onToast(result.error || '恢复客户端默认失败', 'error')
        return
      }
      setCurrentMode(null)
      setIsConfigured(false)
      setIsKnownMode(true)
      setRestoreAvailable(result.restoreAvailable !== false)
      onToast(result.managedNotice || '已恢复 Claude 客户端默认', result.managedNotice ? 'error' : 'success')
    } catch (err) {
      onToast(err?.message || '恢复客户端默认失败', 'error')
    } finally {
      setIsSwitching(false)
    }
  }

  const handleRestoreMode = async () => {
    if (!restoreAvailable || isSwitching) return
    try {
      setIsSwitching(true)
      const result = await window.electronAPI.restorePermissionMode()
      if (!result.success) {
        onToast(result.error || '恢复上次修改失败', 'error')
        return
      }
      setCurrentMode(result.mode)
      setIsConfigured(result.isConfigured === true)
      setIsKnownMode(result.isKnownMode !== false)
      setRestoreAvailable(result.restoreAvailable !== false)
      onToast(result.managedNotice || '已恢复上次权限修改', result.managedNotice ? 'error' : 'success')
    } catch (err) {
      onToast(err?.message || '恢复上次修改失败', 'error')
    } finally {
      setIsSwitching(false)
    }
  }

  const getCurrentModeDisplayName = () => {
    if (!isConfigured) return '未配置 · 由 Claude 决定'
    const effectiveMode = currentMode
    if (!isKnownMode && isConfigured) return currentMode || '未知模式'
    const mode = PERMISSION_MODES.find((m) => m.id === effectiveMode)
    return mode?.name || effectiveMode || '未知'
  }

  const getCurrentModeColor = () => {
    if (!isKnownMode && isConfigured) return '#f59e0b'
    if (!isConfigured) return '#6b7280'
    const effectiveMode = currentMode
    const mode = PERMISSION_MODES.find((m) => m.id === effectiveMode)
    return mode?.color || '#6b7280'
  }

  return (
    <StateView
      loading={isLoading}
      error={error?.message}
      onRetry={() => loadConfig({ silent: false })}
      loadingMessage="正在读取配置..."
    >
      {/* 状态卡片 */}
      <section
        className={`card status-card ${!isKnownMode && isConfigured ? 'status-card--warn' : ''}`}
        data-testid="permission-status-card"
      >
        <div className="status-label">当前模式</div>
        <div className="status-value" style={{ color: getCurrentModeColor() }} data-testid="permission-current-mode">
          {getCurrentModeDisplayName()}
        </div>
      </section>

      <div className="config-header">
        <div>
          <Button variant="secondary" size="sm" disabled={!isConfigured || isSwitching} onClick={handleResetMode}>
            恢复客户端默认
          </Button>
          {' '}
          <Button variant="ghost" size="sm" disabled={!restoreAvailable || isSwitching} onClick={handleRestoreMode}>
            恢复上次修改
          </Button>
        </div>
      </div>

      {/* 警告 Banner */}
      {!isKnownMode && isConfigured && (
        <div className="warn-banner" data-testid="permission-warn-banner">
          <span className="warn-banner__icon">⚠️</span>
          <span className="warn-banner__text">
            检测到未知的启动模式「{currentMode}」，请选择有效的模式进行切换
          </span>
        </div>
      )}

      {/* 模式列表 */}
      <section className="mode-section" data-testid="permission-mode-section">
        <h2 className="section-title">选择启动模式</h2>
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
                <div className="mode-icon" style={{ backgroundColor: mode.color }}>
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
    </StateView>
  )
}

/**
 * 启动模式页面（Tab 容器）
 * @returns {JSX.Element}
 */
export default function PermissionModePage() {
  // 当前激活的 Tab
  const [activeTab, setActiveTab] = useState('permission')
  // Toast 状态
  const [toast, setToast] = useState(null)

  /**
   * 统一 Toast 回调，供两个 Tab 使用
   * @param {string} message - 提示消息
   * @param {string} type - 提示类型
   */
  const handleToast = useCallback((message, type) => {
    setToast({ message, type })
  }, [])

  return (
    <PageShell title="启动模式" subtitle="配置 Claude Code 的默认启动参数，下次启动时自动生效" data-testid="permission-mode-page">
      {/* Tab 切换 */}
      <div className="tab-bar">
        <button
          className={`tab-item ${activeTab === 'permission' ? 'active' : ''}`}
          onClick={() => setActiveTab('permission')}
        >
          权限模式
        </button>
        <button
          className={`tab-item ${activeTab === 'model' ? 'active' : ''}`}
          onClick={() => setActiveTab('model')}
        >
          模型配置与推理等级
        </button>
      </div>

      {/* Tab 内容 */}
      {activeTab === 'permission' && <PermissionModeTab onToast={handleToast} />}
      {activeTab === 'model' && <ModelConfigTab onToast={handleToast} />}

      {/* Toast */}
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </PageShell>
  )
}
