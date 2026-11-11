/**
 * 审核规则页签的数据：读、点了就保存（保存中禁用、失败退回）、恢复默认、审核配置重试
 *
 * 和模型页签一样按 window.electronAPI 共用一个 store：离开再进入先显示上次的，读完静默更新；
 * 窗口回到前台只重读数据（页签和展开状态由页面自己管）。
 *
 * @module features/modelHub/useReviewRules
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react'

const stores = new WeakMap()
const unavailableApi = {}

/** 把一个规则键的新值写进生效规则的副本 */
function withValue(effective, key, value) {
  const next = structuredClone(effective)
  if (key === 'selfReview') next.selfReview = value
  else if (key.startsWith('gates.') || key.startsWith('designGates.')) {
    // gates.<门>.<字段>；两道设计审查只有轮数，键是 designGates.<门>.rounds（v2.1.28）
    const [group, a, b, field] = key.split('.')
    next[group][`${a}.${b}`][field] = value
  } else next.advanced[key.slice('advanced.'.length)] = value
  return next
}

// 保存成功意味着审核配置也已按新设置写进去
const EXPORTED = { exportOk: true, exportUsing: null }
// 模型页保存成功、正在去主进程核对实际状态（比它早发出的结果不算数，也不再续读）
const CHECKING = 'checking'
const differs = (a, b) => JSON.stringify(a) !== JSON.stringify(b)

function messageOf(result) {
  if (result.error?.code === 'HUB_FILE_INVALID') return '模型汇总的设置文件无法解析，修好或删除它后重试'
  if (result.error?.code === 'RULES_FILE_INVALID') return '审核规则文件无法解析，修好或删除它后重试'
  return result.error?.message || '出错了'
}

function createStore(api) {
  let snapshot = { data: null, loading: true, error: null, pending: {} }
  let readSequence = 0
  // 红字的先后按「发出顺序」算（v2.1.29 #78 G1）：主进程按收到的顺序逐个同步处理这些请求，
  // 后发出的读 / 写看到的磁盘一定在先发出的写之后。每次读、写、重试发出时领一个号；
  // latest 是已经回来的、号最大的那次结果（exported：true 写进去了，false 没写进去，null 规则保存失败、说不准）
  let issued = 0
  let latest = { ticket: 0, exported: null }
  // 发出了、还没回来的读写和重试有几个（模型页保存先后说不准时要不要去主进程核对）
  let inFlight = 0
  const listeners = new Set()
  const publish = (patch) => {
    snapshot = { ...snapshot, ...patch }
    listeners.forEach((listener) => listener())
  }
  async function call(method, payload) {
    inFlight += 1
    try {
      return await api[method](payload)
    } catch {
      return { success: false, error: { message: '出错了' } }
    } finally {
      inFlight -= 1
    }
  }
  /** 一次结果回来：比已生效的更早发出的不算数（它之后的读写已经看到了它的结果）；算数就记成最新 */
  function settle(ticket, exported) {
    if (ticket < latest.ticket) return false
    latest = { ticket, exported }
    return true
  }

  async function reload({ reset = false } = {}) {
    const sequence = ++readSequence
    if (reset || !snapshot.data) publish({ data: null, loading: true, error: null })
    for (;;) {
      const ticket = ++issued
      const result = await call('modelsRulesGet')
      if (sequence !== readSequence || Object.keys(snapshot.pending).length) return
      if (ticket < latest.ticket) {
        // 读的途中有后发出的读写回来了：这份读数更旧。页面有数据就留着现在的；没有（加载中、错误态）就再读一遍
        if (snapshot.data) return
        continue
      }
      if (result.success) {
        settle(ticket, result.data.exportOk)
        publish({ data: result.data, loading: false, error: null })
      } else publish({ data: null, loading: false, error: messageOf(result) })
      return
    }
  }

  /**
   * 改一项：先显示新值并禁用这一个控件，「改过没有」跟着显示的值算（定稿 N4-4）；
   * 成功换上主进程给的「改过没有」，审核配置也已写进去（红字消失）；失败退回原值
   */
  async function set(key, value) {
    if (!snapshot.data || snapshot.pending[key] || snapshot.pending.reset) return null
    const before = snapshot.data
    const shown = withValue(before.effective, key, value)
    const ticket = ++issued
    publish({
      pending: { ...snapshot.pending, [key]: true },
      data: { ...before, effective: shown, changed: before.suggested ? differs(shown, before.suggested) : before.changed },
    })
    const result = await call('modelsRulesSet', { key, value })
    const pending = { ...snapshot.pending }
    delete pending[key]
    const current = snapshot.data
    let data
    if (result.success) {
      // 红字只认比已生效的结果更晚发出的这次保存
      const exported = settle(ticket, true) ? EXPORTED : {}
      data = { ...current, changed: result.data?.changed ?? current.changed, ...exported }
    } else {
      settle(ticket, null)
      const effective = withValue(current.effective, key, valueAt(before.effective, key))
      data = { ...current, effective, changed: current.suggested ? differs(effective, current.suggested) : before.changed }
    }
    publish({ pending, data })
    return result
  }

  async function reset() {
    if (!snapshot.data || Object.keys(snapshot.pending).length) return null
    const ticket = ++issued
    publish({ pending: { ...snapshot.pending, reset: true } })
    const result = await call('modelsRulesReset')
    const pending = { ...snapshot.pending }
    delete pending.reset
    let data = snapshot.data
    if (result.success) {
      const exported = settle(ticket, true) ? EXPORTED : {}
      data = { ...snapshot.data, effective: result.data.effective, changed: false, ...exported }
    } else settle(ticket, null)
    publish({ pending, data })
    return result
  }

  /**
   * 重试仍写不进去：「dev 在用什么」按重试之后的磁盘状态重读（上一份有效配置可能在这期间没了），
   * 只换红字这两项，不动页面上正在显示的规则（v2.1.29 #78 用户选「只换红字，规则不动」）。
   * 读的途中有后发出的写入回来了：写进去了（红字已清）、或模型页保存成功正在核对，就不再续读；
   * 规则保存失败、或又一次没写进去，按磁盘再读一遍；
   * 重读失败：不再猜 dev 在用哪份（exportUsing: 'unknown'），留在页面、规则照常显示（用户选「留在页面，红字不再猜」）；
   * 模型页保存成功后的核对（afterExported）读失败时红字保持清掉
   */
  async function refreshExport({ afterExported = false } = {}) {
    for (;;) {
      const ticket = ++issued
      const fresh = await call('modelsRulesGet')
      if (!snapshot.data) return
      if (ticket < latest.ticket) {
        if (latest.exported === true || latest.exported === CHECKING) return
        continue
      }
      if (fresh.success) {
        settle(ticket, fresh.data.exportOk)
        publish({ data: { ...snapshot.data, exportOk: fresh.data.exportOk, exportUsing: fresh.data.exportUsing } })
      } else if (!afterExported) {
        settle(ticket, false)
        publish({ data: { ...snapshot.data, exportOk: false, exportUsing: 'unknown' } })
      }
      return
    }
  }

  /** F13 重试；另一个 CodePal 占着写入锁时红字状态不变，由页面提示原因。比已生效的结果更早发出的这次重试不改红字 */
  async function republish() {
    const ticket = ++issued
    const result = await call('modelsConfigRepublish')
    if (!result.success) return result
    const exported = result.data.exportOk === true
    if (!settle(ticket, exported)) return result
    if (exported) {
      if (snapshot.data) publish({ data: { ...snapshot.data, ...EXPORTED } })
    } else if (snapshot.data) await refreshExport()
    return result
  }

  /**
   * 模型页签保存成功时审核配置也已写进去：同步清掉红字；比它早发出的读数作废（页面没数据时也记下，v2.1.29 #78）。
   * 这里只知道保存什么时候回来、不知道什么时候发出：还有读写或重试在路上、或红字正显示着时，先后说不准，
   * 去主进程读一次实际状态，红字按读回来的说（G1 第 4 轮 F-001）
   */
  function markExported() {
    const uncertain = inFlight > 0 || snapshot.data?.exportOk === false
    settle(++issued, uncertain ? CHECKING : true)
    if (snapshot.data && snapshot.data.exportOk === false) publish({ data: { ...snapshot.data, ...EXPORTED } })
    if (uncertain && snapshot.data) refreshExport({ afterExported: true })
  }

  return {
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => snapshot,
    reload,
    set,
    reset,
    republish,
    markExported,
  }
}

function valueAt(effective, key) {
  if (key === 'selfReview') return effective.selfReview
  if (key.startsWith('gates.') || key.startsWith('designGates.')) {
    const [group, a, b, field] = key.split('.')
    return effective[group][`${a}.${b}`][field]
  }
  return effective.advanced[key.slice('advanced.'.length)]
}

export { valueAt }

/** @returns {{data, loading, error, pending, reload, set, reset, republish, markExported}} */
export default function useReviewRules() {
  const api = window.electronAPI || unavailableApi
  const store = useMemo(() => {
    if (!stores.has(api)) stores.set(api, createStore(api))
    return stores.get(api)
  }, [api])
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
  useEffect(() => {
    store.reload()
    const refresh = () => store.reload()
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [store])
  return {
    ...snapshot,
    reload: store.reload,
    set: store.set,
    reset: store.reset,
    republish: store.republish,
    markExported: store.markExported,
  }
}
