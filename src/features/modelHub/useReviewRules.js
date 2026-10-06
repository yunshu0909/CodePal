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
  else if (key.startsWith('gates.')) {
    const [, a, b, field] = key.split('.')
    next.gates[`${a}.${b}`][field] = value
  } else next.advanced[key.slice('advanced.'.length)] = value
  return next
}

// 保存成功意味着审核配置也已按新设置写进去
const EXPORTED = { exportOk: true, exportUsing: null }
const differs = (a, b) => JSON.stringify(a) !== JSON.stringify(b)

function messageOf(result) {
  if (result.error?.code === 'HUB_FILE_INVALID') return '模型汇总的设置文件无法解析，修好或删除它后重试'
  if (result.error?.code === 'RULES_FILE_INVALID') return '审核规则文件无法解析，修好或删除它后重试'
  return result.error?.message || '出错了'
}

function createStore(api) {
  let snapshot = { data: null, loading: true, error: null, pending: {} }
  let readSequence = 0
  let mutationGeneration = 0
  const listeners = new Set()
  const publish = (patch) => {
    snapshot = { ...snapshot, ...patch }
    listeners.forEach((listener) => listener())
  }
  async function call(method, payload) {
    try {
      return await api[method](payload)
    } catch {
      return { success: false, error: { message: '出错了' } }
    }
  }

  async function reload({ reset = false } = {}) {
    const sequence = ++readSequence
    const generation = mutationGeneration
    if (reset || !snapshot.data) publish({ data: null, loading: true, error: null })
    const result = await call('modelsRulesGet')
    if (sequence !== readSequence || generation !== mutationGeneration || Object.keys(snapshot.pending).length) return
    if (result.success) publish({ data: result.data, loading: false, error: null })
    else publish({ data: null, loading: false, error: messageOf(result) })
  }

  /**
   * 改一项：先显示新值并禁用这一个控件，「改过没有」跟着显示的值算（定稿 N4-4）；
   * 成功换上主进程给的「改过没有」，审核配置也已写进去（红字消失）；失败退回原值
   */
  async function set(key, value) {
    if (!snapshot.data || snapshot.pending[key] || snapshot.pending.reset) return null
    const before = snapshot.data
    const shown = withValue(before.effective, key, value)
    mutationGeneration += 1
    publish({
      pending: { ...snapshot.pending, [key]: true },
      data: { ...before, effective: shown, changed: before.suggested ? differs(shown, before.suggested) : before.changed },
    })
    const result = await call('modelsRulesSet', { key, value })
    const pending = { ...snapshot.pending }
    delete pending[key]
    mutationGeneration += 1
    const current = snapshot.data
    let data
    if (result.success) data = { ...current, changed: result.data?.changed ?? current.changed, ...EXPORTED }
    else {
      const effective = withValue(current.effective, key, valueAt(before.effective, key))
      data = { ...current, effective, changed: current.suggested ? differs(effective, current.suggested) : before.changed }
    }
    publish({ pending, data })
    return result
  }

  async function reset() {
    if (!snapshot.data || Object.keys(snapshot.pending).length) return null
    mutationGeneration += 1
    publish({ pending: { ...snapshot.pending, reset: true } })
    const result = await call('modelsRulesReset')
    const pending = { ...snapshot.pending }
    delete pending.reset
    mutationGeneration += 1
    publish({
      pending,
      data: result.success ? { ...snapshot.data, effective: result.data.effective, changed: false, ...EXPORTED } : snapshot.data,
    })
    return result
  }

  /** F13 重试；另一个 CodePal 占着写入锁时红字状态不变，由页面提示原因 */
  async function republish() {
    const result = await call('modelsConfigRepublish')
    if (snapshot.data && result.success) {
      const exportOk = result.data.exportOk === true
      publish({ data: { ...snapshot.data, exportOk, ...(exportOk ? EXPORTED : {}) } })
    }
    return result
  }

  /** 模型页签保存成功时审核配置也已写进去：同步清掉红字 */
  function markExported() {
    if (snapshot.data && snapshot.data.exportOk === false) publish({ data: { ...snapshot.data, ...EXPORTED } })
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
  if (key.startsWith('gates.')) {
    const [, a, b, field] = key.split('.')
    return effective.gates[`${a}.${b}`][field]
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
