/**
 * Codex 账户数据管理 hook
 *
 * 负责：
 * - 拉取账户列表 + 当前激活 + 未保存激活账户
 * - 检测存储模式（keyring → 整页占位）
 * - 订阅 chokidar 推送的"新账户检测"事件
 * - 暴露 save / switch / rename / delete 四个操作，自动刷新列表
 *
 * @module pages/codex-account/useCodexAccounts
 */

import { useCallback, useEffect, useRef, useState } from 'react'

const INITIAL_STATE = Object.freeze({
  loading: true,
  error: null,
  storageMode: 'file',
  accounts: [],
  activeName: '',
  hasUnsavedActive: false,
  unsavedActive: null,
})

/**
 * Codex 账户 hook
 * @param {object} options
 * @param {(payload: object) => void} [options.onNewAccountDetected] - chokidar 推送时触发
 * @returns {object} 数据 state + 操作方法
 */
export function useCodexAccounts(options = {}) {
  const [state, setState] = useState(INITIAL_STATE)
  // 保存此次"Session 内忽略"的 account_id（点了"暂不保存"后本次会话不再提示）
  const ignoredIdsRef = useRef(new Set())

  const reload = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }))
    try {
      const storage = await window.electronAPI.codexAccount.detectStorage()
      const mode = storage?.mode || 'file'
      if (mode !== 'file') {
        setState({
          ...INITIAL_STATE,
          loading: false,
          storageMode: mode,
        })
        return
      }

      const r = await window.electronAPI.codexAccount.list()
      if (!r?.success) {
        setState((s) => ({ ...s, loading: false, error: r?.error || 'LIST_FAILED' }))
        return
      }

      const unsaved = r.hasUnsavedActive && r.unsavedActive
      const ignored = unsaved && ignoredIdsRef.current.has(r.unsavedActive?.accountId)
      setState({
        loading: false,
        error: null,
        storageMode: 'file',
        accounts: r.accounts || [],
        activeName: r.activeName || '',
        hasUnsavedActive: Boolean(unsaved) && !ignored,
        unsavedActive: (unsaved && !ignored) ? r.unsavedActive : null,
      })
    } catch (err) {
      setState((s) => ({ ...s, loading: false, error: err?.message || 'LIST_FAILED' }))
    }
  }, [])

  // 首次挂载 + 订阅 chokidar 推送
  useEffect(() => {
    reload()
    const off = window.electronAPI.codexAccount.onNewAccountDetected?.((payload) => {
      // 不论在不在前台，都刷新列表（让未保存卡可见）
      reload()
      options.onNewAccountDetected?.(payload)
    })
    return () => { if (typeof off === 'function') off() }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const saveAccount = useCallback(async (name) => {
    const r = await window.electronAPI.codexAccount.save(name)
    if (r?.success) await reload()
    return r
  }, [reload])

  const switchAccount = useCallback(async (targetName) => {
    const r = await window.electronAPI.codexAccount.switch(targetName)
    if (r?.success) await reload()
    return r
  }, [reload])

  const renameAccount = useCallback(async (oldName, newName) => {
    const r = await window.electronAPI.codexAccount.rename(oldName, newName)
    if (r?.success) await reload()
    return r
  }, [reload])

  const deleteAccount = useCallback(async (name) => {
    const r = await window.electronAPI.codexAccount.delete(name)
    if (r?.success) await reload()
    return r
  }, [reload])

  const openCodex = useCallback(async () => {
    return window.electronAPI.codexAccount.openCodex()
  }, [])

  // V1.6.2: 手动续签指定槽位（重新登录前后用）
  const refreshSlot = useCallback(async (name, force = true) => {
    const r = await window.electronAPI.codexAccount.refreshSlot(name, force)
    if (r?.success) await reload()
    return r
  }, [reload])

  /** 本次会话忽略未保存激活账户（不做持久化，重启即失效） */
  const ignoreUnsavedActive = useCallback(() => {
    const id = state.unsavedActive?.accountId
    if (id) ignoredIdsRef.current.add(id)
    setState((s) => ({ ...s, hasUnsavedActive: false, unsavedActive: null }))
  }, [state.unsavedActive])

  return {
    ...state,
    reload,
    saveAccount,
    switchAccount,
    renameAccount,
    deleteAccount,
    openCodex,
    refreshSlot,
    ignoreUnsavedActive,
  }
}
