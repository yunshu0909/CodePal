/**
 * API 配置页面
 *
 * 负责：
 * - 展示供应商卡片（内置 + 自定义注册）
 * - 显示当前使用的供应商
 * - 支持切换供应商（调用 IPC 写入配置）
 * - 支持编辑第三方供应商的 API Key（展开/收起面板）
 *
 * @module pages/ApiConfigPage
 */

import React, { useState, useEffect, useCallback } from 'react'
import '../styles/api-config.css'
import Toast from '../components/Toast'
import Tag from '../components/Tag/Tag'
import PageShell from '../components/PageShell'
import Button from '../components/Button/Button'
import StateView from '../components/StateView/StateView'

const PROVIDER_REFRESH_INTERVAL_MS = 3000

// 供应商基础配置（兜底显示用：当后端不支持动态列表时）
const PROVIDER_BASES = [
  {
    id: 'official',
    name: 'Claude Official',
    url: 'https://www.anthropic.com/claude-code',
    icon: 'A',
    color: '#6b5ce7',
    supportsToken: false,
  },
  {
    id: 'qwen',
    name: 'Qwen3 Coder Plus',
    url: 'https://dashscope.aliyuncs.com/apps/anthropic',
    icon: 'Q',
    color: '#0891b2',
    supportsToken: true,
  },
  {
    id: 'kimi',
    name: 'Kimi For Coding',
    url: 'https://api.kimi.com/coding/',
    icon: 'K',
    color: '#4f46e5',
    supportsToken: true,
  },
  {
    id: 'aicodemirror',
    name: 'AICodeMirror',
    url: 'https://api.aicodemirror.com/api/claudecode',
    icon: 'X',
    color: '#d97706',
    supportsToken: true,
  },
]

/**
 * 判断供应商是否支持 API Key 编辑
 * @param {{id: string, supportsToken?: boolean}} provider - 供应商数据
 * @returns {boolean}
 */
function isTokenManagedProvider(provider) {
  if (typeof provider.supportsToken === 'boolean') {
    return provider.supportsToken
  }
  return provider.id !== 'official'
}

/**
 * 合并后端渠道定义与本地 token 状态
 * @param {Array<Object>} incomingProviders - 后端返回的渠道定义列表
 * @param {Array<Object>} currentProviders - 当前页面 providers 状态
 * @returns {Array<Object>}
 */
function mergeProvidersWithExistingToken(incomingProviders, currentProviders) {
  const tokenMap = new Map(
    currentProviders.map((provider) => [provider.id, provider.token || ''])
  )

  return incomingProviders.map((provider) => ({
    ...provider,
    token: tokenMap.get(provider.id) || '',
  }))
}

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
  // Toast 提示 { message: string, type: 'info' | 'success' | 'error' | 'warning' }
  const [toast, setToast] = useState(null)
  // 供应商数据（包含自定义 token）
  const [providers, setProviders] = useState(PROVIDER_BASES)
  // 是否是从 custom 档检测到的
  const [isCustomDetected, setIsCustomDetected] = useState(false)
  // 环境变量文件路径提示
  const [envPathHint, setEnvPathHint] = useState('.env')

  /**
   * 同步供应商快照（当前档位 + 渠道列表 + token）
   * @param {{silent?: boolean, withLoading?: boolean}} options - 同步选项
   * @returns {Promise<void>}
   */
  const syncProviderSnapshot = useCallback(async ({ silent = false, withLoading = false } = {}) => {
    try {
      if (withLoading) {
        setIsLoading(true)
      }

      const envConfigPromise = typeof window.electronAPI.getProviderEnvConfig === 'function'
        ? window.electronAPI.getProviderEnvConfig()
        : Promise.resolve({ success: false, errorCode: 'UNSUPPORTED_API' })
      const providerDefsPromise = typeof window.electronAPI.listProviderDefinitions === 'function'
        ? window.electronAPI.listProviderDefinitions()
        : Promise.resolve({ success: false, errorCode: 'UNSUPPORTED_API' })

      const [providerResult, envConfigResult, providerDefsResult] = await Promise.all([
        window.electronAPI.getClaudeProvider(),
        envConfigPromise,
        providerDefsPromise,
      ])

      if (providerResult.success) {
        if (providerResult.current === 'custom') {
          setIsCustomDetected(true)
          setCurrentProvider('official')
        } else {
          setCurrentProvider(providerResult.current)
          setIsCustomDetected(false)
        }

        if (!silent && providerResult.errorCode === 'CONFIG_CORRUPTED') {
          setToast({ message: providerResult.error, type: 'error' })
        }
        if (!silent && providerResult.isNew) {
          setToast({ message: '首次使用，将自动创建 .env 配置文件', type: 'info' })
        }
      } else if (!silent) {
        setToast({ message: providerResult.error || '获取当前配置失败', type: 'error' })
      }

      if (
        providerDefsResult?.success &&
        Array.isArray(providerDefsResult.providers) &&
        providerDefsResult.providers.length > 0
      ) {
        setProviders((prev) =>
          mergeProvidersWithExistingToken(providerDefsResult.providers, prev)
        )
        // 渠道列表已变化时，清理无效编辑态，避免编辑已删除渠道。
        if (editingProvider && !providerDefsResult.providers.some((provider) => provider.id === editingProvider)) {
          setEditingProvider(null)
        }
      }

      if (envConfigResult?.providers) {
        setProviders((prev) =>
          prev.map((provider) => {
            if (!isTokenManagedProvider(provider)) return provider
            // 正在编辑时不覆盖本地输入，避免轮询导致输入框闪回。
            if (editingProvider && provider.id === editingProvider) return provider
            const token = envConfigResult.providers[provider.id]?.token
            if (typeof token !== 'string') return provider
            return { ...provider, token }
          })
        )
      }

      if (envConfigResult?.envPath) {
        setEnvPathHint(envConfigResult.envPath)
      }

      if (!silent && envConfigResult?.errorCode && envConfigResult.errorCode !== 'UNSUPPORTED_API') {
        setToast({ message: envConfigResult.error || '读取环境变量失败', type: 'error' })
      }
      if (!silent && providerDefsResult?.errorCode && providerDefsResult.errorCode !== 'UNSUPPORTED_API') {
        setToast({ message: providerDefsResult.error || '读取渠道列表失败', type: 'error' })
      }
    } catch (error) {
      console.error('Error loading provider:', error)
      if (!silent) {
        setToast({ message: '获取当前配置失败', type: 'error' })
      }
    } finally {
      if (withLoading) {
        setIsLoading(false)
      }
    }
  }, [editingProvider])

  // 页面加载时拉取一次，后续通过轮询 + 前台激活保持同步。
  useEffect(() => {
    let disposed = false
    const safeSync = async (options) => {
      if (disposed) return
      await syncProviderSnapshot(options)
    }

    safeSync({ withLoading: true, silent: false })

    const timerId = window.setInterval(() => {
      safeSync({ silent: true, withLoading: false })
    }, PROVIDER_REFRESH_INTERVAL_MS)

    const onVisibilityChange = () => {
      if (!document.hidden) {
        safeSync({ silent: true, withLoading: false })
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      disposed = true
      window.clearInterval(timerId)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [syncProviderSnapshot])

  /**
   * 获取当前供应商名称
   * @returns {string}
   */
  const getCurrentProviderName = () => {
    if (isCustomDetected) {
      return '自定义配置 (Custom)'
    }
    const provider = providers.find((p) => p.id === currentProvider)
    return provider?.name || currentProvider || ''
  }

  /**
   * 处理启用供应商
   * @param {string} providerId - 供应商 ID
   */
  const handleEnableProvider = async (providerId) => {
    if (isSwitching || providerId === currentProvider) return

    // 记录当前滚动位置，防止关闭面板后页面跳动
    const scrollContainer = document.querySelector('.page-shell')
    const savedScrollTop = scrollContainer?.scrollTop || 0

    try {
      setIsSwitching(true)
      const result = await window.electronAPI.switchClaudeProvider(providerId)

      if (result.success) {
        setCurrentProvider(providerId)
        setEditingProvider(null)
        setIsCustomDetected(false) // 重置 custom 检测状态
        const providerName = providers.find((provider) => provider.id === providerId)?.name || providerId
        setToast({ message: `已切换至 ${providerName}`, type: 'success' })
        await syncProviderSnapshot({ silent: true, withLoading: false })

        // 恢复滚动位置（在 DOM 更新后执行）
        requestAnimationFrame(() => {
          if (scrollContainer) {
            scrollContainer.scrollTop = savedScrollTop
          }
        })
      } else {
        // 根据错误代码显示具体错误
        const errorMessages = {
          'PERMISSION_DENIED': '权限被拒绝：无法写入 .env 文件',
          'DISK_FULL': '磁盘空间不足，无法保存配置',
          'INVALID_PROFILE_KEY': '无效的供应商档位',
          'MISSING_API_KEY': '请先编辑并保存该供应商的 API Key',
        }
        setToast({ message: errorMessages[result.errorCode] || `切换失败: ${result.error || '未知错误'}`, type: 'error' })
      }
    } catch (error) {
      console.error('Error switching provider:', error)
      setToast({ message: '切换失败', type: 'error' })
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
    // 记录当前滚动位置，防止关闭面板后页面跳动
    const scrollContainer = document.querySelector('.page-shell')
    const savedScrollTop = scrollContainer?.scrollTop || 0

    setEditingProvider(null)

    // 恢复滚动位置
    requestAnimationFrame(() => {
      if (scrollContainer) {
        scrollContainer.scrollTop = savedScrollTop
      }
    })
  }

  /**
   * 处理保存 API Key
   * @param {string} providerId - 供应商 ID
   * @param {string} token - API Key
   */
  const handleSaveToken = async (providerId, token) => {
    const normalizedToken = token.trim()
    if (!normalizedToken) {
      setToast({ message: 'API Key 不能为空', type: 'warning' })
      return
    }

    // 记录当前滚动位置，防止关闭面板后页面跳动
    const scrollContainer = document.querySelector('.page-shell')
    const savedScrollTop = scrollContainer?.scrollTop || 0

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
        setToast({ message: errorMessages[result.errorCode] || result.error || '保存 API Key 失败', type: 'error' })
        return
      }

      setProviders((prev) =>
        prev.map((p) => (p.id === providerId ? { ...p, token: normalizedToken } : p))
      )

      if (result.envPath) {
        setEnvPathHint(result.envPath)
      }

      setEditingProvider(null)
      setToast({ message: 'API Key 已保存到环境变量', type: 'success' })
      await syncProviderSnapshot({ silent: true, withLoading: false })

      // 恢复滚动位置（在 DOM 更新后执行）
      requestAnimationFrame(() => {
        if (scrollContainer) {
          scrollContainer.scrollTop = savedScrollTop
        }
      })
    } catch (error) {
      console.error('Error saving API token:', error)
      setToast({ message: '保存 API Key 失败', type: 'error' })
    } finally {
      setIsSavingToken(false)
    }
  }

  return (
    <PageShell title="API 配置" subtitle="切换 Claude Code 的 API 接入点">
      <StateView loading={isLoading}>
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
      </StateView>

      {/* Toast */}
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </PageShell>
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
  // 是否支持该渠道的 token 编辑
  const supportsToken = isTokenManagedProvider(provider)

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
              <Tag variant="success">当前使用</Tag>
              {/* 仅支持 token 的供应商显示编辑按钮 */}
              {supportsToken && (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={isSwitching}
                  onClick={(e) => { e.stopPropagation(); onEdit() }}
                >
                  编辑 API Key
                </Button>
              )}
            </>
          ) : supportsToken && !provider.token ? (
            // 需要 token 但未配置：显示编辑按钮引导配置
            <Button
              variant="secondary"
              size="sm"
              disabled={isSwitching}
              onClick={(e) => { e.stopPropagation(); onEdit() }}
            >
              编辑 API Key
            </Button>
          ) : (
            // 无 token 供应商，或已配置好 token 的供应商
            <Button
              variant="primary"
              size="sm"
              loading={isSwitching}
              onClick={(e) => { e.stopPropagation(); onEnable() }}
            >
              启用
            </Button>
          )}
        </div>
      </div>

      {/* 编辑面板（仅展开时显示） */}
      {supportsToken && isEditing && (
        <div className="token-panel is-open">
          <div className="field">
            <label>API Key</label>
            <input
              type="password"
              value={editToken}
              onChange={(e) => setEditToken(e.target.value)}
              placeholder="输入 API Key..."
              autoFocus
            />
          </div>
          <p className="field-note">
            API Key 与当前供应商只保存至 {envPathHint}（环境变量）
          </p>
          <div className="actions">
            <Button variant="secondary" size="sm" disabled={isSavingToken} onClick={onCancelEdit}>
              取消
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={isSavingToken}
              disabled={!editToken.trim()}
              onClick={handleSave}
            >
              保存
            </Button>
          </div>
        </div>
      )}
    </>
  )
}
