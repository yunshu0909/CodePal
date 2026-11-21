/**
 * Counts are calculated in the main process. Cache identity includes assets, event window and explicit refresh generation.
 * #101（用户 2026-11-21 定）：同一身份的旧数字在后台重算时留着、状态 refreshing（页面标「更新中」），算完原地换；
 * 身份或名字变了（资产增删）照旧先藏起来。重开应用后的第一份旧数字来自主进程存的「上次的次数」。
 */
import { useEffect, useRef, useState } from 'react'
const STALE_MS = 5 * 60 * 1000
// { api, key, token, at, data }；at 为 0 表示从磁盘来的旧数字，只能先显示、必须重读
let usageCache = null
let usageVersion = 0
// 进行中的那一次读取：同一身份、同一刷新代次切走再切回时接着等它，不重复排队
let inflight = null
// 垫进磁盘旧数字时通知已挂着的页面
const listeners = new Set()
/** @returns {void} 清除渲染缓存并使旧响应失效；不写主进程统计存储。 */
export function resetSkillUsageCache() {
  usageCache = null
  inflight = null
  usageVersion += 1
}
/**
 * @param {string[]} names - 已去重排序的名字
 * @param {number} windowDays
 * @param {string} assetIdentity
 * @returns {string} 缓存身份键；主进程存「上次的次数」时原样存它，下次开应用拿来比对
 */
export function usageCacheKey(names, windowDays, assetIdentity) {
  return JSON.stringify([windowDays, names, assetIdentity])
}
/**
 * 用主进程存的「上次的次数」垫底：本次运行里已经有次数缓存就不用它。
 * @param {object|null} api - 当前运行的 electronAPI
 * @param {{cacheKey: string, data: {skills: object[]}}} entry
 * @returns {boolean} 用上了没有
 */
export function seedSkillUsageCache(api, entry) {
  if (!entry || typeof entry.cacheKey !== 'string' || !Array.isArray(entry.data?.skills)) return false
  if (usageCache?.api === api) return false
  usageCache = { api, key: entry.cacheKey, token: null, at: 0, data: { ...entry.data, batchId: null } }
  listeners.forEach((listener) => listener())
  return true
}
/**
 * 同一身份才有旧数字可显示；5 分钟内、同一刷新代次的才直接用，其余要重读。
 * @returns {{data: object|null, reuse: boolean}}
 */
function lookup(api, key, token) {
  if (!key || usageCache?.api !== api || usageCache.key !== key) return { data: null, reuse: false }
  const reuse = usageCache.at > 0 && usageCache.token === token && Date.now() - usageCache.at < STALE_MS
  return { data: usageCache.data, reuse }
}
/**
 * 发起（或接上进行中的）一次读取；成功且仍是最新发起的那次才写进缓存，页面卸载了也写。
 * 带上身份键：主进程据此存一份「上次的次数」。
 * @returns {{promise: Promise<object>}}
 */
function startQuery(api, query, key, token, windowDays, names) {
  if (inflight && inflight.api === api && inflight.key === key && inflight.token === token) return inflight
  const version = ++usageVersion
  const request = { api, key, token }
  let pending
  try {
    pending = Promise.resolve(query({ windowDays, skillNames: names, cacheKey: key }))
  } catch (error) {
    pending = Promise.reject(error)
  }
  request.promise = pending
    .then((result) => {
      if (result?.success && result.data && version === usageVersion)
        usageCache = { key, api, token, at: Date.now(), data: result.data }
      return result
    })
    .finally(() => {
      if (inflight === request) inflight = null
    })
  inflight = request
  return request
}
function viewOf(data, status) {
  const usageMap = new Map()
  for (const skill of data?.skills || []) usageMap.set(skill.name, skill)
  return {
    status: status || (data ? 'ready' : 'loading'),
    usageMap,
    // 更新中的旧数字不带批次：明细要和新数字同一批，等新批次
    batchId: status === 'refreshing' ? null : data?.batchId || null,
    sources: data?.scanMeta?.sources || data?.sources || null,
    scanMeta: data?.scanMeta || null,
  }
}
function initialView(cached) {
  if (!cached.data) return viewOf(null, 'loading')
  return viewOf(cached.data, cached.reuse ? 'ready' : 'refreshing')
}
/**
 * @param {string[]} skillNames - 当前普通资产名字。
 * @param {number} windowDays - 加载过程的事件窗口，默认近 30 天。
 * @param {string|number} refreshToken - 显式刷新代次。
 * @param {string} assetIdentity - 来源身份；启用开关不改变它。
 * @param {{verified?: boolean}} [options] - verified=false：名字和身份来自上次关应用前的快照、还没核对，
 *   只显示同一身份的旧数字，不去读（核对完再读，免得把别的资产的次数挂到旧条目上、存错身份）。
 * @returns {object} 主进程统计视图与 batchId；只缓存展示，不在渲染层计数。
 * status：loading（没有可显示的数字）/ refreshing（显示旧数字，后台在重读）/ ready / error。
 * 过期或显式刷新时旧数字留着（refreshing）；身份改变立即隐藏旧数字；迟到响应不能覆盖新批次。
 */
export default function useSkillUsage(
  skillNames,
  windowDays = 30,
  refreshToken = 0,
  assetIdentity = '',
  { verified = true } = {}
) {
  const api = typeof window !== 'undefined' ? window.electronAPI : null
  const names = Array.isArray(skillNames) ? [...new Set(skillNames)].sort() : []
  const key = names.length ? usageCacheKey(names, windowDays, assetIdentity) : ''
  const cached = lookup(api, key, refreshToken)
  const [view, setView] = useState(() => ({ ...initialView(cached), key, api, token: refreshToken }))
  const [seeded, setSeeded] = useState(0)
  const reqRef = useRef(0)
  useEffect(() => {
    const listener = () => setSeeded((count) => count + 1)
    listeners.add(listener)
    return () => listeners.delete(listener)
  }, [])
  useEffect(() => {
    let active = true
    const requestId = ++reqRef.current
    const apply = (data, status) =>
      setView({ ...viewOf(data, status), key, api, token: refreshToken })
    if (!key) {
      apply({ skills: [] })
      return undefined
    }
    const query = api?.skillUsageAggregate || api?.aggregateSkillUsage
    if (!query) {
      apply(null, 'error')
      return undefined
    }
    const current = lookup(api, key, refreshToken)
    if (current.reuse) {
      apply(current.data)
      return undefined
    }
    apply(current.data, current.data ? 'refreshing' : 'loading')
    if (!verified) return undefined
    startQuery(api, query, key, refreshToken, windowDays, names)
      .promise.then((result) => {
        if (!active || requestId !== reqRef.current) return
        if (!result?.success || !result.data) apply(null, 'error')
        else apply(result.data)
      })
      .catch(() => {
        if (active && requestId === reqRef.current) apply(null, 'error')
      })
    return () => {
      active = false
    }
    // The stable key captures names and verified identity; API result objects do not trigger rereads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, key, refreshToken, verified, seeded])
  return view.key === key && view.api === api && view.token === refreshToken
    ? view
    : { ...initialView(cached), key, api, token: refreshToken }
}
