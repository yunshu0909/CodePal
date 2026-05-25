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
 * @module pages/codex-account/CodexAccountRouter
 */

import React, { useEffect, useState } from 'react'

export function CodexAccountRouter({ v17, legacy }) {
  const [decision, setDecision] = useState('loading') // 'loading' | 'v17' | 'legacy'

  useEffect(() => {
    let cancelled = false
    const detect = async () => {
      try {
        if (!window.electronAPI?.codexAccountV17?.getBootstrap) {
          if (!cancelled) setDecision('legacy')
          return
        }
        const r = await window.electronAPI.codexAccountV17.getBootstrap()
        if (cancelled) return
        // bootstrap ok + 迁移成功（或不需要迁移）→ 走 V1.7
        if (r?.ok) {
          setDecision('v17')
        } else {
          // 迁移失败或 bootstrap 未跑 → 安全回退 V1.6
          // eslint-disable-next-line no-console
          console.warn('[codex-account-router] V1.7 bootstrap not ok, fallback to V1.6', r)
          setDecision('legacy')
        }
      } catch (err) {
        if (!cancelled) {
          // eslint-disable-next-line no-console
          console.warn('[codex-account-router] V1.7 detect failed, fallback to V1.6:', err?.message)
          setDecision('legacy')
        }
      }
    }
    detect()
    return () => { cancelled = true }
  }, [])

  if (decision === 'loading') {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--cs-text-tertiary, #888)' }}>
        正在准备 Codex 账户…
      </div>
    )
  }
  return decision === 'v17' ? v17 : legacy
}
