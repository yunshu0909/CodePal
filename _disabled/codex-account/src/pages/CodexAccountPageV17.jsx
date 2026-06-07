/**
 * Codex 账户页 — V1.7
 *
 * 与 V1.5/V1.6 CodexAccountPage 的差异：
 * - 数据走 useCodexAccountsV17（accounts/{name}/.codex/auth.json 独立 + active.json 指针）
 * - 三档状态徽章（近期验证/未近期验证/已确认失效）
 * - 切换 = 改指针不重启 Codex.app（V1.7 服务边界：仅 CodePal 启动的 codex 受管）
 * - 新账号闭环：anon-<ts> → spawn codex login → 监听 → 弹层取名 → atomic rename
 * - 顶部展示首次升级进度屏 / cloud sync 警告
 *
 * @module pages/CodexAccountPageV17
 */

import React, { useCallback, useState } from 'react'
import PageShell from '../components/PageShell'
import Button from '../components/Button/Button'
import Toast from '../components/Toast'
import CodexAccountCardV17 from './codex-account/CodexAccountCardV17'
import CodexRenameModal from './codex-account/CodexRenameModal'
import CodexDeleteModal from './codex-account/CodexDeleteModal'
import CodexMigrationProgressV17 from './codex-account/CodexMigrationProgressV17'
import CodexLoginCaptureModalV17 from './codex-account/CodexLoginCaptureModalV17'
import { useCodexAccountsV17 } from './codex-account/useCodexAccountsV17'
import './codex-account/codex-account.css'

export default function CodexAccountPageV17() {
  const [toast, setToast] = useState(null)
  const [switchingTo, setSwitchingTo] = useState('')
  const [renamingName, setRenamingName] = useState(null)
  const [deletingName, setDeletingName] = useState(null)
  const [loginOpen, setLoginOpen] = useState(false)

  const {
    loading,
    error,
    accounts,
    activeName,
    bootstrap,
    cloudSyncWarning,
    migration,
    switchAccount,
    forceRefresh,
    renameAccount,
    deleteAccount,
    openCodex,
    beginLogin,
    finalizeLogin,
    cancelLogin,
  } = useCodexAccountsV17()

  // ---------- 操作 handlers ----------

  const handleSwitch = useCallback(async (targetName) => {
    setSwitchingTo(targetName)
    setToast({ message: `正在切换到 ${targetName} 并重启 Codex…`, type: 'info' })
    const r = await switchAccount(targetName)
    setSwitchingTo('')
    if (r?.ok) {
      // V1.7.1.2 P0-1：farmDesynced 警告
      if (r.farmDesynced) {
        setToast({
          message: `已切换到 ${targetName}，但同步到终端 codex 失败（${r.farmError || ''}）。请重启 CodePal 后重试。`,
          type: 'warning',
        })
      } else if (r.noop) {
        setToast({ message: '已经是当前账号', type: 'success' })
      } else if (r.codexRestarted) {
        // V1.7.1.3：切换 + Codex.app 重启都成功
        setToast({ message: `已切换到 ${targetName}，Codex 已自动重启`, type: 'success' })
      } else if (r.codexRestartError) {
        setToast({
          message: `已切换到 ${targetName}，但 Codex 重启失败（${r.codexRestartError}），请手动重启 Codex`,
          type: 'warning',
        })
      } else {
        // Codex 没在跑：纯切换成功
        setToast({ message: `已切换到 ${targetName}`, type: 'success' })
      }
    } else if (r?.classification === 'Permanent') {
      setToast({ message: `账户 ${targetName} 已失效（${r.reason || ''}），请重新登录`, type: 'error' })
    } else if (r?.classification === 'Transient') {
      setToast({ message: `网络异常无法验证 ${targetName}，请稍后重试`, type: 'warning' })
    } else {
      setToast({ message: `切换失败：${r?.code || 'UNKNOWN'}`, type: 'error' })
    }
  }, [switchAccount])

  const handleRefresh = useCallback(async (name) => {
    setToast({ message: `正在验证 ${name}…`, type: 'info' })
    const r = await forceRefresh(name)
    if (r?.ok) {
      setToast({ message: `${name} 验证成功`, type: 'success' })
    } else if (r?.classification === 'Permanent') {
      setToast({ message: `${name} 已失效（${r.reason || ''}）`, type: 'error' })
    } else {
      setToast({ message: `${name} 验证失败：${r?.reason || ''}`, type: 'warning' })
    }
  }, [forceRefresh])

  const handleConfirmRename = useCallback(async (newName) => {
    const oldName = renamingName
    setRenamingName(null)
    const r = await renameAccount(oldName, newName)
    setToast(r?.ok
      ? { message: `已重命名为 ${newName}`, type: 'success' }
      : { message: `重命名失败：${r?.code || ''}`, type: 'error' })
  }, [renamingName, renameAccount])

  const handleConfirmDelete = useCallback(async () => {
    const name = deletingName
    setDeletingName(null)
    const r = await deleteAccount(name)
    setToast(r?.ok
      ? { message: `已删除 ${name}（90 天内可在 .codex-switcher.deleted-backup-* 恢复）`, type: 'success' }
      : { message: `删除失败：${r?.code || ''}`, type: 'error' })
  }, [deletingName, deleteAccount])

  const handleAddAccount = useCallback(() => {
    setLoginOpen(true)
  }, [])

  const handleOpenCodex = useCallback(async () => {
    const r = await openCodex()
    if (!r?.ok) {
      let msg = '启动 Codex 失败'
      if (r?.code === 'NO_ACTIVE_ACCOUNT_CONFIGURED') msg = '请先在 CodePal 内激活一个账号'
      else if (r?.code === 'ACTIVE_ACCOUNT_CLEARED') msg = '当前未选定账号，请激活一个账号后再启动'
      else if (r?.code === 'ACTIVE_ACCOUNT_DIR_CORRUPT') msg = '当前激活账号数据损坏，请切换到其他账号或重新登录'
      setToast({ message: msg, type: 'error' })
    }
  }, [openCodex])

  // ---------- 渲染 ----------

  const migrationPhase = migration?.type
  const showMigrationModal = !!migrationPhase

  return (
    <PageShell
      title="Codex 账户"
      subtitle="账号隔离 · 工作环境共享（V1.7）"
      actions={(
        <>
          <Button variant="secondary" size="sm" onClick={handleOpenCodex} disabled={!activeName}>
            启动 Codex
          </Button>
          <Button variant="primary" size="sm" onClick={handleAddAccount}>
            新增账号
          </Button>
        </>
      )}
    >
      {cloudSyncWarning && (
        <div className="codex-cloud-warning">
          <strong>⚠ 检测到云盘同步路径（{cloudSyncWarning.vendor}）。</strong>
          强烈建议把 ~/.codex-switcher/ 移出云盘——多机同步会触发 refresh_token_reused 导致账号被服务端拉黑。
          后台保活已暂时禁用，仅切换时按需验证。
        </div>
      )}

      {loading && <div className="codex-loading">加载中…</div>}
      {error && <div className="codex-error">加载失败：{error}</div>}

      {!loading && !error && accounts.length === 0 && (
        <div className="codex-empty">
          <p>还没有保存的 Codex 账号。</p>
          <Button variant="primary" onClick={handleAddAccount}>新增第一个账号</Button>
        </div>
      )}

      {!loading && !error && accounts.length > 0 && (
        <div className="codex-card-grid">
          {accounts.map((acc) => (
            <CodexAccountCardV17
              key={acc.name}
              account={acc}
              isSwitching={switchingTo === acc.name}
              onSwitch={handleSwitch}
              onRefresh={handleRefresh}
              onRename={(n) => setRenamingName(n)}
              onDelete={(n) => setDeletingName(n)}
              onReloginPrompt={() => setLoginOpen(true)}
            />
          ))}
        </div>
      )}

      <CodexMigrationProgressV17
        open={showMigrationModal}
        phase={migrationPhase}
        migrationResult={migration?.result}
        onClose={() => { /* migration state 由 hook 维护，关闭只关 modal，下次 reload 会拉新 */ }}
      />

      <CodexLoginCaptureModalV17
        open={loginOpen}
        existingNames={accounts.map((a) => a.name)}
        onBegin={async () => beginLogin()}
        onFinalize={async (name) => finalizeLogin(name)}
        onCancel={async () => cancelLogin()}
        onClose={() => { setLoginOpen(false) }}
      />

      {renamingName && (
        <CodexRenameModal
          open={true}
          oldName={renamingName}
          onConfirm={handleConfirmRename}
          onClose={() => setRenamingName(null)}
        />
      )}

      {deletingName && (
        <CodexDeleteModal
          open={true}
          name={deletingName}
          onConfirm={handleConfirmDelete}
          onClose={() => setDeletingName(null)}
        />
      )}

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
