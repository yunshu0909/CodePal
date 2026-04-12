/**
 * Claude Code 会员额度状态 Hook
 *
 * 负责：
 * - 拉取 Claude Code 会员额度状态接入结果
 * - 管理显示模式与阈值表单
 * - 提供安装/重试/保存配置等交互方法
 *
 * @module pages/usage/useClaudeUsageStatus
 */

import { useCallback, useEffect, useState } from 'react'

const DEFAULT_FORM_CONFIG = Object.freeze({
  displayMode: 'always',
  fiveHourThreshold: 70,
  sevenDayThreshold: 70,
})

/**
 * Claude Code 会员额度状态 Hook
 * @returns {object}
 */
export default function useClaudeUsageStatus() {
  // 当前 Claude 会员额度状态：包含接入态、快照和配置
  const [statusState, setStatusState] = useState(null)
  // 页面初次加载状态：用于控制卡片骨架和按钮禁用
  const [loading, setLoading] = useState(true)
  // 安装/修复进行中：避免重复点击“重试接入”
  const [installing, setInstalling] = useState(false)
  // 保存配置进行中：避免表单重复提交
  const [saving, setSaving] = useState(false)
  // 页面内错误信息：展示最近一次操作失败原因
  const [error, setError] = useState(null)
  // 表单配置：用户在卡片里编辑的显示模式与阈值
  const [formConfig, setFormConfig] = useState(DEFAULT_FORM_CONFIG)

  /**
   * 拉取当前状态
   * @returns {Promise<void>}
   */
  const loadStatus = useCallback(async () => {
    if (!window.electronAPI?.getClaudeUsageStatusState) {
      setStatusState(null)
      setError('当前环境不支持 Claude 会员额度状态功能')
      setLoading(false)
      return
    }

    try {
      const result = await window.electronAPI.getClaudeUsageStatusState()
      // 无论 success 与否,都把 result 写入 statusState,让 Card 的 deriveRenderState 能正确派生
      // (v1.3.4: 原代码 success=false 时只 setError 不 setStatusState,导致 Card 拿到旧的 statusState 和新的 error,渲染态错乱)
      if (result?.success) {
        setStatusState(result)
        if (result.config) {
          setFormConfig({
            displayMode: result.config.displayMode || DEFAULT_FORM_CONFIG.displayMode,
            fiveHourThreshold: String(result.config.fiveHourThreshold ?? DEFAULT_FORM_CONFIG.fiveHourThreshold),
            sevenDayThreshold: String(result.config.sevenDayThreshold ?? DEFAULT_FORM_CONFIG.sevenDayThreshold),
          })
        }
        setError(null)

        // 磁盘脚本版本落后时自动重写，用户无感
        if (result.scriptOutdated && window.electronAPI?.ensureClaudeUsageStatusInstalled) {
          window.electronAPI.ensureClaudeUsageStatusInstalled({ force: true }).catch(() => {})
        }
      } else {
        // IPC 返回但 success=false:清掉 statusState,让 Card 进 read_error 态
        setStatusState(null)
        setError(result?.error || '读取 Claude 会员额度状态失败')
      }
    } catch (err) {
      // IPC 抛异常(主进程崩溃 / handler 未注册):同样进 read_error 态
      setStatusState(null)
      setError(err.message || '读取 Claude 会员额度状态失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadStatus()
  }, [loadStatus])

  /**
   * 重试安装/修复
   * @param {{force?: boolean}} [options] - 安装选项
   * @returns {Promise<void>}
   */
  const ensureInstalled = useCallback(async (options = {}) => {
    if (!window.electronAPI?.ensureClaudeUsageStatusInstalled) return

    setInstalling(true)
    try {
      const result = await window.electronAPI.ensureClaudeUsageStatusInstalled(options)
      // v1.3.4: setup_failed 时 result 也带 integrationState,让 Card 能进 setup_failed 分支展示
      if (result?.success) {
        setStatusState(result)
        setError(null)
      } else {
        // 失败时也尽量保留 result 里的 integrationState,否则 Card 无法区分 setup_failed 和其他错误
        setStatusState(result || null)
        setError(result?.error || '安装 Claude 会员额度状态失败')
      }
    } catch (err) {
      setStatusState(null)
      setError(err.message || '安装 Claude 会员额度状态失败')
    } finally {
      setInstalling(false)
    }
  }, [])

  /**
   * 更新表单字段
   * @param {'displayMode'|'fiveHourThreshold'|'sevenDayThreshold'} field - 字段名
   * @param {string} value - 字段值
   */
  const updateFormConfig = useCallback((field, value) => {
    setFormConfig((prev) => ({
      ...prev,
      [field]: value,
    }))
  }, [])

  /**
   * 保存显示配置
   * @returns {Promise<void>}
   */
  /**
   * 保存显示配置
   * @returns {Promise<boolean>} 保存是否成功,供调用方触发 Toast
   */
  const saveConfig = useCallback(async () => {
    if (!window.electronAPI?.saveClaudeUsageStatusConfig) return false

    setSaving(true)
    try {
      const result = await window.electronAPI.saveClaudeUsageStatusConfig({
        displayMode: formConfig.displayMode,
        fiveHourThreshold: Number(formConfig.fiveHourThreshold),
        sevenDayThreshold: Number(formConfig.sevenDayThreshold),
      })

      if (!result?.success) {
        setError(result?.error || '保存配置失败')
        return false
      }

      setStatusState(result)
      if (result.config) {
        setFormConfig({
          displayMode: result.config.displayMode,
          fiveHourThreshold: String(result.config.fiveHourThreshold),
          sevenDayThreshold: String(result.config.sevenDayThreshold),
        })
      }
      setError(null)
      return true
    } catch (err) {
      setError(err.message || '保存配置失败')
      return false
    } finally {
      setSaving(false)
    }
  }, [formConfig])

  return {
    statusState,
    loading,
    installing,
    saving,
    error,
    formConfig,
    loadStatus,
    ensureInstalled,
    updateFormConfig,
    saveConfig,
  }
}
