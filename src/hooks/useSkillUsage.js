/**
 * useSkillUsage — 拉取每个 skill 近 N 天调用次数（Claude + Codex 合计）
 *
 * 负责：
 * - 调 IPC `aggregate-skill-usage`（后端扫日志，异步，不阻塞列表渲染）
 * - 模块级缓存 5 分钟：切走切回不重复全扫
 * - 返回 { status, usageMap(name→{total,claude,codex,lastUsedAt}), sources }
 *
 * @module hooks/useSkillUsage
 */
import { useEffect, useRef, useState } from 'react'

const STALE_MS = 5 * 60 * 1000
// 模块级缓存：跨页面切换复用，避免重复全扫
let usageCache = null // { key, at, data }

/**
 * @param {string[]} skillNames - 当前已管理 skill 名（用于过滤噪声 + 限定统计范围）
 * @param {number} [windowDays=30] - 时间窗
 * @returns {{status:'loading'|'ready'|'error', usageMap:Map, sources:object|null}}
 */
export default function useSkillUsage(skillNames, windowDays = 30) {
  const [status, setStatus] = useState('loading')
  const [usageMap, setUsageMap] = useState(() => new Map())
  const [sources, setSources] = useState(null)
  const reqRef = useRef(0)

  // 用排序后的名字串作为依赖键：内容变才重扫，避免数组每次新引用导致无限刷新
  const key = Array.isArray(skillNames) && skillNames.length ? [...skillNames].sort().join('|') : ''

  useEffect(() => {
    if (!key) {
      setStatus('ready'); setUsageMap(new Map()); setSources(null)
      return
    }
    const api = typeof window !== 'undefined' ? window.electronAPI : null
    if (!api || typeof api.aggregateSkillUsage !== 'function') {
      setStatus('error')
      return
    }

    const apply = (data) => {
      const m = new Map()
      for (const s of data.skills || []) m.set(s.name, s)
      setUsageMap(m)
      setSources(data.sources || null)
      setStatus('ready')
    }

    // 命中缓存直接用
    if (usageCache && usageCache.key === key && Date.now() - usageCache.at < STALE_MS) {
      apply(usageCache.data)
      return
    }

    const myReq = ++reqRef.current
    setStatus('loading')
    api
      .aggregateSkillUsage({ windowDays, skillNames })
      .then((res) => {
        if (myReq !== reqRef.current) return // 已有更新的请求，丢弃旧结果
        if (!res || !res.success || !res.data) { setStatus('error'); return }
        usageCache = { key, at: Date.now(), data: res.data }
        apply(res.data)
      })
      .catch(() => { if (myReq === reqRef.current) setStatus('error') })
    // skillNames 故意不入依赖：其内容已由 key 表达，直接入会因引用变化触发无限循环
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, windowDays])

  return { status, usageMap, sources }
}
