/**
 * Claude Code 会员额度状态页面
 *
 * 负责：
 * - 作为 Claude Code 专属能力的独立页面入口
 * - 展示 Claude Code 会员额度接入状态与最近一次快照
 * - v1.4.1：显示设置从独立卡片迁移至弹窗（齿轮按钮触发）
 * - 保存配置后 Toast 提示成功/失败
 *
 * @module pages/ClaudeUsageStatusPage
 */

import { useCallback, useState } from 'react'
import PageShell from '../components/PageShell'
import Button from '../components/Button/Button'
import Toast from '../components/Toast'
import DualUsageCard from './usage/components/DualUsageCard'
import ClaudeUsageSettingsModal from './usage/components/ClaudeUsageSettingsModal'
import useClaudeUsageStatus from './usage/useClaudeUsageStatus'
import useCodexUsageStatus from './usage/useCodexUsageStatus'
import './usage.css'

/**
 * 齿轮按钮 disabled 的集成状态
 * 这些状态下用户还没完成接入，或接入失败，不应该允许打开设置弹窗
 */
const SETTINGS_DISABLED_STATES = new Set([
  'not_installed',
  'not_configured',
  'conflict',
  'setup_failed',
])

/**
 * Claude Code 会员额度状态页面
 * @param {object} props - 独立设置入口只覆盖页面标题，沿用原有行为
 * @param {string} [props.title] - 页面标题
 * @returns {JSX.Element}
 */
export default function ClaudeUsageStatusPage({
  title = '会员额度',
}) {
  const {
    statusState,
    loading,
    installing,
    saving,
    error,
    loadStatus,
    ensureInstalled,
    saveConfig,
  } = useClaudeUsageStatus()

  // Codex 额度（独立 hook，只读 ~/.codex/sessions 日志，零接入）
  const {
    statusState: codexState,
    loading: codexLoading,
    error: codexError,
    loadStatus: loadCodexStatus,
  } = useCodexUsageStatus()

  // Toast 提示状态
  const [toast, setToast] = useState(null)
  // 显示设置弹窗开关
  const [settingsOpen, setSettingsOpen] = useState(false)

  /** 同时刷新 Claude 与 Codex 当前额度快照。 */
  const handleRefresh = useCallback(() => {
    loadStatus()
    loadCodexStatus()
  }, [loadStatus, loadCodexStatus])

  /**
   * 保存配置 — 接收弹窗传来的 draft 并保存，成功弹 Toast
   * @param {object} draft - 弹窗里的本地 draft 配置
   * @returns {Promise<boolean>} 供弹窗判断是否关闭自己
   */
  const handleSave = useCallback(async (draft) => {
    const ok = await saveConfig(draft)
    setToast(ok
      ? { message: '显示设置已保存', type: 'success' }
      : { message: '保存失败，请重试', type: 'error' })
    return ok
  }, [saveConfig])

  /**
   * Claude statusLine 接入/接管
   * 自定义 statusLine 的 force=true 只会由二次确认弹窗触发。
   */
  const handleEnsureInstalled = useCallback(async (options = {}) => {
    // 用户显式接入/接管：允许在 settings.json 不存在时创建
    const ok = await ensureInstalled({ ...options, intent: 'explicit' })
    if (options.force) {
      setToast(ok
        ? { message: 'Claude statusLine 已由 CodePal 接管', type: 'success' }
        : { message: '接管失败，请检查配置权限后重试', type: 'error' })
    }
    return ok
  }, [ensureInstalled])

  const integrationState = statusState?.integrationState
  const settingsDisabled = !statusState || SETTINGS_DISABLED_STATES.has(integrationState)

  // 页面标题右侧的"显示设置"按钮
  const headerActions = (
    <Button
      variant="secondary"
      size="sm"
      onClick={() => setSettingsOpen(true)}
      disabled={settingsDisabled}
      title={settingsDisabled ? '需要先完成 Claude Code 会员额度接入' : '打开实时额度显示设置'}
    >
      <span aria-hidden="true" style={{ marginRight: 4 }}>⚙</span>
      显示设置
    </Button>
  )

  return (
    <PageShell
      title={title}
      subtitle="从 Claude Code statusLine 与 Codex 本地会话日志读取会员额度。"
      actions={headerActions}
    >
      {/* 卡片 1：会员额度双栏对比（Claude / Codex 5h+7d 当前额度） */}
      <DualUsageCard
        claude={{
          statusState,
          loading,
          installing,
          error,
          onRefresh: handleRefresh,
          onEnsureInstalled: handleEnsureInstalled,
        }}
        codex={{
          statusState: codexState,
          loading: codexLoading,
          error: codexError,
          onRefresh: loadCodexStatus,
        }}
        onRefresh={handleRefresh}
      />

      {/* 显示设置弹窗 */}
      <ClaudeUsageSettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        initialConfig={statusState?.config}
        onSave={handleSave}
        saving={saving}
      />

      {/* Toast */}
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
