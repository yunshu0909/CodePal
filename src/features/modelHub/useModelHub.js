/** Page sessions share committed data and pending writes; disclosure state belongs to each page visit. */
import { useEffect, useMemo, useSyncExternalStore } from 'react'

const stores = new WeakMap()
const unavailableApi = {}

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

  async function save(kind, payload) {
    const key = `${kind}:${payload.id}`
    if (snapshot.pending[key]) return null
    mutationGeneration += 1
    publish({ pending: { ...snapshot.pending, [key]: payload } })
    let result
    try {
      result = await api[kind === 'enabled' ? 'modelsHubSetEnabled' : 'modelsHubSetEffort'](payload)
    } catch {
      result = { success: false, error: { message: '出错了' } }
    }
    const pending = { ...snapshot.pending }
    delete pending[key]
    mutationGeneration += 1
    let data = snapshot.data
    if (result.success && data) {
      data = {
        ...data,
        vendors: data.vendors.map((vendor) => ({
          ...vendor,
          models: vendor.models.map((model) => (model.id === payload.id ? { ...model, [kind]: payload[kind] } : model)),
        })),
      }
    }
    publish({ pending, data })
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
  }
}

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
  return { ...snapshot, reload: store.reload, setEnabled: store.setEnabled, setEffort: store.setEffort }
}
