/**
 * Codex 账户页 — V1.5.0
 *
 * 负责：
 * - 顶部提示条（"切换会完整重启 Codex 让账号生效"）
 * - 账户卡片网格 + 未保存激活卡
 * - 切换/保存/重命名/删除 4 个流程的 Modal 编排
 * - 空态（无账户 / 未登录 Codex / Keyring 模式）
 * - Toast 反馈（切换中 / 成功 / 失败）
 *
 * 整个页面的数据编排通过 useCodexAccounts hook，
 * IO 操作通过 window.electronAPI.codexAccount 调用主进程。
 *
 * @module pages/CodexAccountPage
 */

import React, { useCallback, useState } from 'react'
import PageShell from '../components/PageShell'
import Button from '../components/Button/Button'
import Toast from '../components/Toast'
import CodexAccountCard from './codex-account/CodexAccountCard'
import UnsavedAccountCard from './codex-account/UnsavedAccountCard'
import CodexSaveModal from './codex-account/CodexSaveModal'
import CodexRenameModal from './codex-account/CodexRenameModal'
import CodexDeleteModal from './codex-account/CodexDeleteModal'
import CodexAddHelpModal from './codex-account/CodexAddHelpModal'
import { useCodexAccounts } from './codex-account/useCodexAccounts'
import './codex-account/codex-account.css'

export default function CodexAccountPage() {
  // Toast { message, type: 'info'|'success'|'warning'|'error' }
  const [toast, setToast] = useState(null)
  // 正在切换的目标账户名（用于卡片 loading 覆盖）
  const [switchingTo, setSwitchingTo] = useState('')
  // 新账户保存 Modal 状态：null = 关闭；object = 打开
  const [saveModal, setSaveModal] = useState(null)
  // 重命名 Modal 目标名（null = 关闭）
  const [renamingName, setRenamingName] = useState(null)
  // 删除 Modal 目标名（null = 关闭）
  const [deletingName, setDeletingName] = useState(null)
  // 新增引导 Modal 开关
  const [addHelpOpen, setAddHelpOpen] = useState(false)

  const {
    loading,
    error,
    storageMode,
    accounts,
    activeName,
    hasUnsavedActive,
    unsavedActive,
    reload,
    saveAccount,
    switchAccount,
    renameAccount,
    deleteAccount,
    openCodex,
    ignoreUnsavedActive,
  } = useCodexAccounts({
    onNewAccountDetected: (payload) => {
      // 打开保存 Modal（如果此时没有别的 Modal 打开）
      setSaveModal(payload)
    },
  })

  // Toast 自己管理消失定时器，这里只需在它关闭时清 state

  // ---------- 操作 handlers ----------

  const handleSwitch = useCallback(async (targetName) => {
    setSwitchingTo(targetName)
    setToast({ message: `正在切换到 ${targetName}，并准备重启 Codex…`, type: 'info' })
    const r = await switchAccount(targetName, { restartCodex: true })
    setSwitchingTo('')

    if (r?.noop) {
      if (r.codexWasRunning && r.restartError) {
        setToast({
          message: `${targetName} 已经是当前账户，但打开 Codex 失败，请手动启动`,
          type: 'warning',
        })
        return
      }
      setToast({
        message: r.codexWasRunning && r.restarted
          ? `${targetName} 已经是当前账户，Codex 已重启`
          : `${targetName} 已经是当前账户，无需切换`,
        type: 'info',
      })
      return
    }
    if (r?.success) {
      if (r.codexWasRunning && r.restartError) {
        setToast({
          message: `已切换到 ${targetName}，但打开 Codex 失败，请手动启动`,
          type: 'warning',
        })
        return
      }
      setToast({
        message: r.codexWasRunning && r.restarted
          ? `已切换到 ${targetName}，Codex 已重启并读取新账户`
          : `已切换到 ${targetName}，下次启动 Codex 生效`,
        type: 'success',
      })
      return
    }
    const errorMessage = mapSwitchError(r?.error, r?.hint)
    setToast({
      message: r?.codexWasRunning && r?.restartError
        ? `${errorMessage}；Codex 重新打开失败，请手动启动`
        : errorMessage,
      type: 'error',
    })
  }, [switchAccount])

  const handleSave = useCallback(async (name) => {
    const r = await saveAccount(name)
    if (r?.success) {
      setSaveModal(null)
      setToast({ message: `已新增账户：${name}`, type: 'success' })
    }
    return r
  }, [saveAccount])

  const handleRename = useCallback(async (oldName, newName) => {
    const r = await renameAccount(oldName, newName)
    if (r?.success) {
      setRenamingName(null)
      setToast({ message: `已重命名为 ${newName}`, type: 'success' })
    }
    return r
  }, [renameAccount])

  const handleDelete = useCallback(async (name) => {
    const r = await deleteAccount(name)
    setDeletingName(null)
    if (r?.success) {
      setToast({ message: `已删除账户 ${name}（冷备份已留存）`, type: 'success' })
    } else {
      setToast({ message: `删除失败：${r?.error || '未知'}`, type: 'error' })
    }
  }, [deleteAccount])

  const handleReLogin = useCallback(async (_name) => {
    const r = await openCodex()
    if (r?.success) {
      setToast({ message: '已打开 Codex，请完成登录后回到此页', type: 'info' })
    } else {
      setToast({ message: '打开 Codex 失败，请手动启动', type: 'error' })
    }
  }, [openCodex])

  const handleOpenCodexFromAddModal = useCallback(async () => {
    setAddHelpOpen(false)
    await openCodex()
  }, [openCodex])

  // ---------- 渲染 ----------

  const headerActions = (
    <Button
      variant="primary"
      onClick={() => setAddHelpOpen(true)}
      disabled={loading || storageMode !== 'file'}
    >
      + 新增账户
    </Button>
  )

  return (
    <PageShell
      title="Codex 账户"
      subtitle="管理多个 ChatGPT 登录凭证，切换时自动重启 Codex"
      actions={headerActions}
    >
      <div className="codex-account-page">
        {renderBody({
          loading,
          error,
          storageMode,
          accounts,
          activeName,
          hasUnsavedActive,
          unsavedActive,
          switchingTo,
          onSwitch: handleSwitch,
          onRename: (name) => setRenamingName(name),
          onDelete: (name) => setDeletingName(name),
          onReLogin: handleReLogin,
          onSaveUnsaved: () => {
            // 点"保存为账户"按钮 → 直接弹 M1（带现有 unsavedActive 数据）
            if (unsavedActive) {
              setSaveModal({
                accountId: unsavedActive.accountId,
                email: unsavedActive.email,
                plan: unsavedActive.plan,
                suggestedName: emailToSuggestedName(unsavedActive.email, accounts),
              })
            }
          },
          onIgnoreUnsaved: ignoreUnsavedActive,
          onRetry: reload,
        })}
      </div>

      <CodexSaveModal
        open={!!saveModal}
        payload={saveModal}
        onConfirm={handleSave}
        onClose={() => setSaveModal(null)}
      />
      <CodexRenameModal
        open={!!renamingName}
        oldName={renamingName}
        onConfirm={handleRename}
        onClose={() => setRenamingName(null)}
      />
      <CodexDeleteModal
        open={!!deletingName}
        name={deletingName}
        onConfirm={handleDelete}
        onClose={() => setDeletingName(null)}
      />
      <CodexAddHelpModal
        open={addHelpOpen}
        onOpenCodex={handleOpenCodexFromAddModal}
        onClose={() => setAddHelpOpen(false)}
      />

      {toast && (
        <Toast
          message={toast.message}
          type={toast.type}
          onClose={() => setToast(null)}
        />
      )}
    </PageShell>
  )
}

// ---------- 渲染工具函数 ----------

function renderBody(ctx) {
  const {
    loading, error, storageMode, accounts, activeName,
    hasUnsavedActive, unsavedActive, switchingTo,
    onSwitch, onRename, onDelete, onReLogin,
    onSaveUnsaved, onIgnoreUnsaved, onRetry,
  } = ctx

  if (loading) return <LoadingSkeleton />

  if (storageMode === 'keyring') return <KeyringGate onRetry={onRetry} />
  if (storageMode === 'auto') return <KeyringGate onRetry={onRetry} />

  if (error) return <ErrorState error={error} onRetry={onRetry} />

  const noAccounts = accounts.length === 0 && !hasUnsavedActive
  if (noAccounts) {
    return <EmptyNoAuthState onRetry={onRetry} />
  }

  return (
    <>
      <div className="codex-intro-bar">
        <span className="codex-intro-bar__icon">ⓘ</span>
        <span>
          切换会先完整退出 Codex，再保存当前凭证、替换目标凭证并重新打开，确保新账户立即生效。
          5 小时 / 7 天窗口的重置时间从上次切入起估算。
        </span>
      </div>

      <div className="codex-account-grid">
        {hasUnsavedActive && (
          <UnsavedAccountCard
            unsavedActive={unsavedActive}
            onSaveClick={onSaveUnsaved}
            onIgnore={onIgnoreUnsaved}
          />
        )}
        {accounts.map((acc) => (
          <CodexAccountCard
            key={acc.name}
            account={acc}
            isActive={acc.name === activeName && !hasUnsavedActive}
            isSwitching={switchingTo === acc.name}
            dim={Boolean(switchingTo) && switchingTo !== acc.name}
            onSwitch={onSwitch}
            onRename={onRename}
            onDelete={onDelete}
            onReLogin={onReLogin}
          />
        ))}
      </div>
    </>
  )
}

function LoadingSkeleton() {
  return (
    <div className="codex-account-grid">
      {[1, 2, 3].map((i) => (
        <div key={i} className="codex-card" style={{ minHeight: 180 }}>
          <div style={{
            width: '60%', height: 16, background: '#eef0f4',
            borderRadius: 4, marginBottom: 8,
          }} />
          <div style={{
            width: '80%', height: 12, background: '#eef0f4', borderRadius: 4,
          }} />
        </div>
      ))}
    </div>
  )
}

function KeyringGate({ onRetry }) {
  return (
    <div className="codex-empty-state">
      <div className="codex-empty-state__icon codex-empty-state__icon--danger">⚠️</div>
      <div className="codex-empty-state__title">CodePal 目前不支持 Keyring 存储模式</div>
      <div className="codex-empty-state__desc">
        检测到你的 Codex 把登录凭证存在 macOS Keychain 里，而不是 auth.json 文件。
        CodePal 只能通过文件级切换来工作。请按以下步骤迁移：
        <ol>
          <li>打开 <code>~/.codex/config.toml</code></li>
          <li>找到 <code>cli_auth_credentials_store</code>，改为 <code>"file"</code></li>
          <li>退出并重新打开 Codex，重新登录</li>
          <li>回到这里点下面按钮重新检测</li>
        </ol>
      </div>
      <div className="codex-empty-state__actions">
        <Button variant="primary" onClick={onRetry}>重新检测</Button>
      </div>
      <div className="codex-empty-state__hint">Codex 设置：~/.codex/config.toml</div>
    </div>
  )
}

function EmptyNoAuthState({ onRetry }) {
  return (
    <div className="codex-empty-state">
      <div className="codex-empty-state__icon codex-empty-state__icon--warning">🔑</div>
      <div className="codex-empty-state__title">未检测到 Codex 登录</div>
      <div className="codex-empty-state__desc">
        请先打开 Codex 桌面应用，用你的 ChatGPT 账户登录一次。<br />
        登录完成后回到这里点下面按钮重新检测，之后会自动弹出"保存账户"提示。
      </div>
      <div className="codex-empty-state__actions">
        <Button variant="primary" onClick={onRetry}>我已登录，重新检测</Button>
      </div>
      <div className="codex-empty-state__hint">期望路径：~/.codex/auth.json</div>
    </div>
  )
}

function ErrorState({ error, onRetry }) {
  return (
    <div className="codex-empty-state">
      <div className="codex-empty-state__icon codex-empty-state__icon--danger">⚠️</div>
      <div className="codex-empty-state__title">加载失败</div>
      <div className="codex-empty-state__desc">{String(error)}</div>
      <div className="codex-empty-state__actions">
        <Button variant="primary" onClick={onRetry}>重试</Button>
      </div>
    </div>
  )
}

function mapSwitchError(code, hint) {
  // V1.6.2: 对新增的两类错误给精准提示
  switch (code) {
    case 'ACCOUNT_NOT_FOUND':
      return '账户不存在（可能刚被删除）'
    case 'INVALID_NAME':
      return '账户名不合法'
    case 'SYNC_BEFORE_SWITCH_FAILED':
      return hint || '保存当前账户凭证失败，切换已取消（避免 token 丢失）'
    case 'TARGET_NEEDS_RELOGIN':
      return hint || '目标账户授权已过期，请重新登录此账户'
    case 'CODEX_PROCESS_CHECK_FAILED':
      return hint || '检测 Codex 进程失败，切换已取消'
    case 'CODEX_QUIT_FAILED':
      return hint || 'Codex 未完整退出，切换已取消（避免旧账号覆盖新凭证）'
    default:
      return code ? `切换失败：${String(code).slice(0, 80)}` : '切换失败'
  }
}

function emailToSuggestedName(email, accounts) {
  if (!email || typeof email !== 'string') return 'account-1'
  const at = email.indexOf('@')
  const local = at > 0 ? email.slice(0, at) : email
  let base = local.toLowerCase().replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60) || 'account'
  const existing = new Set((accounts || []).map((a) => a.name))
  if (!existing.has(base)) return base
  for (let i = 2; i < 100; i++) {
    const cand = `${base}-${i}`
    if (!existing.has(cand)) return cand
  }
  return `${base}-${Date.now()}`
}
