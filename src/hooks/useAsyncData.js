/**
 * 通用异步数据加载 Hook
 *
 * 负责：
 * - 封装 loading / error / data 三态管理
 * - 支持静默刷新（不显示 loading，适合切 Tab 后台刷新）
 * - 暴露 reload() 供外部手动触发重新加载
 *
 * 使用示例：
 *   const { data, loading, error, reload } = useAsyncData(
 *     () => window.electronAPI.skills.getList()
 *   )
 *
 * @module hooks/useAsyncData
 */

import { useState, useCallback, useEffect } from 'react'

/**
 * 异步数据加载 Hook
 * @param {() => Promise<any>} fetchFn - 数据获取函数，返回 Promise
 * @returns {{ data: any, loading: boolean, error: string|null, reload: (options?: {silent?: boolean}) => Promise<void> }}
 */
export function useAsyncData(fetchFn) {
  // 业务数据
  const [data, setData] = useState(null)
  // 加载状态（首次加载或非静默刷新时为 true）
  const [loading, setLoading] = useState(true)
  // 错误信息（string 或 null）
  const [error, setError] = useState(null)

  /**
   * 执行数据加载
   * @param {{ silent?: boolean }} options
   *   silent=true：不显示 loading，适合切 Tab 后静默刷新，失败时不清空现有数据
   */
  const load = useCallback(async ({ silent = false } = {}) => {
    if (!silent) {
      setLoading(true)
      setError(null)
    }

    try {
      const result = await fetchFn()
      setData(result)
      // 静默刷新成功后也清除之前的错误（如果有）
      setError(null)
    } catch (err) {
      // 静默刷新失败时保留现有数据，只暴露 error 供调用方决定如何提示
      if (!silent) {
        setError(err.message || '加载失败')
      }
    } finally {
      if (!silent) {
        setLoading(false)
      }
    }
  }, [fetchFn])

  // 组件挂载后执行首次加载
  useEffect(() => {
    load()
  }, [load])

  return { data, loading, error, reload: load }
}
