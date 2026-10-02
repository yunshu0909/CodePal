/**
 * Skill 控制中心状态 Hook
 * - 从本次运行共享缓存订阅，回访第一帧显示最近结果，再核对实际状态
 * - 所有读取和命令由同一协调器处理，卸载仅退订，不丢失进行中的操作
 * @module hooks/useSkillControl
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { skillRepoPath } from '../store/skillRepoPath'
import { getSkillControlCache } from '../store/services/skillControlCache'

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

  const load = useCallback((path) => {
    if (!api?.getSkillControlSnapshot) return Promise.resolve({ success: false, error: 'API_NOT_AVAILABLE' })
    return api.getSkillControlSnapshot({ repoPath: path, projectRoots: [] })
  }, [api])

  const resolveActiveContext = useCallback(() => hintRef.current
    ? { repoPath: hintRef.current, target: cache.entry(hintRef.current) }
    : resolveContext(), [cache, resolveContext])

  const refresh = useCallback(async ({ acceptWriteSnapshot = false } = {}) => {
    try {
      const resolved = resolveActiveContext()
      const context = resolved?.then ? await resolved : resolved
      return await cache.refresh(context.target, () => load(context.repoPath), { acceptWriteSnapshot })
    } catch (error) {
      return cache.refresh(cache.entry(null), () => ({ success: false, error: error?.message || 'SKILL_CONTROL_SCAN_FAILED' }))
    }
  }, [cache, load, resolveActiveContext])

  useEffect(() => {
    mounted.current = true
    refresh({ acceptWriteSnapshot: true })
    return () => { mounted.current = false }
  }, [refresh, refreshSignal])

  const execute = useCallback(async ({ skillName, toolId, action, source, ...options }) => {
    try {
      const context = await resolveActiveContext()
      const result = await cache.execute(context.target, `${skillName}:${toolId}`, () => {
        if (!api?.executeSkillCommand) return { success: false, error: 'API_NOT_AVAILABLE' }
        return api.executeSkillCommand({ repoPath: context.repoPath, skillName, toolId, action, source, projectRoots: [], ...options })
      })
      if (result.success && !result.snapshot) await cache.refresh(context.target, () => load(context.repoPath))
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

  const adoptExternalSkill = useCallback(async ({ skillName, toolId, source }) => {
    const result = await execute({ skillName, toolId, source: source || { origin: 'user', mutable: true }, action: 'adopt' })
    return result.success ? { ...result, adopted: [{ skillName, toolId }] } : { ...result, adopted: [], failed: [{ skillName, toolId, error: result.error }] }
  }, [execute])

  const adoptExternalSkills = useCallback(async (items) => {
    const adopted = []
    const failed = []
    for (const item of Array.isArray(items) ? items : []) {
      const result = await adoptExternalSkill(item)
      if (result.success) adopted.push(item)
      else failed.push({ ...item, error: result.error })
    }
    return { success: failed.length === 0, adopted, failed }
  }, [adoptExternalSkill])

  return { ...state, refresh, execute, setQuery, setSelectedId, setActivation, adoptExternalSkill, adoptExternalSkills }
}
