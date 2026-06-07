/**
 * V1.7 新账号登录闭环弹层（US-02 步骤 5）
 *
 * 流程：
 *   1. 用户点"新增账号" → 调 beginLogin → 后端起 codex login 子进程 + 监听 auth.json
 *   2. 本组件弹出："请在打开的 Codex 窗口完成登录，登录成功后回到这里给账户起名"
 *   3. 后端 watcher 监听到 auth.json 出现 → 推送 onLoginEvent('auth-captured') → 本组件展示输入框
 *   4. 用户输入名字 → finalizeLogin → atomic rename → close
 *   5. 取消 / 超时 → cancelLogin + close
 *
 * @module pages/codex-account/CodexLoginCaptureModalV17
 */

import React, { useEffect, useState } from 'react'
import Modal from '../../components/Modal/Modal'
import Button from '../../components/Button/Button'

/**
 * @param {{
 *   open: boolean,
 *   existingNames: string[],
 *   onBegin: () => Promise<{ ok: boolean }>,
 *   onFinalize: (name: string) => Promise<{ ok: boolean, code?: string, error?: string }>,
 *   onCancel: () => Promise<void>,
 *   onClose: () => void,
 * }} props
 *
 * V1.7 P0-1 修复：本组件直接订阅 window.electronAPI.codexAccountV17.onLoginEvent，
 * 不再依赖父组件转发缓存事件——避免 setState 触发 page re-render 时 useEffect 不重订阅导致丢事件。
 */
export default function CodexLoginCaptureModalV17({
  open,
  existingNames = [],
  onBegin,
  onFinalize,
  onCancel,
  onClose,
}) {
  // 'starting' → 'waiting-codex' → 'auth-captured' → 'naming' → 'submitting' → 'done' / 'error'
  const [phase, setPhase] = useState('starting')
  const [errorMsg, setErrorMsg] = useState('')
  const [name, setName] = useState('')

  // 组件挂载后启动 login 流程
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setPhase('starting')
    setErrorMsg('')
    setName('')

    ;(async () => {
      const r = await onBegin()
      if (cancelled) return
      if (!r?.ok) {
        setPhase('error')
        setErrorMsg(r?.error || '登录启动失败，请重试')
        return
      }
      setPhase('waiting-codex')
    })()

    // V1.7 P0-1 修复：直接订阅 IPC 事件而不是父组件转发
    const unsubscribe = window.electronAPI?.codexAccountV17?.onLoginEvent?.((payload) => {
      if (cancelled) return
      if (payload.type === 'auth-captured') {
        setPhase('naming')
      } else if (payload.type === 'aborted') {
        setPhase('error')
        if (payload.reason === 'login-timeout') {
          setErrorMsg('登录超时（5 分钟内未完成）。请重试。')
        } else if (payload.reason === 'spawn-error') {
          setErrorMsg(`Codex 启动失败：${payload.error || ''}`)
        } else {
          setErrorMsg('登录已取消')
        }
      }
    })

    return () => {
      cancelled = true
      if (typeof unsubscribe === 'function') unsubscribe()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const validate = (n) => {
    if (!n) return '请输入账户名'
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(n)) return '账户名只能包含字母、数字、点、下划线、连字符'
    if (existingNames.includes(n)) return '账户名已存在，请换一个'
    return ''
  }

  const handleSubmit = async () => {
    const err = validate(name.trim())
    if (err) { setErrorMsg(err); return }
    setPhase('submitting')
    const r = await onFinalize(name.trim())
    if (r?.ok) {
      setPhase('done')
      onClose?.()
    } else {
      setPhase('naming')
      setErrorMsg(mapFinalizeError(r?.code, r?.error))
    }
  }

  const handleCancel = async () => {
    await onCancel?.()
    onClose?.()
  }

  if (!open) return null

  // V1.7 P1-3 修复：submitting 时禁用遮罩关闭——避免 atomic rename 中途被 cancelLogin 打断
  const isSubmitting = phase === 'submitting'
  const footer = (phase === 'naming' || phase === 'submitting') ? (
    <>
      <Button variant="ghost" onClick={handleCancel} disabled={isSubmitting}>取消</Button>
      <Button variant="primary" onClick={handleSubmit} loading={isSubmitting}>保存账户</Button>
    </>
  ) : (
    <Button variant="ghost" onClick={handleCancel}>取消</Button>
  )

  return (
    <Modal
      open={open}
      onClose={isSubmitting ? () => {} : handleCancel}
      closeOnOverlay={!isSubmitting}
      title="新增 Codex 账户"
      footer={footer}
    >
      <div className="codex-login-capture">
        {phase === 'starting' && <p>正在准备登录环境…</p>}
        {phase === 'waiting-codex' && (
          <div>
            <p>已为你打开 Codex 登录窗口。请完成 OAuth 登录后回到这里。</p>
            <p className="codex-login-capture__hint">登录成功后系统会自动捕获凭证，无需在此手动操作。</p>
          </div>
        )}
        {(phase === 'naming' || phase === 'submitting') && (
          <div>
            <p>登录成功！请给这个账户起一个名字（方便日后切换识别）。</p>
            <input
              className="codex-login-capture__name-input"
              type="text"
              value={name}
              autoFocus
              maxLength={64}
              placeholder="例如：my-work / personal-test"
              onChange={(e) => { setName(e.target.value); if (errorMsg) setErrorMsg('') }}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit() }}
              disabled={isSubmitting}
            />
            <p className="codex-login-capture__hint">保存后会加入到账户列表，但不会切换为当前账号。需要使用时在卡片上点「切换」。</p>
            {errorMsg && <div className="codex-login-capture__error">{errorMsg}</div>}
          </div>
        )}
        {phase === 'error' && (
          <div className="codex-login-capture__error">{errorMsg}</div>
        )}
        {phase === 'done' && <p>账户已保存。</p>}
      </div>
    </Modal>
  )
}

function mapFinalizeError(code, error) {
  switch (code) {
    case 'INVALID_NAME': return '账户名只能包含字母、数字、点、下划线、连字符（1-64 字符）'
    case 'NAME_EXISTS': return '账户名已存在，请换一个'
    case 'AUTH_MISSING': return '登录凭证尚未就位，请稍等几秒再试'
    case 'RENAME_FAILED': return `保存账户失败：${error || '未知错误'}`
    case 'INVALID_SESSION': return '登录会话已失效，请重新发起'
    default: return error || '保存失败，请重试'
  }
}
