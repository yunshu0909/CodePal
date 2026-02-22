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

import React, { useState, useEffect, useCallback, useMemo } from 'react'
import '../styles/api-config.css'
import Toast from '../components/Toast'
import Tag from '../components/Tag/Tag'
import PageShell from '../components/PageShell'
import Button from '../components/Button/Button'
import StateView from '../components/StateView/StateView'

const PROVIDER_REFRESH_INTERVAL_MS = 3000
const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/
const ENV_KEY_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/
const HIDDEN_PROVIDER_IDS_STORAGE_KEY = 'api-config-hidden-provider-ids-v1'

// 供应商基础配置（兜底显示用：当后端不支持动态列表时）
const PROVIDER_BASES = [
  {
    id: 'official',
    name: 'Claude Official',
    url: 'https://www.anthropic.com/claude-code',
    icon: 'A',
    color: '#6b5ce7',
    model: 'opus',
    models: ['opus'],
    supportsToken: false,
  },
]

/**
 * 规范化渠道模型列表
 * @param {Object} provider - 渠道数据
 * @returns {string[]}
 */
function getProviderModels(provider) {
  const normalized = Array.isArray(provider.models)
    ? provider.models
      .map((model) => (typeof model === 'string' ? model.trim() : ''))
      .filter(Boolean)
    : []
  if (normalized.length > 0) return Array.from(new Set(normalized))

  const fallback = typeof provider.model === 'string' ? provider.model.trim() : ''
  return [fallback || 'opus']
}

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
    models: getProviderModels(provider),
    token: tokenMap.get(provider.id) || '',
  }))
}

/**
 * 读取被隐藏的渠道 ID 列表
 * @returns {string[]}
 */
function readHiddenProviderIds() {
  try {
    const raw = window.localStorage.getItem(HIDDEN_PROVIDER_IDS_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((id) => (typeof id === 'string' ? id.trim() : ''))
      .filter(Boolean)
  } catch {
    return []
  }
}

/**
 * 持久化被隐藏的渠道 ID 列表
 * @param {string[]} ids - 渠道 ID 列表
 * @returns {void}
 */
function writeHiddenProviderIds(ids) {
  try {
    window.localStorage.setItem(HIDDEN_PROVIDER_IDS_STORAGE_KEY, JSON.stringify(ids))
  } catch {
    // ignore
  }
}

function createEmptyDroidModel() {
  return {
    model_display_name: '',
    model: '',
  }
}

/**
 * 创建空的 Droid 服务商
 * @returns {object}
 */
function createEmptyDroidProvider() {
  return {
    id: `droid-provider-${Date.now()}`,
    name: '',
    baseUrl: '',
    apiKey: '',
    models: [createEmptyDroidModel()],
  }
}

/**
 * 从 config.json 的 custom_models 反向解析出服务商分组
 * 按 base_url + api_key 分组
 * @param {Array} customModels - config.json 中的 custom_models
 * @returns {Array} 服务商列表
 */
function parseDroidProvidersFromConfig(customModels) {
  if (!Array.isArray(customModels) || customModels.length === 0) {
    return [createEmptyDroidProvider()]
  }

  const groupMap = new Map()

  for (const item of customModels) {
    const baseUrl = String(item?.base_url || '').trim()
    const apiKey = String(item?.api_key || '').trim()
    const groupKey = `${baseUrl}|||${apiKey}`

    if (!groupMap.has(groupKey)) {
      groupMap.set(groupKey, {
        id: `droid-provider-${Date.now()}-${groupMap.size}`,
        name: extractProviderName(baseUrl),
        baseUrl,
        apiKey,
        models: [],
      })
    }

    groupMap.get(groupKey).models.push({
      model_display_name: String(item?.model_display_name || '').trim(),
      model: String(item?.model || '').trim(),
    })
  }

  const providers = Array.from(groupMap.values())
  return providers.length > 0 ? providers : [createEmptyDroidProvider()]
}

/**
 * 从 base_url 提取服务商名称
 * @param {string} baseUrl
 * @returns {string}
 */
function extractProviderName(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname
    // api.duojie.games -> duojie.games
    return host.replace(/^api\./, '')
  } catch {
    return baseUrl || '未命名服务商'
  }
}

/**
 * 将 Droid 多服务商数据合并为 config.json 的 custom_models
 * @param {Array} droidProviders - 服务商列表
 * @returns {Array} custom_models
 */
function mergeDroidProvidersToConfig(droidProviders) {
  const customModels = []

  for (const provider of droidProviders) {
    const baseUrl = String(provider.baseUrl || '').trim()
    const apiKey = String(provider.apiKey || '').trim()

    for (const model of provider.models || []) {
      const displayName = String(model.model_display_name || '').trim()
      const modelId = String(model.model || '').trim()
      if (!displayName && !modelId) continue

      customModels.push({
        model_display_name: displayName,
        model: modelId,
        base_url: baseUrl,
        api_key: apiKey,
        provider: 'anthropic',
        supports_vision: true,
        max_tokens: 8192,
      })
    }
  }

  return customModels
}

/**
 * API 配置页面组件
 * @returns {JSX.Element}
 */
export default function ApiConfigPage() {
  // 配置页签（claude/droid）
  const [configTab, setConfigTab] = useState('claude')
  // 当前选中的供应商
  const [currentProvider, setCurrentProvider] = useState(null)
  // 是否正在加载
  const [isLoading, setIsLoading] = useState(true)
  // 是否正在切换中（防止重复点击）
  const [isSwitching, setIsSwitching] = useState(false)
  // 是否正在注册第三方渠道
  const [isRegisteringProvider, setIsRegisteringProvider] = useState(false)
  // 正在测试连接的供应商 ID（null 表示无测试进行中）
  const [testingProviderId, setTestingProviderId] = useState(null)
  // 最近一次连接测试结果（用于复制）
  const [lastTestResult, setLastTestResult] = useState(null)
  // Droid 配置状态（多服务商）
  const [droidConfigPath, setDroidConfigPath] = useState('~/.factory/config.json')
  const [droidProviders, setDroidProviders] = useState([createEmptyDroidProvider()])
  const [droidImportText, setDroidImportText] = useState('')
  const [isSavingDroidConfig, setIsSavingDroidConfig] = useState(false)
  const [isBuildingDroidTemplate, setIsBuildingDroidTemplate] = useState(false)
  // 当前正在编辑的 Droid 服务商索引（null 表示未展开编辑）
  const [editingDroidProviderIndex, setEditingDroidProviderIndex] = useState(null)
  // 是否显示 Droid 添加/编辑表单
  const [showDroidForm, setShowDroidForm] = useState(false)
  // Droid 表单模式 'create' | 'edit'
  const [droidFormMode, setDroidFormMode] = useState('create')
  // 是否展开 Droid 高级区域
  const [showDroidAdvanced, setShowDroidAdvanced] = useState(false)
  // API Key 可见性（默认显示）
  const [showProviderToken, setShowProviderToken] = useState(true)
  const [showDroidTokenMap, setShowDroidTokenMap] = useState({})
  // Toast 提示 { message: string, type: 'info' | 'success' | 'error' | 'warning' }
  const [toast, setToast] = useState(null)
  // 供应商数据（包含自定义 token）
  const [providers, setProviders] = useState(PROVIDER_BASES)
  // 被隐藏的供应商 ID 列表（用于隐藏内置渠道）
  const [hiddenProviderIds, setHiddenProviderIds] = useState(() => readHiddenProviderIds())
  // 是否是从 custom 档检测到的
  const [isCustomDetected, setIsCustomDetected] = useState(false)
  // 新增渠道表单
  const [newProvider, setNewProvider] = useState({
    id: '',
    name: '',
    baseUrl: '',
    tokenEnvKey: '',
    token: '',
    models: ['opus'],
    modelDraft: '',
  })
  // 自定义渠道表单模式（create/edit）
  const [providerFormMode, setProviderFormMode] = useState('create')
  // 是否显示新增/编辑接入点表单
  const [showProviderForm, setShowProviderForm] = useState(false)
  // 编辑中的自定义渠道 ID
  const [editingCustomProviderId, setEditingCustomProviderId] = useState(null)
  // 每个供应商当前选中的模型
  const [selectedModelByProvider, setSelectedModelByProvider] = useState({})
  // 过滤隐藏后的可见供应商
  const visibleProviders = providers.filter((provider) => !hiddenProviderIds.includes(provider.id))
  const generatedDroidConfig = useMemo(() => {
    const customModels = mergeDroidProvidersToConfig(droidProviders)
    return { custom_models: customModels }
  }, [droidProviders])

  /**
   * 重置自定义渠道表单
   */
  const resetProviderForm = useCallback(() => {
    setProviderFormMode('create')
    setShowProviderForm(false)
    setEditingCustomProviderId(null)
    setNewProvider({
      id: '',
      name: '',
      baseUrl: '',
      tokenEnvKey: '',
      token: '',
      models: ['opus'],
      modelDraft: '',
    })
  }, [])

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
          // 自定义配置不属于已注册卡片，避免误高亮 official。
          setCurrentProvider(null)
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
        if (
          editingCustomProviderId &&
          !providerDefsResult.providers.some((provider) => provider.id === editingCustomProviderId)
        ) {
          resetProviderForm()
        }
      }

      if (envConfigResult?.providers) {
        setProviders((prev) =>
          prev.map((provider) => {
            if (!isTokenManagedProvider(provider)) return provider
            const token = envConfigResult.providers[provider.id]?.token
            if (typeof token !== 'string') return provider
            return { ...provider, token }
          })
        )
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
  }, [editingCustomProviderId, resetProviderForm])

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

  // 首次读取 Droid 配置
  useEffect(() => {
    let mounted = true
    const loadDroidConfig = async () => {
      try {
        if (typeof window.electronAPI?.getDroidConfig !== 'function') return
        const result = await window.electronAPI.getDroidConfig()
        if (!mounted) return
        if (result?.configPath) {
          setDroidConfigPath(result.configPath)
        }
        if (result?.config && typeof result.config === 'object') {
          const config = result.config
          const providers = parseDroidProvidersFromConfig(config.custom_models)
          setDroidProviders(providers)
        }
      } catch {
        // ignore
      }
    }
    loadDroidConfig()
    return () => {
      mounted = false
    }
  }, [])

  // providers 更新后，初始化/修正每个供应商的模型选择
  useEffect(() => {
    setSelectedModelByProvider((prev) => {
      const next = { ...prev }
      for (const provider of providers) {
        const models = getProviderModels(provider)
        const preferred = (next[provider.id] || '').trim()
        if (!preferred || !models.includes(preferred)) {
          const fallback = (typeof provider.model === 'string' && provider.model.trim()) || models[0] || 'opus'
          next[provider.id] = models.includes(fallback) ? fallback : models[0]
        }
      }
      return next
    })
  }, [providers])

    /**
   * 获取当前 Claude Code 供应商名称
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
   * 获取当前 Droid 配置摘要
   * @returns {string}
   */
  const getDroidStatusText = () => {
    const totalModels = droidProviders.reduce((sum, p) => sum + (p.models || []).filter(m => m.model).length, 0)
    const providerNames = droidProviders
      .filter(p => p.baseUrl)
      .map(p => p.name || extractProviderName(p.baseUrl))
    if (providerNames.length === 0) return '未配置'
    return `${providerNames.join(' + ')}（${totalModels} 个模型）`
  }

  /**
   * 处理启用供应商
   * @param {string} providerId - 供应商 ID
   */
  const handleEnableProvider = async (providerId, options = {}) => {
    const { force = false, modelOverride = null } = options
    if (isSwitching) return
    if (!force && providerId === currentProvider) return

    // 记录当前滚动位置，防止关闭面板后页面跳动
    const scrollContainer = document.querySelector('.page-shell')
    const savedScrollTop = scrollContainer?.scrollTop || 0

    try {
      setIsSwitching(true)
      const selectedModel = (typeof modelOverride === 'string' && modelOverride.trim())
        ? modelOverride.trim()
        : selectedModelByProvider[providerId]
      const result = await window.electronAPI.switchClaudeProvider(providerId, selectedModel)

      if (result.success) {
        setCurrentProvider(providerId)
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
   * 切换供应商模型（当前启用供应商将立即生效）
   * @param {string} providerId - 供应商 ID
   * @param {string} model - 模型名
   */
  const handleProviderModelChange = (providerId, model) => {
    setSelectedModelByProvider((prev) => ({ ...prev, [providerId]: model }))

    // 当前启用供应商：模型切换后立即应用
    if (providerId === currentProvider) {
      handleEnableProvider(providerId, { force: true, modelOverride: model })
    }
  }

  /**
   * 处理新增第三方渠道
   */
  const handleRegisterProvider = async () => {
    const isEditMode = providerFormMode === 'edit'
    const registerFn = isEditMode
      ? window.electronAPI.updateProviderManifest
      : window.electronAPI.registerProviderManifest
    if (typeof registerFn !== 'function') {
      setToast({ message: isEditMode ? '当前版本不支持修改第三方渠道' : '当前版本不支持新增第三方渠道', type: 'error' })
      return
    }

    const providerId = isEditMode
      ? (editingCustomProviderId || '').trim()
      : newProvider.id.trim()
    const draftModel = newProvider.modelDraft.trim()
    if (draftModel && draftModel.length > 80) {
      setToast({ message: '模型名长度不能超过 80', type: 'warning' })
      return
    }

    const normalizedModels = Array.from(
      new Set(
        [
          ...(Array.isArray(newProvider.models) ? newProvider.models : []),
          ...(draftModel ? [draftModel] : [])
        ]
          .map((item) => (typeof item === 'string' ? item.trim() : ''))
          .filter(Boolean)
      )
    )
    const manifest = {
      id: providerId,
      name: newProvider.name.trim(),
      baseUrl: newProvider.baseUrl.trim(),
      tokenEnvKey: newProvider.tokenEnvKey.trim(),
      model: normalizedModels[0] || 'opus',
      models: normalizedModels.length > 0 ? normalizedModels : ['opus'],
    }

    if (!manifest.id || !manifest.name || !manifest.baseUrl || !manifest.tokenEnvKey) {
      setToast({ message: '请填写完整的渠道信息', type: 'warning' })
      return
    }
    if (!PROVIDER_ID_PATTERN.test(manifest.id)) {
      setToast({ message: 'id 格式错误：小写字母开头，仅小写字母/数字/中划线', type: 'warning' })
      return
    }
    if (!ENV_KEY_PATTERN.test(manifest.tokenEnvKey)) {
      setToast({ message: 'tokenEnvKey 格式错误：必须全大写+下划线', type: 'warning' })
      return
    }
    if (!Array.isArray(manifest.models) || manifest.models.length < 1) {
      setToast({ message: '请至少添加 1 个模型', type: 'warning' })
      return
    }
    if (manifest.model.length > 80) {
      setToast({ message: '模型名长度不能超过 80', type: 'warning' })
      return
    }
    if (manifest.models.length > 20) {
      setToast({ message: '模型列表最多 20 个', type: 'warning' })
      return
    }
    if (manifest.models.some((model) => model.length > 80)) {
      setToast({ message: '模型列表中每个模型长度不能超过 80', type: 'warning' })
      return
    }

    try {
      setIsRegisteringProvider(true)
      const result = isEditMode
        ? await window.electronAPI.updateProviderManifest(providerId, manifest)
        : await window.electronAPI.registerProviderManifest(manifest)
      if (!result.success) {
        setToast({ message: result.error || (isEditMode ? '修改第三方渠道失败' : '新增第三方渠道失败'), type: 'error' })
        return
      }

      const normalizedToken = newProvider.token.trim()
      if (normalizedToken && typeof window.electronAPI.saveProviderToken === 'function') {
        const tokenResult = await window.electronAPI.saveProviderToken(providerId, normalizedToken)
        if (!tokenResult.success) {
          setToast({ message: tokenResult.error || '渠道已保存，但 API Key 保存失败', type: 'warning' })
        }
      }

      resetProviderForm()
      setToast({ message: isEditMode ? `已更新渠道 ${manifest.name}` : `已新增渠道 ${manifest.name}`, type: 'success' })
      await syncProviderSnapshot({ silent: true, withLoading: false })
    } catch (error) {
      console.error('Error registering provider:', error)
      setToast({ message: isEditMode ? '修改第三方渠道失败' : '新增第三方渠道失败', type: 'error' })
    } finally {
      setIsRegisteringProvider(false)
    }
  }

  /**
   * 测试当前表单的 API 连通性
   */
  const handleTestProviderConnection = async () => {
    if (typeof window.electronAPI?.testProviderConnection !== 'function') {
      setToast({ message: '当前版本不支持连接测试', type: 'error' })
      return
    }

    const baseUrl = newProvider.baseUrl.trim()
    const token = newProvider.token.trim()
    const firstModel = (Array.isArray(newProvider.models) ? newProvider.models : [])
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .find(Boolean) || 'opus'

    if (!baseUrl) {
      setToast({ message: '请先填写 Base URL', type: 'warning' })
      return
    }
    if (!token) {
      setToast({ message: '请先填写 API Key 再测试', type: 'warning' })
      return
    }

    try {
      setTestingProviderId('__new_provider_form__')
      const result = await window.electronAPI.testProviderConnection({
        baseUrl,
        token,
        model: firstModel,
      })

      if (result?.success) {
        setToast({ message: '连接测试成功', type: 'success' })
        setLastTestResult({
          type: 'success',
          title: '测试连接成功',
          message: result?.note || '接口可达，鉴权通过。',
          providerName: newProvider.name || newProvider.id || '当前表单',
        })
      } else {
        setToast({ message: result?.error || '连接测试失败', type: 'error' })
        setLastTestResult({
          type: 'error',
          title: '测试连接失败',
          message: result?.error || '连接测试失败',
          providerName: newProvider.name || newProvider.id || '当前表单',
        })
      }
    } catch (error) {
      setToast({ message: error.message || '连接测试失败', type: 'error' })
      setLastTestResult({
        type: 'error',
        title: '测试连接失败',
        message: error.message || '连接测试失败',
        providerName: newProvider.name || newProvider.id || '当前表单',
      })
    } finally {
      setTestingProviderId(null)
    }
  }

  /**
   * 测试已有供应商卡片连接
   * @param {Object} provider - 供应商
   */
  const handleTestExistingProviderConnection = async (provider) => {
    if (typeof window.electronAPI?.testProviderConnection !== 'function') {
      setToast({ message: '当前版本不支持连接测试', type: 'error' })
      return
    }
    const baseUrl = String(provider?.baseUrl || provider?.url || '').trim()
    const token = String(provider?.token || '').trim()
    const model = (selectedModelByProvider[provider.id] || getProviderModels(provider)[0] || 'opus').trim()

    if (!baseUrl) {
      setToast({ message: '该渠道缺少 Base URL', type: 'warning' })
      return
    }
    if (!token) {
      setToast({ message: '请先在编辑配置里填写 API Key', type: 'warning' })
      return
    }

    try {
      setTestingProviderId(provider.id)
      const result = await window.electronAPI.testProviderConnection({ baseUrl, token, model })
      if (result?.success) {
        setToast({ message: `${provider.name} 连接测试成功`, type: 'success' })
        setLastTestResult({
          type: 'success',
          title: '测试连接成功',
          message: result?.note || '接口可达，鉴权通过。',
          providerName: provider.name || provider.id,
        })
      } else {
        setToast({ message: result?.error || '连接测试失败', type: 'error' })
        setLastTestResult({
          type: 'error',
          title: '测试连接失败',
          message: result?.error || '连接测试失败',
          providerName: provider.name || provider.id,
        })
      }
    } catch (error) {
      setToast({ message: error.message || '连接测试失败', type: 'error' })
      setLastTestResult({
        type: 'error',
        title: '测试连接失败',
        message: error.message || '连接测试失败',
        providerName: provider.name || provider.id,
      })
    } finally {
      setTestingProviderId(null)
    }
  }

  /**
   * 复制测试结果消息
   */
  const handleCopyTestMessage = async () => {
    if (!lastTestResult?.message) {
      setToast({ message: '暂无可复制的测试消息', type: 'warning' })
      return
    }
    const content = [
      lastTestResult.title || '',
      lastTestResult.providerName ? `Provider: ${lastTestResult.providerName}` : '',
      lastTestResult.message || '',
    ].filter(Boolean).join('\n')

    try {
      await navigator.clipboard.writeText(content)
      setToast({ message: '错误消息已复制', type: 'success' })
    } catch {
      try {
        const textarea = document.createElement('textarea')
        textarea.value = content
        textarea.setAttribute('readonly', 'true')
        textarea.style.position = 'fixed'
        textarea.style.left = '-9999px'
        document.body.appendChild(textarea)
        textarea.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(textarea)
        if (ok) {
          setToast({ message: '错误消息已复制', type: 'success' })
          return
        }
      } catch {
        // ignore
      }
      setToast({ message: '复制失败，请手动复制', type: 'error' })
    }
  }

  // ==================== Droid 多服务商操作 ====================

  const handleAddDroidProvider = () => {
    setDroidProviders((prev) => [...prev, createEmptyDroidProvider()])
    setEditingDroidProviderIndex(droidProviders.length)
    setDroidFormMode('create')
    setShowDroidForm(true)
  }

  const handleStartEditDroidProvider = (pi) => {
    setEditingDroidProviderIndex(pi)
    setDroidFormMode('edit')
    setShowDroidForm(true)
  }

  const handleCancelDroidForm = () => {
    // 如果是新增模式且当前编辑的服务商还是空的，删掉它
    if (droidFormMode === 'create' && editingDroidProviderIndex !== null) {
      setDroidProviders((prev) => {
        const dp = prev[editingDroidProviderIndex]
        if (dp && !dp.name && !dp.baseUrl && !dp.apiKey) {
          const next = [...prev]
          next.splice(editingDroidProviderIndex, 1)
          return next.length > 0 ? next : [createEmptyDroidProvider()]
        }
        return prev
      })
    }
    setEditingDroidProviderIndex(null)
    setShowDroidForm(false)
    setDroidFormMode('create')
  }

  const handleRemoveDroidProvider = (providerIndex) => {
    setDroidProviders((prev) => {
      const next = [...prev]
      next.splice(providerIndex, 1)
      return next.length > 0 ? next : [createEmptyDroidProvider()]
    })
  }

  const handleChangeDroidProvider = (providerIndex, patch) => {
    setDroidProviders((prev) => {
      const next = [...prev]
      next[providerIndex] = { ...next[providerIndex], ...patch }
      return next
    })
  }

  const handleAddDroidModel = (providerIndex) => {
    setDroidProviders((prev) => {
      const next = [...prev]
      const provider = { ...next[providerIndex] }
      provider.models = [...(provider.models || []), createEmptyDroidModel()]
      next[providerIndex] = provider
      return next
    })
  }

  const handleChangeDroidModel = (providerIndex, modelIndex, patch) => {
    setDroidProviders((prev) => {
      const next = [...prev]
      const provider = { ...next[providerIndex] }
      const models = [...(provider.models || [])]
      models[modelIndex] = { ...models[modelIndex], ...patch }
      provider.models = models
      next[providerIndex] = provider
      return next
    })
  }

  const handleRemoveDroidModel = (providerIndex, modelIndex) => {
    setDroidProviders((prev) => {
      const next = [...prev]
      const provider = { ...next[providerIndex] }
      const models = [...(provider.models || [])]
      models.splice(modelIndex, 1)
      provider.models = models.length > 0 ? models : [createEmptyDroidModel()]
      next[providerIndex] = provider
      return next
    })
  }

  const handleImportDroidJson = () => {
    let parsed
    try {
      parsed = JSON.parse(droidImportText)
    } catch (error) {
      setToast({ message: `导入 JSON 解析失败: ${error.message}`, type: 'error' })
      return
    }

    const rows = Array.isArray(parsed?.custom_models) ? parsed.custom_models : null
    if (!rows) {
      setToast({ message: '导入失败：缺少 custom_models 数组', type: 'error' })
      return
    }

    const providers = parseDroidProvidersFromConfig(rows)
    const totalModels = providers.reduce((sum, p) => sum + p.models.length, 0)

    if (totalModels < 1) {
      setToast({ message: '导入失败：未发现有效模型项', type: 'error' })
      return
    }

    setDroidProviders(providers)
    setToast({ message: `已导入 ${providers.length} 个服务商、${totalModels} 个模型`, type: 'success' })
  }

  /**
   * 复制指定文本（优先 clipboard API，失败后回退 execCommand）
   * @param {string} value - 待复制文本
   * @param {string} successMessage - 成功提示
   */
  const handleCopyText = async (value, successMessage = '已复制') => {
    const content = String(value || '').trim()
    if (!content) {
      setToast({ message: '没有可复制的内容', type: 'warning' })
      return
    }

    try {
      await navigator.clipboard.writeText(content)
      setToast({ message: successMessage, type: 'success' })
    } catch {
      try {
        const textarea = document.createElement('textarea')
        textarea.value = content
        textarea.setAttribute('readonly', 'true')
        textarea.style.position = 'fixed'
        textarea.style.left = '-9999px'
        document.body.appendChild(textarea)
        textarea.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(textarea)
        if (ok) {
          setToast({ message: successMessage, type: 'success' })
          return
        }
      } catch {
        // ignore
      }
      setToast({ message: '复制失败，请手动复制', type: 'error' })
    }
  }

  /**
   * 开始编辑自定义渠道配置
   * @param {Object} provider - 渠道数据
   */
  const handleStartEditProvider = (provider) => {
    if (!provider) {
      setToast({ message: '渠道数据无效', type: 'warning' })
      return
    }

    const models = getProviderModels(provider)
    const settingsEnv = provider.settingsEnv && typeof provider.settingsEnv === 'object'
      ? provider.settingsEnv
      : {}
    const legacyAnthropicModel = typeof settingsEnv.ANTHROPIC_MODEL === 'string'
      ? settingsEnv.ANTHROPIC_MODEL.trim()
      : ''
    const mergedModels = legacyAnthropicModel && !models.includes(legacyAnthropicModel)
      ? [...models, legacyAnthropicModel]
      : models

    setProviderFormMode('edit')
    setEditingCustomProviderId(provider.id)
    setNewProvider({
      id: provider.id || '',
      name: provider.name || '',
      baseUrl: provider.baseUrl || '',
      tokenEnvKey: provider.tokenEnvKey || '',
      token: provider.token || '',
      models: mergedModels,
      modelDraft: '',
    })
    setShowProviderForm(true)
    setToast({ message: `正在编辑 ${provider.name}`, type: 'info' })
  }

  /**
   * 新增模型到表单列表
   */
  const handleAddModel = () => {
    const value = newProvider.modelDraft.trim()
    if (!value) return

    if (value.length > 80) {
      setToast({ message: '模型名长度不能超过 80', type: 'warning' })
      return
    }

    setNewProvider((prev) => {
      if ((prev.models || []).includes(value)) {
        return { ...prev, modelDraft: '' }
      }
      return {
        ...prev,
        models: [...(prev.models || []), value],
        modelDraft: '',
      }
    })
  }

  /**
   * 修改模型名称
   * @param {number} index - 模型序号
   * @param {string} value - 新模型名
   */
  const handleModelChange = (index, value) => {
    setNewProvider((prev) => {
      const next = [...(prev.models || [])]
      next[index] = value
      return { ...prev, models: next }
    })
  }

  /**
   * 删除模型
   * @param {number} index - 模型序号
   */
  const handleRemoveModel = (index) => {
    setNewProvider((prev) => {
      const next = [...(prev.models || [])]
      next.splice(index, 1)
      return { ...prev, models: next }
    })
  }

  /**
   * 删除自定义渠道配置
   * @param {Object} provider - 渠道数据
   */
  const handleDeleteProvider = async (provider) => {
    if (!provider) {
      setToast({ message: '渠道数据无效', type: 'warning' })
      return
    }
    if (provider.id === 'official') {
      setToast({ message: '官方渠道不支持删除', type: 'warning' })
      return
    }

    const confirmed = window.confirm(`确认删除渠道「${provider.name}」吗？`)
    if (!confirmed) return

    if (provider.source !== 'custom') {
      const nextHidden = Array.from(new Set([...hiddenProviderIds, provider.id]))
      setHiddenProviderIds(nextHidden)
      writeHiddenProviderIds(nextHidden)
      setToast({ message: `已隐藏渠道 ${provider.name}`, type: 'success' })
      return
    }

    if (typeof window.electronAPI.deleteProviderManifest !== 'function') {
      setToast({ message: '当前版本不支持删除第三方渠道', type: 'error' })
      return
    }

    try {
      setIsRegisteringProvider(true)
      const result = await window.electronAPI.deleteProviderManifest(provider.id)
      if (!result.success) {
        setToast({ message: result.error || '删除第三方渠道失败', type: 'error' })
        return
      }

      if (editingCustomProviderId === provider.id) {
        resetProviderForm()
      }
      setToast({ message: `已删除渠道 ${provider.name}`, type: 'success' })
      await syncProviderSnapshot({ silent: true, withLoading: false })
    } catch (error) {
      console.error('Error deleting provider:', error)
      setToast({ message: '删除第三方渠道失败', type: 'error' })
    } finally {
      setIsRegisteringProvider(false)
    }
  }

  /**
   * 恢复全部隐藏渠道
   */
  const handleRestoreHiddenProviders = () => {
    setHiddenProviderIds([])
    writeHiddenProviderIds([])
    setToast({ message: '已恢复所有隐藏渠道', type: 'success' })
  }

  /**
   * 生成 Droid 示例模板并填充到模型表单
   */
  const handleBuildDroidTemplate = async () => {
    if (typeof window.electronAPI?.buildDroidTemplate !== 'function') {
      setToast({ message: '当前版本不支持 Droid 模板', type: 'error' })
      return
    }

    // 使用第一个服务商的 base_url 和 api_key 作为模板参数
    const firstProvider = droidProviders[0]
    const baseUrl = (firstProvider?.baseUrl || '').trim()
    const apiKey = (firstProvider?.apiKey || '').trim()

    if (!apiKey || !baseUrl) {
      setToast({ message: '请先在第一个服务商中填写 Base URL 和 API Key', type: 'warning' })
      return
    }

    try {
      setIsBuildingDroidTemplate(true)
      const result = await window.electronAPI.buildDroidTemplate({
        apiKey,
        baseUrl,
      })
      if (!result?.success || !result.config) {
        setToast({ message: result?.error || '生成模板失败', type: 'error' })
        return
      }
      const providers = parseDroidProvidersFromConfig(result.config.custom_models)
      setDroidProviders(providers)
      setToast({ message: '已填充示例模型，可继续编辑后保存', type: 'success' })
    } catch (error) {
      setToast({ message: error.message || '生成模板失败', type: 'error' })
    } finally {
      setIsBuildingDroidTemplate(false)
    }
  }

  /**
   * 保存 Droid 配置
   */
  const handleSaveDroidConfig = async () => {
    if (typeof window.electronAPI?.saveDroidConfig !== 'function') {
      setToast({ message: '当前版本不支持保存 Droid 配置', type: 'error' })
      return
    }

    // 校验每个服务商
    for (let pi = 0; pi < droidProviders.length; pi += 1) {
      const provider = droidProviders[pi]
      const baseUrl = String(provider.baseUrl || '').trim()
      const apiKey = String(provider.apiKey || '').trim()

      if (!baseUrl || !apiKey) {
        setToast({ message: `服务商 ${pi + 1} 请填写 Base URL 和 API Key`, type: 'warning' })
        return
      }

      for (let mi = 0; mi < (provider.models || []).length; mi += 1) {
        const row = provider.models[mi]
        if (!String(row?.model_display_name || '').trim() || !String(row?.model || '').trim()) {
          setToast({ message: `服务商 ${pi + 1} 第 ${mi + 1} 行请填写"显示名称"和"模型 ID"`, type: 'warning' })
          return
        }
      }
    }

    const parsed = generatedDroidConfig

    try {
      setIsSavingDroidConfig(true)
      const result = await window.electronAPI.saveDroidConfig(parsed)
      if (!result?.success) {
        setToast({ message: result?.error || '保存 Droid 配置失败', type: 'error' })
        return
      }
      if (result?.configPath) {
        setDroidConfigPath(result.configPath)
      }
      setToast({ message: 'Droid 配置已保存', type: 'success' })
    } catch (error) {
      setToast({ message: error.message || '保存 Droid 配置失败', type: 'error' })
    } finally {
      setIsSavingDroidConfig(false)
    }
  }

  // ==================== 导入 / 导出 ====================

  const handleExportAllConfig = () => {
    const customProviders = providers
      .filter((p) => p.source === 'custom')
      .map(({ id, name, baseUrl, tokenEnvKey, token, models, settingsEnv, ui }) => ({
        id, name, baseUrl, tokenEnvKey, token, models, settingsEnv, ui,
      }))

    const exportData = {
      _version: 1,
      _exportedAt: new Date().toISOString(),
      claudeCode: {
        currentProvider,
        customProviders,
        selectedModelByProvider,
      },
      droid: {
        providers: droidProviders.map(({ name, baseUrl, apiKey, models }) => ({
          name, baseUrl, apiKey, models,
        })),
      },
    }

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `api-config-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
    setToast({ message: '配置已导出', type: 'success' })
  }

  const handleImportAllConfig = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json'
    input.onchange = async (e) => {
      const file = e.target.files?.[0]
      if (!file) return
      try {
        const text = await file.text()
        const data = JSON.parse(text)
        if (!data._version) {
          setToast({ message: '无效的配置文件', type: 'error' })
          return
        }

        // 还原 Claude Code 自定义供应商
        if (Array.isArray(data.claudeCode?.customProviders)) {
          for (const cp of data.claudeCode.customProviders) {
            if (!cp.id || !cp.name) continue
            try {
              await window.electronAPI.registerProviderManifest({
                id: cp.id,
                name: cp.name,
                baseUrl: cp.baseUrl || '',
                tokenEnvKey: cp.tokenEnvKey || `${cp.id.toUpperCase().replace(/-/g, '_')}_API_KEY`,
                token: cp.token || '',
                models: cp.models || ['opus'],
                settingsEnv: cp.settingsEnv || {},
                ui: cp.ui || {},
              })
            } catch {
              // 忽略单个注册失败
            }
          }
          await syncProviderSnapshot({ silent: true, withLoading: false })
        }

        // 还原 Droid 服务商
        if (Array.isArray(data.droid?.providers) && data.droid.providers.length > 0) {
          const imported = data.droid.providers.map((p) => ({
            ...createEmptyDroidProvider(),
            name: p.name || '',
            baseUrl: p.baseUrl || '',
            apiKey: p.apiKey || '',
            models: Array.isArray(p.models) ? p.models : [createEmptyDroidModel()],
          }))
          setDroidProviders(imported)
        }

        // 还原模型选择
        if (data.claudeCode?.selectedModelByProvider) {
          setSelectedModelByProvider((prev) => ({ ...prev, ...data.claudeCode.selectedModelByProvider }))
        }

        setToast({ message: '配置已导入，请检查后保存', type: 'success' })
      } catch (err) {
        setToast({ message: `导入失败: ${err.message}`, type: 'error' })
      }
    }
    input.click()
  }

  return (
    <PageShell title="API 配置" subtitle="切换 Claude Code 的 API 接入点">
      <StateView loading={isLoading}>
        <>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 12 }}>
            <Button variant="secondary" size="sm" onClick={handleExportAllConfig}>
              导出配置
            </Button>
            <Button variant="secondary" size="sm" onClick={handleImportAllConfig}>
              导入配置
            </Button>
          </div>

          {/* 当前使用状态卡片 — 按 Tab 显示对应状态 */}
          <section className="card status-card">
            <div className="status-label">
              {configTab === 'claude' ? 'Claude Code 当前使用' : 'Droid 当前配置'}
            </div>
            <div className="status-value">
              {configTab === 'claude' ? getCurrentProviderName() : getDroidStatusText()}
            </div>
          </section>

          <div className="config-tabs" role="tablist" aria-label="配置类型">
            <button
              type="button"
              role="tab"
              aria-selected={configTab === 'claude'}
              className={`config-tab-btn ${configTab === 'claude' ? 'is-active' : ''}`}
              onClick={() => setConfigTab('claude')}
            >
              Claude Code
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={configTab === 'droid'}
              className={`config-tab-btn ${configTab === 'droid' ? 'is-active' : ''}`}
              onClick={() => setConfigTab('droid')}
            >
              Droid
            </button>
          </div>

          {configTab === 'claude' && (
            <>
              {/* 供应商选择区域 */}
              <section className="provider-section">
                <h2 className="section-title">选择 API 接入点</h2>
                {hiddenProviderIds.length > 0 && (
                  <div className="field-note">
                    已隐藏 {hiddenProviderIds.length} 个渠道。
                    <button
                      type="button"
                      className="link-btn"
                      onClick={handleRestoreHiddenProviders}
                    >
                      恢复全部
                    </button>
                  </div>
                )}
                <div className="provider-list">
                  {visibleProviders.map((provider) => (
                    <ProviderCard
                      key={provider.id}
                      provider={provider}
                      isSelected={currentProvider === provider.id}
                      isSwitching={isSwitching}
                      isTestingProvider={testingProviderId === provider.id}
                      selectedModel={selectedModelByProvider[provider.id] || getProviderModels(provider)[0]}
                      onChangeModel={(model) => handleProviderModelChange(provider.id, model)}
                      onEnable={(options) => handleEnableProvider(provider.id, options)}
                      onTestConnection={() => handleTestExistingProviderConnection(provider)}
                      onEditProvider={() => handleStartEditProvider(provider)}
                      onDeleteProvider={() => handleDeleteProvider(provider)}
                    />
                  ))}
                </div>
                <div style={{ marginTop: 12 }}>
                  {!showProviderForm && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => { resetProviderForm(); setShowProviderForm(true); setProviderFormMode('create') }}
                    >
                      添加接入点
                    </Button>
                  )}
                </div>
              </section>

              {showProviderForm && (
              <section className="provider-section">
                <h2 className="section-title">
                  {providerFormMode === 'edit' ? '编辑接入点' : '新增接入点'}
                </h2>
                <div className="card custom-provider-card">
                  <p className="field-note">
                    填写名称、Base URL 和 API Key 即可添加接入点。第一项模型为默认模型。
                  </p>
                  <div className="custom-provider-grid">
                    <div className="field">
                      <label>显示名称</label>
                      <input
                        type="text"
                        value={newProvider.name}
                        onChange={(e) => {
                          const name = e.target.value
                          const autoId = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32)
                          const autoEnvKey = autoId ? `${autoId.toUpperCase().replace(/-/g, '_')}_API_KEY` : ''
                          setNewProvider((prev) => ({
                            ...prev,
                            name,
                            id: providerFormMode === 'edit' ? prev.id : (autoId || prev.id),
                            tokenEnvKey: providerFormMode === 'edit' ? prev.tokenEnvKey : (autoEnvKey || prev.tokenEnvKey),
                          }))
                        }}
                        placeholder="例如: OpenRouter"
                      />
                    </div>
                    <div className="field">
                      <label>Base URL</label>
                      <input
                        type="text"
                        value={newProvider.baseUrl}
                        onChange={(e) => setNewProvider((prev) => ({ ...prev, baseUrl: e.target.value }))}
                        placeholder="https://example.com（建议不要带 /v1）"
                      />
                    </div>
                    <div className="field">
                      <label>API Key（可选）</label>
                      <div className="key-input-row">
                        <input
                          type={showProviderToken ? 'text' : 'password'}
                          value={newProvider.token}
                          onChange={(e) => setNewProvider((prev) => ({ ...prev, token: e.target.value }))}
                          placeholder="留空则不修改"
                        />
                        <button
                          type="button"
                          className="key-visibility-btn"
                          onClick={() => setShowProviderToken((prev) => !prev)}
                          aria-label={showProviderToken ? '隐藏 API Key' : '显示 API Key'}
                          title={showProviderToken ? '隐藏 API Key' : '显示 API Key'}
                        >
                          {showProviderToken ? '👁' : '🙈'}
                        </button>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => handleCopyText(newProvider.token, 'API Key 已复制')}
                        >
                          复制
                        </Button>
                      </div>
                    </div>
                    <div className="field model-field">
                      <label>模型列表</label>
                      <div className="model-list-editor">
                        {(newProvider.models || []).map((model, index) => (
                          <div className="model-list-row" key={`${index}-${model}`}>
                            <input
                              type="text"
                              value={model}
                              onChange={(e) => handleModelChange(index, e.target.value)}
                              placeholder="输入模型名"
                            />
                            <Button
                              variant="danger"
                              size="sm"
                              onClick={() => handleRemoveModel(index)}
                            >
                              删除
                            </Button>
                          </div>
                        ))}
                        <div className="model-list-row">
                          <input
                            type="text"
                            value={newProvider.modelDraft}
                            onChange={(e) => setNewProvider((prev) => ({ ...prev, modelDraft: e.target.value }))}
                            placeholder="新增模型，例如 qwen3-coder-plus"
                          />
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={handleAddModel}
                          >
                            添加
                          </Button>
                        </div>
                        <div className="field-note">
                          第一项是默认模型；最多 20 个。
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="actions">
                    {providerFormMode === 'edit' && (
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={isRegisteringProvider}
                        onClick={resetProviderForm}
                      >
                        取消编辑
                      </Button>
                    )}
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={testingProviderId === '__new_provider_form__'}
                      disabled={isRegisteringProvider}
                      onClick={handleTestProviderConnection}
                    >
                      测试连接
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={testingProviderId !== null}
                      onClick={handleCopyTestMessage}
                    >
                      复制测试消息
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      loading={isRegisteringProvider}
                      disabled={testingProviderId !== null}
                      onClick={handleRegisterProvider}
                    >
                      {providerFormMode === 'edit' ? '保存修改' : '确认添加'}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={isRegisteringProvider}
                      onClick={() => resetProviderForm()}
                    >
                      取消
                    </Button>
                  </div>
                </div>
              </section>
              )}
            </>
          )}

          {configTab === 'droid' && (
            <>
              <section className="provider-section">
                <h2 className="section-title">Droid 服务商</h2>
                <p className="field-note">
                  支持多个服务商同时生效，所有启用的模型都会写入 {droidConfigPath}。
                </p>
                <div className="provider-list">
                  {droidProviders.map((dp, pi) => (
                    <div className="provider-item is-selected" key={dp.id}>
                      <div
                        className="provider-icon"
                        style={{ backgroundColor: ['#14b8a6', '#6366f1', '#f59e0b', '#ec4899', '#3b82f6'][pi % 5] }}
                      >
                        {(dp.name || dp.baseUrl || 'D').charAt(0).toUpperCase()}
                      </div>
                      <div className="provider-info" style={{ flex: 1 }}>
                        <div className="provider-name">
                          {dp.name || extractProviderName(dp.baseUrl) || `服务商 ${pi + 1}`}
                        </div>
                        <div className="provider-url">{dp.baseUrl || '未配置 Base URL'}</div>
                        <div className="provider-model-inline">
                          <span>{(dp.models || []).filter(m => m.model).length} 个模型</span>
                        </div>
                      </div>
                      <div className="provider-actions">
                        <Tag variant="success">已启用</Tag>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => handleStartEditDroidProvider(pi)}
                        >
                          编辑配置
                        </Button>
                        <Button
                          variant="danger"
                          size="sm"
                          onClick={() => handleRemoveDroidProvider(pi)}
                        >
                          删除
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: 12 }}>
                  {!showDroidForm && (
                    <Button variant="secondary" size="sm" onClick={handleAddDroidProvider}>
                      添加服务商
                    </Button>
                  )}
                </div>
              </section>

              {showDroidForm && editingDroidProviderIndex !== null && droidProviders[editingDroidProviderIndex] && (
                <section className="provider-section">
                  <h2 className="section-title">
                    {droidFormMode === 'edit' ? `编辑：${droidProviders[editingDroidProviderIndex].name || `服务商 ${editingDroidProviderIndex + 1}`}` : '新增服务商'}
                  </h2>
                  <div className="card custom-provider-card">
                    <p className="field-note">
                      填写名称、Base URL 和 API Key，然后添加模型。
                    </p>
                    <div className="custom-provider-grid">
                      <div className="field">
                        <label>显示名称</label>
                        <input
                          type="text"
                          value={droidProviders[editingDroidProviderIndex].name}
                          onChange={(e) => handleChangeDroidProvider(editingDroidProviderIndex, { name: e.target.value })}
                          placeholder="例如: duojie.games"
                        />
                      </div>
                      <div className="field">
                        <label>Base URL</label>
                        <input
                          type="text"
                          value={droidProviders[editingDroidProviderIndex].baseUrl}
                          onChange={(e) => handleChangeDroidProvider(editingDroidProviderIndex, { baseUrl: e.target.value })}
                          placeholder="例如: https://api.duojie.games"
                        />
                      </div>
                      <div className="field" style={{ gridColumn: '1 / -1' }}>
                        <label>API Key</label>
                        <div className="key-input-row">
                          <input
                            type={showDroidTokenMap[droidProviders[editingDroidProviderIndex].id] ? 'text' : 'password'}
                            value={droidProviders[editingDroidProviderIndex].apiKey}
                            onChange={(e) => handleChangeDroidProvider(editingDroidProviderIndex, { apiKey: e.target.value })}
                            placeholder="输入该服务商的 API Key"
                          />
                          <button
                            type="button"
                            className="key-visibility-btn"
                            onClick={() => {
                              const id = droidProviders[editingDroidProviderIndex].id
                              setShowDroidTokenMap((prev) => ({ ...prev, [id]: !prev[id] }))
                            }}
                          >
                            {showDroidTokenMap[droidProviders[editingDroidProviderIndex].id] ? '👁' : '🙈'}
                          </button>
                        </div>
                      </div>
                      <div className="field model-field" style={{ gridColumn: '1 / -1' }}>
                        <label>模型列表</label>
                        <div className="model-list-editor">
                          {(droidProviders[editingDroidProviderIndex].models || []).map((model, mi) => (
                            <div className="model-list-row" key={`${editingDroidProviderIndex}-${mi}`}>
                              <input
                                type="text"
                                value={model.model_display_name}
                                placeholder="显示名称"
                                onChange={(e) => handleChangeDroidModel(editingDroidProviderIndex, mi, { model_display_name: e.target.value })}
                                style={{ flex: 1 }}
                              />
                              <input
                                type="text"
                                value={model.model}
                                placeholder="模型 ID"
                                onChange={(e) => handleChangeDroidModel(editingDroidProviderIndex, mi, { model: e.target.value })}
                                style={{ flex: 1 }}
                              />
                              <Button
                                variant="danger"
                                size="sm"
                                onClick={() => handleRemoveDroidModel(editingDroidProviderIndex, mi)}
                              >
                                删除
                              </Button>
                            </div>
                          ))}
                          <div className="field-note">
                            每个模型需要填写显示名称和模型 ID。
                          </div>
                        </div>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => handleAddDroidModel(editingDroidProviderIndex)}
                          style={{ marginTop: 8 }}
                        >
                          添加模型
                        </Button>
                      </div>
                    </div>
                    <div className="actions">
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => { setShowDroidForm(false); setEditingDroidProviderIndex(null) }}
                      >
                        {droidFormMode === 'edit' ? '完成编辑' : '确认添加'}
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={handleCancelDroidForm}
                      >
                        取消
                      </Button>
                    </div>
                  </div>
                </section>
              )}

              <section className="provider-section">
                <h2
                  className="section-title"
                  style={{ cursor: 'pointer', userSelect: 'none' }}
                  onClick={() => setShowDroidAdvanced((v) => !v)}
                >
                  高级 {showDroidAdvanced ? '▾' : '▸'}
                </h2>
                {showDroidAdvanced && (
                <div className="card custom-provider-card">
                  <div className="custom-provider-grid">
                    <div className="field" style={{ gridColumn: '1 / -1' }}>
                      <label>JSON 预览</label>
                      <pre className="droid-config-preview">{JSON.stringify(generatedDroidConfig, null, 2)}</pre>
                    </div>
                    <div className="field" style={{ gridColumn: '1 / -1' }}>
                      <label>导入 JSON</label>
                      <textarea
                        className="droid-import-editor"
                        value={droidImportText}
                        onChange={(e) => setDroidImportText(e.target.value)}
                        spellCheck={false}
                        placeholder='粘贴 {"custom_models":[...]} 后点击"应用导入"'
                      />
                    </div>
                  </div>
                  <div className="actions">
                    <Button variant="secondary" size="sm" onClick={handleImportDroidJson}>
                      应用导入
                    </Button>
                    <Button variant="secondary" size="sm" onClick={() => handleCopyText(JSON.stringify(generatedDroidConfig, null, 2), 'JSON 已复制')}>
                      导出 JSON
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={isBuildingDroidTemplate}
                      disabled={isSavingDroidConfig}
                      onClick={handleBuildDroidTemplate}
                    >
                      填充示例模板
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      loading={isSavingDroidConfig}
                      disabled={isBuildingDroidTemplate}
                      onClick={handleSaveDroidConfig}
                    >
                      保存到 Droid
                    </Button>
                  </div>
                </div>
                )}
              </section>
            </>
          )}
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
 * @param {boolean} props.isSwitching - 是否正在切换中
 * @param {boolean} props.isTestingProvider - 是否正在测试连接
 * @param {string} props.selectedModel - 当前选中模型
 * @param {(model: string) => void} props.onChangeModel - 模型切换回调
 * @param {(options?: {force?: boolean}) => void} props.onEnable - 启用回调
 * @param {Function} props.onTestConnection - 测试连接回调
 * @param {Function} props.onEditProvider - 编辑渠道配置回调
 * @param {Function} props.onDeleteProvider - 删除渠道配置回调
 * @returns {JSX.Element}
 */
function ProviderCard({
  provider,
  isSelected,
  isSwitching,
  isTestingProvider,
  selectedModel,
  onChangeModel,
  onEnable,
  onTestConnection,
  onEditProvider,
  onDeleteProvider,
}) {
  const isCustomProvider = provider.source === 'custom'
  const providerModels = getProviderModels(provider)
  const canSelectModel = providerModels.length > 0

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
          {canSelectModel && (
            <div className="provider-model-inline">
              <span>模型</span>
              <select
                className="provider-model-select"
                value={selectedModel}
                disabled={isSwitching}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => onChangeModel(e.target.value)}
              >
                {providerModels.map((model) => (
                  <option key={model} value={model}>{model}</option>
                ))}
              </select>
            </div>
          )}
        </div>
        <div className="provider-actions">
          {provider.id !== 'official' && (
            <Button
              variant="secondary"
              size="sm"
              loading={isTestingProvider}
              disabled={isSwitching}
              onClick={(e) => { e.stopPropagation(); onTestConnection() }}
            >
              测试连接
            </Button>
          )}
          {isSelected ? (
            <>
              <Tag variant="success">当前使用</Tag>
            </>
          ) : (
            <Button
              variant="primary"
              size="sm"
              loading={isSwitching}
              onClick={(e) => { e.stopPropagation(); onEnable() }}
            >
              启用
            </Button>
          )}
          {provider.id !== 'official' && (
            <Button
              variant="secondary"
              size="sm"
              disabled={isSwitching}
              onClick={(e) => { e.stopPropagation(); onEditProvider() }}
            >
              编辑配置
            </Button>
          )}
          {isCustomProvider && (
            <Button
              variant="danger"
              size="sm"
              disabled={isSwitching}
              onClick={(e) => { e.stopPropagation(); onDeleteProvider() }}
            >
              删除
            </Button>
          )}
        </div>
      </div>
    </>
  )
}
