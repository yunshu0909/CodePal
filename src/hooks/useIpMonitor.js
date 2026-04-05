/**
 * IP 监控 Hook
 *
 * 负责：
 * - 页面挂载时从主进程拉取已有监控状态
 * - 订阅主进程推送的实时采样更新
 * - 页面打开时切换到快速模式（5 秒），离开时回到后台模式（30 秒）
 * - 提供开关控制（暂停/恢复监控）
 *
 * IP 采样定时器运行在主进程，本 Hook 只做数据订阅和展示。
 *
 * @module hooks/useIpMonitor
 */

import { useState, useEffect, useCallback, useRef } from 'react'

/**
 * @param {(message: string, type: string) => void} onToast - Toast 回调
 * @returns {{ state: Object, toggle: () => void }}
 */
export default function useIpMonitor(onToast) {
  const [state, setState] = useState(null)
  const onToastRef = useRef(onToast)
  onToastRef.current = onToast
  const hasShownFailToastRef = useRef(false)
  const stateRef = useRef(null)

  useEffect(() => {
    let cancelled = false

    // 1. 拉取已有状态
    window.electronAPI.getIpMonitorState().then((response) => {
      if (!cancelled && response.success) {
        setState(response.data)
        stateRef.current = response.data
      }
    })

    // 2. 切换到快速模式
    window.electronAPI.setIpMonitorFastMode(true)

    // 3. 订阅实时更新（不在 setState updater 中触发副作用）
    const unsubscribe = window.electronAPI.onIpStateUpdate((newState) => {
      if (cancelled) return
      const prev = stateRef.current

      // IP 切换 Toast：switchCount 增加时弹
      if (prev && newState.switchCount > prev.switchCount && newState.previousIp && newState.currentIp) {
        onToastRef.current(`检测到 IP 切换：${newState.previousIp} → ${newState.currentIp}`, 'warning')
      }

      // 连续失败 Toast：达到 3 次且未弹过
      if (newState.consecutiveFailCount >= 3 && !hasShownFailToastRef.current) {
        onToastRef.current('公网 IP 获取失败，请检查网络连接', 'error')
        hasShownFailToastRef.current = true
      }

      // 失败恢复后重置 Toast 标记
      if (newState.consecutiveFailCount === 0) {
        hasShownFailToastRef.current = false
      }

      stateRef.current = newState
      setState(newState)
    })

    // 4. 离开页面时回到后台模式
    return () => {
      cancelled = true
      unsubscribe()
      window.electronAPI.setIpMonitorFastMode(false)
    }
  }, [])

  const toggle = useCallback(async () => {
    if (!stateRef.current) return
    const newEnabled = !stateRef.current.isEnabled
    const response = await window.electronAPI.toggleIpMonitor(newEnabled)
    if (response.success) {
      stateRef.current = response.data
      setState(response.data)
      hasShownFailToastRef.current = false
    }
  }, [])

  return { state, toggle }
}
