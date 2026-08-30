/**
 * Skill 控制中心状态 Hook
 *
 * 只通过统一 IPC 读取与写入；请求序号抑制 watcher/手动刷新造成的旧响应回写。
 *
 * @module hooks/useSkillControl
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { dataStore } from '../store/data'

export default function useSkillControl(refreshSignal = 0) {
  const [status, setStatus] = useState('loading')
  const [snapshot, setSnapshot] = useState(null)
  const [error, setError] = useState(null)
  const [pendingKeys, setPendingKeys] = useState(() => new Set())
  const requestIdRef = useRef(0)
  const repoPathRef = useRef(null)

  const refresh = useCallback(async ({ silent = false } = {}) => {
    const api = typeof window !== 'undefined' ? window.electronAPI : null
    if (!api?.getSkillControlSnapshot) {
      setError('API_NOT_AVAILABLE')
      setStatus('error')
      return { success: false, error: 'API_NOT_AVAILABLE' }
    }
    const requestId = ++requestIdRef.current
    if (!silent) setStatus('loading')
    try {
      const repoPath = await dataStore.getRepoPath()
      repoPathRef.current = repoPath
      const result = await api.getSkillControlSnapshot({ repoPath, projectRoots: [] })
      if (requestId !== requestIdRef.current) return { success: false, error: 'STALE_REQUEST' }
      if (!result?.success || !result.data) {
        const nextError = result?.error || 'SKILL_CONTROL_SCAN_FAILED'
        setError(nextError)
        setStatus('error')
        return { success: false, error: nextError }
      }
      setSnapshot(result.data)
      setError(null)
      setStatus('ready')
      return { success: true, data: result.data }
    } catch (loadError) {
      if (requestId !== requestIdRef.current) return { success: false, error: 'STALE_REQUEST' }
      const nextError = loadError?.message || 'SKILL_CONTROL_SCAN_FAILED'
      setError(nextError)
      setStatus('error')
      return { success: false, error: nextError }
    }
  }, [])

  useEffect(() => {
    refresh({ silent: Boolean(snapshot) })
    // snapshot 只控制刷新动画，不应触发下一轮读取。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh, refreshSignal])

  const execute = useCallback(async ({ skillName, toolId, action, source, ...options }) => {
    const operationKey = `${skillName}:${toolId}`
    setPendingKeys((previous) => new Set(previous).add(operationKey))
    try {
      const api = typeof window !== 'undefined' ? window.electronAPI : null
      if (!api?.executeSkillCommand) return { success: false, error: 'API_NOT_AVAILABLE' }
      const repoPath = repoPathRef.current || await dataStore.getRepoPath()
      const result = await api.executeSkillCommand({ repoPath, skillName, toolId, action, source, projectRoots: [], ...options })
      if (!result?.success) return { success: false, error: result?.error || 'SKILL_CONTROL_COMMAND_FAILED' }
      if (result.snapshot) {
        requestIdRef.current += 1
        setSnapshot(result.snapshot)
        setError(null)
        setStatus('ready')
      } else {
        await refresh({ silent: true })
      }
      return result
    } catch (operationError) {
      return { success: false, error: operationError?.message || 'SKILL_CONTROL_COMMAND_FAILED' }
    } finally {
      setPendingKeys((previous) => {
        const next = new Set(previous)
        next.delete(operationKey)
        return next
      })
    }
  }, [refresh])

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

  return { status, snapshot, error, pendingKeys, refresh, execute, setActivation, adoptExternalSkill, adoptExternalSkills }
}
