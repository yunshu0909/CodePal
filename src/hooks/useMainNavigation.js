/**
 * 主进程要求切页 Hook
 *
 * 负责：
 * - 挂载时领取窗口创建前记下的待跳转（点系统通知时窗口已关，新窗口起来后才切页）
 * - 订阅主进程推送的 app:navigate（窗口还在时直接切页）
 * - 只接受认识的模块 ID，卸载时取消订阅
 *
 * @module hooks/useMainNavigation
 */

import { useEffect, useRef } from 'react'

/**
 * @param {(moduleId: string) => void} onNavigate - 切到某模块
 * @param {Set<string>} validModules - 认识的模块 ID
 */
export default function useMainNavigation(onNavigate, validModules) {
  // 回调每次渲染都是新函数，用 ref 拿最新的，订阅只建一次
  const onNavigateRef = useRef(onNavigate)
  onNavigateRef.current = onNavigate

  useEffect(() => {
    const api = window.electronAPI
    const go = (moduleId) => {
      if (moduleId && validModules.has(moduleId)) onNavigateRef.current(moduleId)
    }
    api?.consumePendingNavigation?.().then(go).catch(() => {})
    return api?.onNavigate?.(go)
  }, [validModules])
}
