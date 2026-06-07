/**
 * Codex 账户页路由分发：V1.7 / V1.6 切换
 *
 * 策略：
 * - bootstrap 已就绪且 ok=true → V1.7 页面
 * - bootstrap 加载中 → 渲染 loading 占位（避免闪烁回 V1.6 → V1.7）
 * - bootstrap 不存在（V1.7 启动编排失败 / 老版本未升级）→ 回退到 V1.6 页面
 *
 * 兜底逻辑保证：即使 V1.7 整体崩，用户仍能用 V1.6 看到账户列表。
 *
 * V1.7.3 新增：fallback 不再静默——顶部挂红色横幅，把 stage + error 直接给用户看，
 * 否则之前那种"代码上了但用户感受不到，开发也排查不到"的体验会反复出现。
 *
 * @module pages/codex-account/CodexAccountRouter
 */

import React, { useCallback, useEffect, useState } from 'react'

export function CodexAccountRouter({ v17, legacy }) {
  const [decision, setDecision] = useState('loading') // 'loading' | 'v17' | 'legacy'
  const [failure, setFailure] = useState(null) // { stage, code, message, raw } | null
  const [dismissed, setDismissed] = useState(false)
  const [retryCounter, setRetryCounter] = useState(0)

  useEffect(() => {
    let cancelled = false
    const detect = async () => {
      try {
        if (!window.electronAPI?.codexAccountV17?.getBootstrap) {
          if (cancelled) return
          setFailure({ stage: 'preload', code: 'NO_API', message: 'electronAPI.codexAccountV17 未注入（老版 preload 或预加载失败）' })
          setDecision('legacy')
          return
        }
        const r = await window.electronAPI.codexAccountV17.getBootstrap()
        if (cancelled) return
        if (r?.ok) {
          setFailure(null)
          setDecision('v17')
          return
        }
        const stage = r?.stage ?? 'unknown'
        const code = r?.error?.code ?? r?.code ?? 'BOOTSTRAP_NOT_OK'
        const message = r?.error?.message ?? '(无 error.message)'
        // eslint-disable-next-line no-console
        console.warn('[codex-account-router] V1.7 bootstrap not ok, fallback to V1.6', r)
        setFailure({ stage, code, message, raw: r })
        setDecision('legacy')
      } catch (err) {
        if (cancelled) return
        // eslint-disable-next-line no-console
        console.warn('[codex-account-router] V1.7 detect threw, fallback to V1.6:', err?.message)
        setFailure({ stage: 'detect', code: 'DETECT_THREW', message: err?.message ?? String(err) })
        setDecision('legacy')
      }
    }
    detect()
    return () => { cancelled = true }
  }, [retryCounter])

  const handleRetry = useCallback(() => {
    setDismissed(false)
    setDecision('loading')
    setRetryCounter((n) => n + 1)
  }, [])

  if (decision === 'loading') {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--cs-text-tertiary, #888)' }}>
        正在准备 Codex 账户…
      </div>
    )
  }

  if (decision === 'v17') return v17

  // legacy 路径：先渲染横幅（除非用户关掉了），再渲染 V1.6 页面
  return (
    <>
      {failure && !dismissed && (
        <FallbackBanner failure={failure} onRetry={handleRetry} onDismiss={() => setDismissed(true)} />
      )}
      {legacy}
    </>
  )
}

function FallbackBanner({ failure, onRetry, onDismiss }) {
  return (
    <div
      role="alert"
      style={{
        background: '#fff1f0',
        border: '1px solid #ffa39e',
        borderLeft: '4px solid #cf1322',
        color: '#820014',
        padding: '12px 16px',
        margin: '12px 16px',
        borderRadius: 4,
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        fontSize: 13,
        lineHeight: 1.5,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>
          V1.7 账户管理启动失败 · 已临时回退到 V1.6 视图
        </div>
        <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, monospace', fontSize: 12, wordBreak: 'break-word' }}>
          stage=<b>{failure.stage}</b> &nbsp; code=<b>{failure.code}</b>
        </div>
        <div style={{ marginTop: 4, fontSize: 12, wordBreak: 'break-word' }}>
          {failure.message}
        </div>
        <div style={{ marginTop: 8, fontSize: 12, opacity: 0.85 }}>
          多账号列表、跨终端 symlink farm 等 V1.7 功能此刻不可用。
          可点"重试启动"再次拉起 bootstrap；若仍失败，请将 DevTools console 中
          <code style={{ margin: '0 4px', padding: '0 4px', background: 'rgba(0,0,0,0.05)', borderRadius: 2 }}>[codex-account-router]</code>
          与 <code style={{ margin: '0 4px', padding: '0 4px', background: 'rgba(0,0,0,0.05)', borderRadius: 2 }}>[v17-bootstrap]</code>
          的告警贴到 issue。
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <button
          type="button"
          onClick={onRetry}
          style={{
            background: '#cf1322',
            color: '#fff',
            border: 'none',
            padding: '4px 12px',
            borderRadius: 3,
            cursor: 'pointer',
            fontSize: 12,
          }}
        >
          重试启动
        </button>
        <button
          type="button"
          onClick={onDismiss}
          style={{
            background: 'transparent',
            color: '#820014',
            border: '1px solid #ffa39e',
            padding: '4px 12px',
            borderRadius: 3,
            cursor: 'pointer',
            fontSize: 12,
          }}
        >
          关闭
        </button>
      </div>
    </div>
  )
}
