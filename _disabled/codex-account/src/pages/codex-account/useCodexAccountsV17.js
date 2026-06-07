/**
 * V1.7 Codex 账户数据管理 hook
 *
 * 与 V1.6 的 useCodexAccounts 并存。V1.7 行为差异：
 * - 数据源：accounts/{name}/.codex/auth.json（每账号独立）+ active.json 指针
 * - 三档状态由后端 codexStatusJudge 计算后随 list 返回（color/label/reason）
 * - 切换 = 改 active.json + spawn 时注入 CODEX_HOME，不写 ~/.codex/
 * - 新增账号闭环：beginLogin → spawn codex login → 监听 auth-captured 事件 → finalizeLogin 给名字
 * - 迁移、cloud sync 警告事件由 onMigrationEvent / onCloudSyncWarning 推送
 *
 * @module pages/codex-account/useCodexAccountsV17
 */

import { useCallback, useEffect, useRef, useState } from 'react'

const INITIAL_STATE = Object.freeze({
  loading: true,
  error: null,
  accounts: [],          // [{ name, email, plan, accountId, active, state, status: { color, label, reason } }]
  activeName: null,
  bootstrap: null,       // { ok, stage, migration?, cloudSync? }
  cloudSyncWarning: null, // 收到 cloud sync 警告时的最新 payload
})

/**
 * V1.7 hook
 *
 * @param {{ onLoginEvent?: (payload: object) => void }} [options]
 * @returns {object}
 */
export function useCodexAccountsV17(options = {}) {
  const [state, setState] = useState(INITIAL_STATE)
  const [migration, setMigration] = useState(null) // { type: 'started' | 'done', result? }
  const loginSessionRef = useRef(null)             // 当前进行中的 login session

  const reload = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }))
    try {
      const [listResp, bootstrapResp] = await Promise.all([
        window.electronAPI.codexAccountV17.list(),
        window.electronAPI.codexAccountV17.getBootstrap(),
      ])
      if (!listResp?.ok) {
        setState((s) => ({ ...s, loading: false, error: listResp?.error || 'LIST_FAILED' }))
        return
      }
      const active = listResp.accounts.find((a) => a.active)
      setState({
        loading: false,
        error: null,
        accounts: listResp.accounts || [],
        activeName: active?.name ?? null,
        bootstrap: bootstrapResp?.ok ? bootstrapResp : null,
        cloudSyncWarning: bootstrapResp?.cloudSync?.sync ? bootstrapResp.cloudSync : null,
      })
    } catch (err) {
      setState((s) => ({ ...s, loading: false, error: err?.message || 'LIST_FAILED' }))
    }
  }, [])

  useEffect(() => {
    reload()
    const offLogin = window.electronAPI.codexAccountV17.onLoginEvent?.((payload) => {
      // auth-captured：spawn 的 codex login 已写出 auth.json，提示 UI 弹层让用户命名
      // finalized：用户确认名字 + atomic rename 完成
      // aborted：登录超时或被取消
      options.onLoginEvent?.(payload)
      if (payload.type === 'finalized' || payload.type === 'aborted') {
        loginSessionRef.current = null
        reload()
      }
    })
    const offMigration = window.electronAPI.codexAccountV17.onMigrationEvent?.((payload) => {
      setMigration(payload)
      if (payload.type === 'done') reload()
    })
    const offCloud = window.electronAPI.codexAccountV17.onCloudSyncWarning?.((payload) => {
      setState((s) => ({ ...s, cloudSyncWarning: payload }))
    })
    return () => {
      if (typeof offLogin === 'function') offLogin()
      if (typeof offMigration === 'function') offMigration()
      if (typeof offCloud === 'function') offCloud()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const switchAccount = useCallback(async (accountName, options = {}) => {
    const r = await window.electronAPI.codexAccountV17.switch(accountName, options)
    if (r?.ok) await reload()
    return r
  }, [reload])

  const forceRefresh = useCallback(async (accountName) => {
    const r = await window.electronAPI.codexAccountV17.forceRefresh(accountName)
    await reload()
    return r
  }, [reload])

  const renameAccount = useCallback(async (oldName, newName) => {
    const r = await window.electronAPI.codexAccountV17.rename(oldName, newName)
    if (r?.ok) await reload()
    return r
  }, [reload])

  const deleteAccount = useCallback(async (accountName) => {
    const r = await window.electronAPI.codexAccountV17.delete(accountName)
    if (r?.ok) await reload()
    return r
  }, [reload])

  const openCodex = useCallback(async (args = []) => {
    return window.electronAPI.codexAccountV17.openCodex(args)
  }, [])

  /**
   * 启动新账号登录闭环（US-02）
   * 返回 sessionId；UI 用 onLoginEvent 监听 auth-captured 后弹层让用户输入名字
   */
  const beginLogin = useCallback(async () => {
    const r = await window.electronAPI.codexAccountV17.loginBegin()
    if (r?.ok) {
      loginSessionRef.current = r.sessionId
    }
    return r
  }, [])

  const finalizeLogin = useCallback(async (name) => {
    const sessionId = loginSessionRef.current
    if (!sessionId) return { ok: false, code: 'NO_ACTIVE_SESSION' }
    return window.electronAPI.codexAccountV17.loginFinalize(sessionId, name)
    // 状态在 login-event 'finalized' 推送后由订阅器 reload
  }, [])

  const cancelLogin = useCallback(async () => {
    const sessionId = loginSessionRef.current
    if (!sessionId) return { ok: true, noop: true }
    return window.electronAPI.codexAccountV17.loginCancel(sessionId)
  }, [])

  return {
    ...state,
    migration,
    reload,
    switchAccount,
    forceRefresh,
    renameAccount,
    deleteAccount,
    openCodex,
    beginLogin,
    finalizeLogin,
    cancelLogin,
  }
}
