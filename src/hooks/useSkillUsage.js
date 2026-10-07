/** Counts are calculated in the main process. Cache identity includes assets, event window and explicit refresh generation. */
import { useEffect, useRef, useState } from 'react'
const STALE_MS = 5 * 60 * 1000
let usageCache = null
let usageVersion = 0
/** @returns {void} 清除渲染缓存并使旧响应失效；不写主进程统计存储。 */
export function resetSkillUsageCache() {
  usageCache = null
  usageVersion += 1
}
function viewOf(data) {
  const usageMap = new Map()
  for (const skill of data?.skills || []) usageMap.set(skill.name, skill)
  return {
    status: data ? 'ready' : 'loading',
    usageMap,
    batchId: data?.batchId || null,
    sources: data?.scanMeta?.sources || data?.sources || null,
    scanMeta: data?.scanMeta || null,
  }
}
/**
 * @param {string[]} skillNames - 当前普通资产名字。
 * @param {number} windowDays - 加载过程的事件窗口，默认近 30 天。
 * @param {string|number} refreshToken - 显式刷新代次。
 * @param {string} assetIdentity - 来源身份；启用开关不改变它。
 * @returns {object} 主进程统计视图与 batchId；只缓存展示，不在渲染层计数。
 * 刷新/身份改变立即隐藏旧数字，迟到响应不能覆盖新批次。
 */
export default function useSkillUsage(
  skillNames,
  windowDays = 30,
  refreshToken = 0,
  assetIdentity = ''
) {
  const api = typeof window !== 'undefined' ? window.electronAPI : null
  const names = Array.isArray(skillNames) ? [...new Set(skillNames)].sort() : []
  const key = names.length ? JSON.stringify([windowDays, names, assetIdentity]) : ''
  const cached =
    usageCache?.api === api &&
    usageCache.key === key &&
    usageCache.token === refreshToken &&
    Date.now() - usageCache.at < STALE_MS
      ? usageCache.data
      : null
  const [view, setView] = useState(() => ({ ...viewOf(cached), key, api, token: refreshToken }))
  const reqRef = useRef(0)
  useEffect(() => {
    let active = true
    const requestId = ++reqRef.current
    const apply = (data, status) =>
      setView({ ...viewOf(data), ...(status ? { status } : {}), key, api, token: refreshToken })
    if (!key) {
      apply({ skills: [] })
      return undefined
    }
    const query = api?.skillUsageAggregate || api?.aggregateSkillUsage
    if (!query) {
      apply(null, 'error')
      return undefined
    }
    if (cached) {
      apply(cached)
      return undefined
    }
    apply(null, 'loading')
    const version = ++usageVersion
    query({ windowDays, skillNames: names })
      .then((result) => {
        if (requestId !== reqRef.current) return
        if (!result?.success || !result.data) {
          if (active) apply(null, 'error')
          return
        }
        if (version === usageVersion)
          usageCache = { key, api, token: refreshToken, at: Date.now(), data: result.data }
        if (active) apply(result.data)
      })
      .catch(() => {
        if (active && requestId === reqRef.current) apply(null, 'error')
      })
    return () => {
      active = false
    }
    // The stable key captures names and verified identity; API result objects do not trigger rereads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, key, refreshToken])
  return view.key === key && view.api === api && view.token === refreshToken
    ? view
    : { ...viewOf(cached), key, api, token: refreshToken }
}
