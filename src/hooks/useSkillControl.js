/**
 * Skill 控制中心状态 Hook
 * - 从本次运行共享缓存订阅，回访第一帧显示最近结果，再核对实际状态
 * - 所有读取和命令由同一协调器处理，卸载仅退订，不丢失进行中的操作
 * - 命令只传名字、工具、动作和各种 ID；资产库路径由主进程解析（v2.1.11）
 * - #101 本次运行第一次进页：同时向主进程要上次关应用前的快照和次数，先显示，实时读完原地换
 * @module hooks/useSkillControl
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { skillRepoPath } from '../store/skillRepoPath'
import { getSkillControlCache } from '../store/services/skillControlCache'
import { seedSkillUsageCache } from './useSkillUsage'

/**
 * @param {number} [refreshSignal=0] 既有外部重读信号
 * @returns {object} 快照、操作及浏览状态
 */
export default function useSkillControl(refreshSignal = 0) {
  const api = typeof window !== 'undefined' ? window.electronAPI : null
  const cache = getSkillControlCache(api)
  // 配置缓存未就绪时先显示未知上下文，不能把其它资产库闪到第一帧。
  const hint = skillRepoPath.getCachedRepoPath() || cache.lastRepoPath
  const hintRef = useRef(hint)
  hintRef.current = hint
  const [resolution, setResolution] = useState(null)
  const repoPath = hint || (resolution?.hint === hint ? resolution.repoPath : null)
  const target = cache.entry(repoPath)
  const mounted = useRef(false)
  const subscribe = useCallback((listener) => cache.subscribe(target, listener), [cache, target])
  const getSnapshot = useCallback(() => target.state, [target])
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  const resolveContext = useCallback(async () => {
    const resolvedPath = await skillRepoPath.getRepoPath()
    cache.lastRepoPath = resolvedPath
    if (mounted.current) setResolution({ hint: hintRef.current, repoPath: resolvedPath })
    return { repoPath: resolvedPath, target: cache.entry(resolvedPath) }
  }, [cache])

  // 资产库路径由主进程自己按配置解析（v2.1.11 起不再从页面传）；页面这边的路径只用来区分缓存
  const load = useCallback(() => {
    if (!api?.getSkillControlSnapshot) return Promise.resolve({ success: false, error: 'API_NOT_AVAILABLE' })
    return api.getSkillControlSnapshot({})
  }, [api])

  const resolveActiveContext = useCallback(() => hintRef.current
    ? { repoPath: hintRef.current, target: cache.entry(hintRef.current) }
    : resolveContext(), [cache, resolveContext])

  const refresh = useCallback(async ({ acceptWriteSnapshot = false } = {}) => {
    try {
      const resolved = resolveActiveContext()
      const context = resolved?.then ? await resolved : resolved
      return await cache.refresh(context.target, () => load(), { acceptWriteSnapshot })
    } catch (error) {
      return cache.refresh(cache.entry(null), () => ({ success: false, error: error?.message || 'SKILL_CONTROL_SCAN_FAILED' }))
    }
  }, [cache, load, resolveActiveContext])

  // 上次的快照只放进它自己那个资产库的格子；当前资产库不是它就用不上，照旧等实时的
  const seedLastView = useCallback(async () => {
    if (!api?.getSkillsLastView) return
    const view = await cache.loadLastView(() => api.getSkillsLastView())
    const saved = view?.snapshot
    if (!saved?.data || typeof saved.repoPath !== 'string') return
    const entry = cache.entry(saved.repoPath)
    if (entry.state.snapshot || entry.state.pendingKeys.size) return
    // 先垫次数再放快照：页面拿到快照的同一帧就能用上旧数字，不闪骨架
    if (view.usage) seedSkillUsageCache(api, view.usage)
    cache.seed(entry, saved.data)
  }, [api, cache])

  useEffect(() => {
    mounted.current = true
    seedLastView()
    refresh({ acceptWriteSnapshot: true })
    return () => { mounted.current = false }
  }, [refresh, refreshSignal, seedLastView])

  const execute = useCallback(async ({ skillName, toolId, action, source, pendingKey, ...options }) => {
    try {
      const context = await resolveActiveContext()
      const result = await cache.execute(context.target, pendingKey || `${skillName}:${toolId}`, () => {
        if (!api?.executeSkillCommand) return { success: false, error: 'API_NOT_AVAILABLE' }
        return api.executeSkillCommand({ skillName, toolId, action, source, ...options })
      })
      if (result.success && !result.snapshot) await cache.refresh(context.target, () => load())
      return result
    } catch (error) {
      return { success: false, error: error?.message || 'SKILL_CONTROL_COMMAND_FAILED' }
    }
  }, [api, cache, load, resolveActiveContext])

  const setQuery = useCallback((query) => cache.setBrowsing(target, { query }), [cache, target])
  const setSelectedId = useCallback((selectedId) => cache.setBrowsing(target, { selectedId }), [cache, target])

  const setActivation = useCallback(({ skillName, toolId, enabled, source }) => execute({
    skillName,
    toolId,
    source,
    action: enabled ? 'enable' : 'disable',
  }), [execute])

  return { ...state, refresh, execute, setQuery, setSelectedId, setActivation }
}
