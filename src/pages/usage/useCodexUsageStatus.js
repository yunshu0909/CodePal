/**
 * Codex 会员额度状态 Hook
 *
 * 负责：
 * - 拉取 Codex 最新 rate_limits 接入状态（只读 ~/.codex/sessions 日志，零配置）
 * - 比 Claude 精简：无安装/配置/历史，只有 statusState / loading / error / loadStatus
 *
 * @module pages/usage/useCodexUsageStatus
 */

import { useCallback, useEffect, useState } from 'react'

/**
 * Codex 会员额度状态 Hook
 * @returns {{statusState: object|null, loading: boolean, error: string|null, loadStatus: () => Promise<void>}}
 */
export default function useCodexUsageStatus() {
  // 当前 Codex 额度状态：含 integrationState 与 snapshot
  const [statusState, setStatusState] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  // Codex 满载率趋势（按自然周聚合，形状与 Claude history 一致）
  const [trend, setTrend] = useState({ currentCycle: null, completedCycles: [] })

  /**
   * 拉取当前 Codex 额度状态
   * @returns {Promise<void>}
   */
  const loadStatus = useCallback(async () => {
    if (!window.electronAPI?.getCodexUsageStatusState) {
      // 老 preload / 非 Electron 环境：兜底 read_error
      setStatusState(null)
      setError('当前环境不支持 Codex 会员额度功能')
      setLoading(false)
      return
    }

    try {
      const result = await window.electronAPI.getCodexUsageStatusState()
      if (result?.success) {
        setStatusState(result)
        setError(null)
      } else {
        // 保留 result 里的 integrationState（read_error），让 deriveCodexRenderState 能派生
        setStatusState(result || null)
        setError(result?.error || '读取 Codex 会员额度失败')
      }
    } catch (err) {
      setStatusState(null)
      setError(err.message || '读取 Codex 会员额度失败')
    } finally {
      setLoading(false)
    }
  }, [])

  /**
   * 拉取 Codex 满载率趋势（失败静默，趋势是次要信息）
   * @returns {Promise<void>}
   */
  const loadTrend = useCallback(async () => {
    if (!window.electronAPI?.getCodexUsageTrend) {
      setTrend({ currentCycle: null, completedCycles: [] })
      return
    }
    try {
      const result = await window.electronAPI.getCodexUsageTrend()
      if (result?.success) {
        setTrend({
          currentCycle: result.currentCycle || null,
          completedCycles: Array.isArray(result.completedCycles) ? result.completedCycles : [],
        })
      }
    } catch {
      // 趋势读取失败静默处理，保持空结构
    }
  }, [])

  useEffect(() => {
    loadStatus()
    loadTrend()
  }, [loadStatus, loadTrend])

  return { statusState, loading, error, trend, loadStatus, loadTrend }
}
