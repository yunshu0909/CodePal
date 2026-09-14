/**
 * Harness 管理状态 Hook
 *
 * 承担：
 * - 拉取 dsh 安装形态 / 运行状态 / 守护方式快照
 * - 执行安装、升级、启动、停止、重启、卸载、自动重启开关，并回填最新快照
 * - pendingKeys 让每个按钮只锁定自己，其余区域仍可浏览
 * - urlRef 让「启动后自动打开界面」这类异步回调拿到最新地址，而不是渲染期旧闭包
 *
 * @module hooks/useHarnessControl
 */

import { useCallback, useEffect, useRef, useState } from 'react'

export default function useHarnessControl() {
  const [status, setStatus] = useState('loading')
  const [snapshot, setSnapshot] = useState(null)
  const [error, setError] = useState(null)
  const [pendingKeys, setPendingKeys] = useState(() => new Set())
  const requestId = useRef(0)
  // 当前可打开的地址；启动成功后回调里必须立刻读到，不能等 effect。
  const urlRef = useRef(null)

  const adoptSnapshot = useCallback((next) => {
    requestId.current += 1
    urlRef.current = next?.runtime?.url || null
    setSnapshot(next)
    setError(null)
    setStatus('ready')
  }, [])

  const refresh = useCallback(async ({ silent = false } = {}) => {
    const id = ++requestId.current
    if (!silent) setStatus('loading')
    try {
      const api = window.electronAPI
      if (!api?.harness?.getSnapshot) throw new Error('API_NOT_AVAILABLE')
      const result = await api.harness.getSnapshot()
      if (id !== requestId.current) return { success: false, error: 'STALE_REQUEST' }
      if (!result?.success || !result.data) throw new Error(result?.error || 'HARNESS_UNKNOWN_ERROR')
      urlRef.current = result.data.runtime?.url || null
      setSnapshot(result.data)
      setError(null)
      setStatus('ready')
      return { success: true, data: result.data }
    } catch (loadError) {
      if (id !== requestId.current) return { success: false, error: 'STALE_REQUEST' }
      setError(loadError?.message || 'HARNESS_UNKNOWN_ERROR')
      setStatus('error')
      return { success: false, error: loadError?.message || 'HARNESS_UNKNOWN_ERROR' }
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const checkVersions = useCallback(async () => {
    setPendingKeys((previous) => new Set(previous).add('versions'))
    try {
      const result = await window.electronAPI?.harness?.listVersions?.()
      if (!result?.success) return { success: false, error: result?.error || 'HARNESS_NPM_FAILED' }
      return { success: true, data: result.data }
    } catch (operationError) {
      return { success: false, error: operationError?.message || 'HARNESS_NPM_FAILED' }
    } finally {
      setPendingKeys((previous) => {
        const next = new Set(previous)
        next.delete('versions')
        return next
      })
    }
  }, [])

  /**
   * 执行一次生命周期操作；成功后用随结果返回的快照回填，避免二次探测。
   * @param {'install'|'uninstall'|'start'|'stop'|'restart'|'setStopOnQuit'|'setKeepAlive'} action
   * @param {object} [params]
   */
  const execute = useCallback(async (action, params) => {
    const key = action === 'install' ? `install:${params?.channel || 'latest'}` : action
    setPendingKeys((previous) => new Set(previous).add(key))
    try {
      const api = window.electronAPI?.harness
      if (!api?.[action]) return { success: false, error: 'API_NOT_AVAILABLE' }
      const result = await api[action](params)
      if (!result?.success) return { success: false, error: result?.error || 'HARNESS_UNKNOWN_ERROR' }
      if (result.data?.snapshot) {
        adoptSnapshot(result.data.snapshot)
      } else {
        await refresh({ silent: true })
      }
      return result
    } catch (operationError) {
      return { success: false, error: operationError?.message || 'HARNESS_UNKNOWN_ERROR' }
    } finally {
      setPendingKeys((previous) => {
        const next = new Set(previous)
        next.delete(key)
        return next
      })
    }
  }, [adoptSnapshot, refresh])

  return { status, snapshot, error, pendingKeys, urlRef, refresh, checkVersions, execute }
}
