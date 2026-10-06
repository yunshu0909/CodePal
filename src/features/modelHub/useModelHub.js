/** Page sessions share committed data and pending writes; disclosure state belongs to each page visit. */
import { useEffect, useMemo, useSyncExternalStore } from 'react'

const stores = new WeakMap()
const unavailableApi = {}
const API = { enabled: 'modelsHubSetEnabled', effort: 'modelsHubSetEffort' }

/** 开关保存成功后审核在用的顺序：打开排到最后，关掉移出（与主进程同规则） */
function nextOrder(order, id, enabled) {
  const rest = (order || []).filter((item) => item !== id)
  return enabled ? [...rest, id] : rest
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

  async function reload({ reset = false } = {}) {
    const sequence = ++readSequence
    const generation = mutationGeneration
    if (reset || !snapshot.data) publish({ data: null, loading: true, error: null })
    let result
    try {
      result = await api.modelsHubList()
    } catch {
      result = { success: false, error: { message: '出错了' } }
    }
    // A read begun before a write cannot replace newly committed preferences or optimistic controls.
    if (sequence !== readSequence || generation !== mutationGeneration || Object.keys(snapshot.pending).length) return
    if (result.success) publish({ data: result.data, loading: false, error: null })
    else
      publish({
        data: null,
        loading: false,
        error:
          result.error?.code === 'HUB_FILE_INVALID'
            ? '模型汇总的设置文件无法解析，修好或删除它后重试'
            : result.error?.message || '出错了',
      })
  }

  async function call(method, payload) {
    try {
      return await api[method](payload)
    } catch {
      return { success: false, error: { message: '出错了' } }
    }
  }

  async function save(kind, payload) {
    const key = `${kind}:${payload.id}`
    if (snapshot.pending[key] || snapshot.pending.order) return null
    mutationGeneration += 1
    publish({ pending: { ...snapshot.pending, [key]: payload } })
    const result = await call(API[kind], payload)
    const pending = { ...snapshot.pending }
    delete pending[key]
    mutationGeneration += 1
    let data = snapshot.data
    if (result.success && data) {
      data = {
        ...data,
        order: kind === 'enabled' ? nextOrder(data.order, payload.id, payload.enabled) : data.order,
        vendors: data.vendors.map((vendor) => ({
          ...vendor,
          models: vendor.models.map((model) => {
            if (model.id !== payload.id) return model
            const next = { ...model, [kind]: payload[kind] }
            if (kind === 'effort') delete next.effortUnsupported
            return next
          }),
        })),
      }
    }
    publish({ pending, data })
    return result
  }

  /** 整串保存顺序：先显示新顺序、整张卡禁用；失败退回原来的顺序 */
  async function setOrder(order) {
    if (!snapshot.data || Object.keys(snapshot.pending).length) return null
    const previous = snapshot.data.order
    mutationGeneration += 1
    publish({ pending: { ...snapshot.pending, order: true }, data: { ...snapshot.data, order } })
    const result = await call('modelsHubSetOrder', { order })
    const pending = { ...snapshot.pending }
    delete pending.order
    mutationGeneration += 1
    publish({ pending, data: snapshot.data && !result.success ? { ...snapshot.data, order: previous } : snapshot.data })
    return result
  }

  return {
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => snapshot,
    reload,
    setEnabled: (payload) => save('enabled', payload),
    setEffort: (payload) => save('effort', payload),
    setOrder,
  }
}

/** 模型页签的数据：进入页面与窗口回到前台都重读（后-07） */
export default function useModelHub() {
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
    setEnabled: store.setEnabled,
    setEffort: store.setEffort,
    setOrder: store.setOrder,
  }
}
