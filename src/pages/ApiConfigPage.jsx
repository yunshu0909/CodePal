/**
 * API 配置页面
 *
 * 负责：
 * - 展示供应商卡片（Claude Official、Qwen3.5 Plus、Kimi For Coding、AICodeMirror）
 * - 显示当前使用的供应商
 * - 支持切换供应商（调用 IPC 写入配置）
 * - 支持编辑第三方供应商的 API Key（展开/收起面板）
 *
 * @module pages/ApiConfigPage
 */

import React, { useState, useEffect } from 'react'
import '../styles/api-config.css'
import Toast from '../components/Toast'

// 供应商基础配置（显示用）
const PROVIDER_BASES = [
  {
    id: 'official',
    name: 'Claude Official',
    url: 'https://www.anthropic.com/claude-code',
    icon: 'A',
    color: '#6b5ce7',
  },
  {
    id: 'qwen',
    name: 'Qwen3 Coder Plus',
    url: 'https://dashscope.aliyuncs.com/apps/anthropic',
    icon: 'Q',
    color: '#0891b2',
  },
  {
    id: 'kimi',
    name: 'Kimi For Coding',
    url: 'https://api.kimi.com/coding/',
    icon: 'K',
    color: '#4f46e5',
  },
  {
    id: 'aicodemirror',
    name: 'AICodeMirror',
    url: 'https://api.aicodemirror.com/api/claudecode',
    icon: 'X',
    color: '#d97706',
  },
]

/**
 * API 配置页面组件
 * @returns {JSX.Element}
 */
export default function ApiConfigPage() {
  // 当前选中的供应商
  const [currentProvider, setCurrentProvider] = useState('official')
  // 正在编辑的供应商（展开编辑面板）
  const [editingProvider, setEditingProvider] = useState(null)
  // 是否正在加载
  const [isLoading, setIsLoading] = useState(true)
  // 是否正在切换中（防止重复点击）
  const [isSwitching, setIsSwitching] = useState(false)
  // 是否正在保存 API Key（防止重复提交）
  const [isSavingToken, setIsSavingToken] = useState(false)
  // Toast 提示
  const [toast, setToast] = useState(null)
  // 供应商数据（包含自定义 token）
  const [providers, setProviders] = useState(PROVIDER_BASES)
  // 是否是从 custom 档检测到的
  const [isCustomDetected, setIsCustomDetected] = useState(false)
  // 环境变量文件路径提示
  const [envPathHint, setEnvPathHint] = useState('.env')

  // 页面加载时获取当前配置
  useEffect(() => {
    const loadCurrentProvider = async () => {
      try {
        setIsLoading(true)
        const envConfigPromise = typeof window.electronAPI.getProviderEnvConfig === 'function'
          ? window.electronAPI.getProviderEnvConfig()
          : Promise.resolve({ success: false, errorCode: 'UNSUPPORTED_API' })

        const [providerResult, envConfigResult] = await Promise.all([
          window.electronAPI.getClaudeProvider(),
          envConfigPromise,
        ])

        if (providerResult.success) {
          // 处理各种状态
          if (providerResult.current === 'custom') {
            setIsCustomDetected(true)
            setCurrentProvider('official') // 显示为 official 但标记为 custom
          } else {
            setCurrentProvider(providerResult.current)
          }

          // 显示配置损坏警告
          if (providerResult.errorCode === 'CONFIG_CORRUPTED') {
            setToast(providerResult.error)
          }

          // 首次使用提示
          if (providerResult.isNew) {
            setToast('首次使用，将自动创建 .env 配置文件')
          }
        } else {
          setToast(providerResult.error || '获取当前配置失败')
        }

        if (envConfigResult?.providers) {
          setProviders((prev) =>
            prev.map((provider) => {
              const token = envConfigResult.providers[provider.id]?.token
              if (typeof token !== 'string') return provider
              return { ...provider, token }
            })
          )
        }

        if (envConfigResult?.envPath) {
          setEnvPathHint(envConfigResult.envPath)
        }

        if (envConfigResult?.errorCode && envConfigResult.errorCode !== 'UNSUPPORTED_API') {
          setToast(envConfigResult.error || '读取环境变量失败')
        }
      } catch (error) {
        console.error('Error loading provider:', error)
        setToast('获取当前配置失败')
      } finally {
        setIsLoading(false)
      }
    }

    loadCurrentProvider()
  }, [])

  /**
   * 获取当前供应商名称
   * @returns {string}
   */
  const getCurrentProviderName = () => {
    if (isCustomDetected) {
      return '自定义配置 (Custom)'
    }
    const provider = providers.find((p) => p.id === currentProvider)
    return provider?.name || ''
  }

  /**
   * 处理启用供应商
   * @param {string} providerId - 供应商 ID
   */
  const handleEnableProvider = async (providerId) => {
    if (isSwitching || providerId === currentProvider) return

    // 从 custom 档切换时提示确认
    if (isCustomDetected) {
      const confirmed = window.confirm(
        '检测到当前使用的是自定义配置，切换后将丢失自定义设置。\n\n是否继续？'
      )
      if (!confirmed) return
    }

    try {
      setIsSwitching(true)
      const result = await window.electronAPI.switchClaudeProvider(providerId)

      if (result.success) {
        setCurrentProvider(providerId)
        setEditingProvider(null)
        setIsCustomDetected(false) // 重置 custom 检测状态
        setToast(`已切换至 ${PROVIDER_BASES.find(p => p.id === providerId)?.name}`)
      } else {
        // 根据错误代码显示具体错误
        const errorMessages = {
          'PERMISSION_DENIED': '权限被拒绝：无法写入 .env 文件',
          'DISK_FULL': '磁盘空间不足，无法保存配置',
          'INVALID_PROFILE_KEY': '无效的供应商档位',
          'MISSING_API_KEY': '请先编辑并保存该供应商的 API Key',
        }
        setToast(errorMessages[result.errorCode] || `切换失败: ${result.error || '未知错误'}`)
      }
    } catch (error) {
      console.error('Error switching provider:', error)
      setToast('切换失败')
    } finally {
      setIsSwitching(false)
    }
  }

  /**
   * 处理编辑 API Key
   * @param {string} providerId - 供应商 ID
   */
  const handleEditToken = (providerId) => {
    setEditingProvider(editingProvider === providerId ? null : providerId)
  }

  /**
   * 处理取消编辑
   */
  const handleCancelEdit = () => {
    setEditingProvider(null)
  }

  /**
   * 处理保存 API Key
   * @param {string} providerId - 供应商 ID
   * @param {string} token - API Key
   */
  const handleSaveToken = async (providerId, token) => {
    const normalizedToken = token.trim()
    if (!normalizedToken) {
      setToast('API Key 不能为空')
      return
    }

    try {
      setIsSavingToken(true)
      const result = await window.electronAPI.saveProviderToken(providerId, normalizedToken)

      if (!result.success) {
        const errorMessages = {
          'INVALID_PROVIDER': '该供应商不支持保存 API Key',
          'INVALID_TOKEN': 'API Key 不能为空',
          'PERMISSION_DENIED': '权限被拒绝：无法写入 .env 文件',
          'READ_FAILED': '读取 .env 文件失败',
          'WRITE_FAILED': '写入 .env 文件失败',
          'RENAME_FAILED': '写入 .env 文件失败',
        }
        setToast(errorMessages[result.errorCode] || result.error || '保存 API Key 失败')
        return
      }

      setProviders((prev) =>
        prev.map((p) => (p.id === providerId ? { ...p, token: normalizedToken } : p))
      )

      if (result.envPath) {
        setEnvPathHint(result.envPath)
      }

      setEditingProvider(null)
      setToast('API Key 已保存到环境变量')
    } catch (error) {
      console.error('Error saving API token:', error)
      setToast('保存 API Key 失败')
    } finally {
      setIsSavingToken(false)
    }
  }

  return (
    <div className="api-config-page">
      <div className="page-container">
        <div className="page-content">
          {/* 页面头部 */}
          <section className="page-header">
            <h1>API 配置</h1>
            <p>切换 Claude Code 的 API 接入点</p>
          </section>

          {isLoading ? (
            <div className="loading-state">加载中...</div>
          ) : (
            <>
              {/* 当前使用状态卡片 */}
              <section className="card status-card">
                <div className="status-label">当前使用</div>
                <div className="status-value">{getCurrentProviderName()}</div>
              </section>

              {/* 供应商选择区域 */}
              <section className="provider-section">
                <h2 className="section-title">选择 API 接入点</h2>
                <div className="provider-list">
                  {providers.map((provider) => (
                    <ProviderCard
                      key={provider.id}
                      provider={provider}
                      isSelected={currentProvider === provider.id}
                      isEditing={editingProvider === provider.id}
                      isSwitching={isSwitching}
                      isSavingToken={isSavingToken}
                      envPathHint={envPathHint}
                      onEnable={() => handleEnableProvider(provider.id)}
                      onEdit={() => handleEditToken(provider.id)}
                      onCancelEdit={handleCancelEdit}
                      onSaveToken={(token) => handleSaveToken(provider.id, token)}
                    />
                  ))}
                </div>
              </section>
            </>
          )}
        </div>
      </div>

      {/* Toast */}
      {toast && <Toast message={toast} onClose={() => setToast(null)} />}
    </div>
  )
}

/**
 * 供应商卡片组件
 * @param {Object} props
 * @param {Object} props.provider - 供应商数据
 * @param {boolean} props.isSelected - 是否当前选中
 * @param {boolean} props.isEditing - 是否正在编辑
 * @param {boolean} props.isSwitching - 是否正在切换中
 * @param {boolean} props.isSavingToken - 是否正在保存 API Key
 * @param {string} props.envPathHint - 环境变量路径提示
 * @param {Function} props.onEnable - 启用回调
 * @param {Function} props.onEdit - 编辑回调
 * @param {Function} props.onCancelEdit - 取消编辑回调
 * @param {Function} props.onSaveToken - 保存 Token 回调
 * @returns {JSX.Element}
 */
function ProviderCard({
  provider,
  isSelected,
  isEditing,
  isSwitching,
  isSavingToken,
  envPathHint,
  onEnable,
  onEdit,
  onCancelEdit,
  onSaveToken,
}) {
  // 本地编辑状态
  const [editToken, setEditToken] = useState('')

  useEffect(() => {
    if (isEditing) {
      // 每次展开时从最新 provider token 回填，避免输入框残留旧值。
      setEditToken(provider.token || '')
    }
  }, [isEditing, provider.token])

  /**
   * 处理保存
   */
  const handleSave = () => {
    if (!editToken.trim()) return
    onSaveToken(editToken)
  }

  return (
    <>
      {/* 供应商卡片主体 */}
      <div
        className={`provider-item ${isSelected ? 'is-selected' : ''}`}
        onClick={() => {
          if (!isSelected) onEnable()
        }}
      >
        <div
          className="provider-icon"
          style={{ backgroundColor: provider.color }}
        >
          {provider.icon}
        </div>
        <div className="provider-info">
          <div className="provider-name">{provider.name}</div>
          <div className="provider-url">{provider.url}</div>
        </div>
        <div className="provider-actions">
          {isSelected ? (
            <>
              <span className="tag tag--success">当前使用</span>
              {/* 仅第三方供应商显示编辑按钮 */}
              {provider.id !== 'official' && (
                <button
                  className="btn btn--secondary btn--sm"
                  disabled={isSwitching}
                  onClick={(e) => {
                    e.stopPropagation()
                    onEdit()
                  }}
                >
                  编辑 API Key
                </button>
              )}
            </>
          ) : provider.id !== 'official' && !provider.token ? (
            // 第三方供应商未配置 API Key：显示编辑按钮引导配置
            <button
              className="btn btn--secondary btn--sm"
              disabled={isSwitching}
              onClick={(e) => {
                e.stopPropagation()
                onEdit()
              }}
            >
              编辑 API Key
            </button>
          ) : (
            // official 供应商 或 已配置 API Key 的第三方供应商
            <button
              className="btn btn--primary btn--sm"
              disabled={isSwitching}
              onClick={(e) => {
                e.stopPropagation()
                onEnable()
              }}
            >
              {isSwitching ? '切换中...' : '启用'}
            </button>
          )}
        </div>
      </div>

      {/* 编辑面板（仅展开时显示） */}
      {isEditing && (
        <div className="token-panel is-open">
          <div className="field">
            <label>API Key</label>
            <input
              type="password"
              value={editToken}
              onChange={(e) => setEditToken(e.target.value)}
              placeholder="输入 API Key..."
            />
          </div>
          <p className="field-note">
            API Key 与当前供应商只保存至 {envPathHint}（环境变量）
          </p>
          <div className="actions">
            <button
              className="btn btn--secondary btn--sm"
              disabled={isSavingToken}
              onClick={onCancelEdit}
            >
              取消
            </button>
            <button
              className="btn btn--primary btn--sm"
              disabled={isSavingToken || !editToken.trim()}
              onClick={handleSave}
            >
              {isSavingToken ? '保存中...' : '保存'}
            </button>
          </div>
        </div>
      )}
    </>
  )
}
