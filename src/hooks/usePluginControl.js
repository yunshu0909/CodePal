/**
 * Plugin 控制中心状态 Hook
 *
 * @module hooks/usePluginControl
 */

import { useCallback, useEffect, useRef, useState } from 'react'

export default function usePluginControl() {
  const [status, setStatus] = useState('loading')
  const [snapshot, setSnapshot] = useState(null)
  const [error, setError] = useState(null)
  const [pendingKeys, setPendingKeys] = useState(() => new Set())
  const requestId = useRef(0)

  const refresh = useCallback(async ({ silent = false } = {}) => {
    const id = ++requestId.current
    if (!silent) setStatus('loading')
    try {
      const api = window.electronAPI
      if (!api?.getPluginControlSnapshot) throw new Error('API_NOT_AVAILABLE')
      const result = await api.getPluginControlSnapshot({})
      if (id !== requestId.current) return { success: false, error: 'STALE_REQUEST' }
      if (!result?.success || !result.data) throw new Error(result?.error || 'PLUGIN_CONTROL_SCAN_FAILED')
      setSnapshot(result.data)
      setError(null)
      setStatus('ready')
      return { success: true, data: result.data }
    } catch (loadError) {
      if (id !== requestId.current) return { success: false, error: 'STALE_REQUEST' }
      setError(loadError?.message || 'PLUGIN_CONTROL_SCAN_FAILED')
      setStatus('error')
      return { success: false, error: loadError?.message || 'PLUGIN_CONTROL_SCAN_FAILED' }
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const execute = useCallback(async (command) => {
    const key = `${command.toolId}:${command.pluginId}`
    setPendingKeys((previous) => new Set(previous).add(key))
    try {
      const result = await window.electronAPI?.executePluginCommand?.(command)
      if (!result?.success) return { success: false, error: result?.error || 'PLUGIN_CONTROL_COMMAND_FAILED' }
      if (result.snapshot) {
        requestId.current += 1
        setSnapshot(result.snapshot)
        setError(null)
        setStatus('ready')
      } else {
        await refresh({ silent: true })
      }
      return result
    } catch (operationError) {
      return { success: false, error: operationError?.message || 'PLUGIN_CONTROL_COMMAND_FAILED' }
    } finally {
      setPendingKeys((previous) => {
        const next = new Set(previous)
        next.delete(key)
        return next
      })
    }
  }, [refresh])

  return { status, snapshot, error, pendingKeys, refresh, execute }
}
