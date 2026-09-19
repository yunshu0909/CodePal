/**
 * 出口 IP 监控 Hook
 *
 * 负责：
 * - 页面挂载时从主进程拉取状态，订阅主进程推送的采样更新
 * - 页面打开时切到快速模式（5 秒），离开时回到后台模式（60 秒）
 * - 提供「检测一次」与持续监控开关；开关成功 / 失败给 Toast
 *
 * 检测是读取类动作，成功失败都只原地更新、不弹 Toast；IP 变化与连续失败由主进程发系统通知。
 * 采样定时器运行在主进程，本 Hook 只做数据订阅和动作转发。
 *
 * @module hooks/useIpMonitor
 */

import { useState, useEffect, useCallback, useRef } from 'react'

/**
 * @param {(message: string, type: 'success'|'error') => void} onToast - Toast 回调
 * @returns {{state: Object|null, probing: boolean, saving: boolean, probeOnce: () => Promise<void>, toggle: (enabled: boolean) => Promise<void>}}
 */
export default function useIpMonitor(onToast) {
  const [state, setState] = useState(null)
  // 页面刚点了「检测一次」还没回来：主进程推送前就让按钮进入「检测中…」
  const [probing, setProbing] = useState(false)
  // 开关写入中：禁用开关防重复点
  const [saving, setSaving] = useState(false)
  const onToastRef = useRef(onToast)
  onToastRef.current = onToast
  const stateRef = useRef(null)

  const apply = useCallback((next) => {
    stateRef.current = next
    setState(next)
  }, [])

  useEffect(() => {
    let cancelled = false
    const api = window.electronAPI

    api.getIpMonitorState().then((response) => {
      if (!cancelled && response?.success) apply(response.data)
    }).catch(() => {})

    api.setIpMonitorFastMode(true)

    const unsubscribe = api.onIpStateUpdate((next) => {
      if (!cancelled) apply(next)
    })

    return () => {
      cancelled = true
      unsubscribe?.()
      api.setIpMonitorFastMode(false)
    }
  }, [apply])

  const probeOnce = useCallback(async () => {
    if (!window.electronAPI?.probeIpOnce || probing) return
    setProbing(true)
    try {
      const response = await window.electronAPI.probeIpOnce()
      if (response?.data) apply(response.data)
    } catch {
      // IPC 本身失败：保持原画面，主进程下次推送会纠正
    } finally {
      setProbing(false)
    }
  }, [probing, apply])

  const toggle = useCallback(async (enabled) => {
    if (!stateRef.current || saving) return
    setSaving(true)
    try {
      const response = await window.electronAPI.toggleIpMonitor(enabled)
      if (response?.success) {
        apply(response.data)
        onToastRef.current(enabled ? '已开启持续监控' : '已关闭持续监控', 'success')
      } else {
        if (response?.data) apply(response.data)
        onToastRef.current('无法保存持续监控设置，请重试', 'error')
      }
    } catch {
      onToastRef.current('无法保存持续监控设置，请重试', 'error')
    } finally {
      setSaving(false)
    }
  }, [saving, apply])

  return { state, probing, saving, probeOnce, toggle }
}
