/**
 * Harness 管理状态 Hook
 *
 * 承担：
 * - 拉取 dsh 安装形态 / 运行状态 / 守护方式快照
 * - 执行安装、升级、启动、停止、重启、卸载、守护开关，并回填最新快照
 * - 首次加载走整页加载态；之后的刷新保留内容，只暴露 refreshing 让「刷新」按钮转圈
 *   （源码版刷新含一次 git fetch、托管版查一次 npm，可能要几秒）
 * - pendingKeys 让每个按钮只锁定自己，其余区域仍可浏览
 * - urlRef 让「启动后自动打开界面」这类异步回调拿到最新地址，而不是渲染期旧闭包
 *
 * @module hooks/useHarnessControl
 */

import { useCallback, useEffect, useRef, useState } from 'react'

/** 把设置类操作的返回值合进快照（只认 stopOnQuit / keepAlive 两个字段） */
function patchSettings(previous, data) {
  if (!previous || !data) return previous
  let next = previous
  if (typeof data.stopOnQuit === 'boolean') next = { ...next, stopOnQuit: data.stopOnQuit }
  if (typeof data.keepAlive === 'boolean') next = { ...next, supervisor: { ...next.supervisor, keepAlive: data.keepAlive } }
  return next
}

export default function useHarnessControl() {
  const [status, setStatus] = useState('loading')
  const [snapshot, setSnapshot] = useState(null)
  const [error, setError] = useState(null)
  const [refreshing, setRefreshing] = useState(false)
  const [pendingKeys, setPendingKeys] = useState(() => new Set())
  const requestId = useRef(0)
  // 已经拿到过快照：之后的读取不再清空页面
  const loadedRef = useRef(false)
  // 当前可打开的地址；启动成功后回调里必须立刻读到，不能等 effect。
  const urlRef = useRef(null)

  const adoptSnapshot = useCallback((next) => {
    requestId.current += 1
    loadedRef.current = true
    urlRef.current = next?.runtime?.url || null
    setSnapshot(next)
    setError(null)
    setRefreshing(false)
    setStatus('ready')
  }, [])

  /**
   * 读取快照。首次读取失败进入整页错误态；已有内容时失败只返回错误码，由页面用 Toast 提示。
   * @param {{ silent?: boolean }} [options] silent：操作后的静默回填，不让「刷新」转圈
   */
  const refresh = useCallback(async ({ silent = false } = {}) => {
    const id = ++requestId.current
    const loaded = loadedRef.current
    if (!loaded) setStatus('loading')
    else if (!silent) setRefreshing(true)
    try {
      const api = window.electronAPI
      if (!api?.harness?.getSnapshot) throw new Error('API_NOT_AVAILABLE')
      const result = await api.harness.getSnapshot()
      if (id !== requestId.current) return { success: false, error: 'STALE_REQUEST' }
      if (!result?.success || !result.data) throw new Error(result?.error || 'HARNESS_UNKNOWN_ERROR')
      adoptSnapshot(result.data)
      return { success: true, data: result.data }
    } catch (loadError) {
      if (id !== requestId.current) return { success: false, error: 'STALE_REQUEST' }
      const code = loadError?.message || 'HARNESS_UNKNOWN_ERROR'
      setRefreshing(false)
      if (!loaded) {
        setError(code)
        setStatus('error')
      }
      return { success: false, error: code }
    }
  }, [adoptSnapshot])

  useEffect(() => { refresh() }, [refresh])

  /**
   * 执行一次生命周期操作；成功后用随结果返回的快照回填，避免二次探测。
   * @param {'install'|'uninstall'|'start'|'stop'|'restart'|'update'|'setStopOnQuit'|'setKeepAlive'} action
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
        const refreshed = await refresh({ silent: true })
        // 设置已生效但回读失败：按返回值更新本地快照，开关不停在旧值
        if (!refreshed.success) setSnapshot((previous) => patchSettings(previous, result.data))
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

  return { status, snapshot, error, refreshing, pendingKeys, urlRef, refresh, execute }
}
