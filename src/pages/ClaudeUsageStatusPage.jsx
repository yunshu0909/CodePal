/**
 * Claude Code 会员额度状态页面
 *
 * 负责：
 * - 作为 Claude Code 专属能力的独立页面入口
 * - 展示 Claude Code 会员额度接入状态与最近一次快照
 * - v1.4.1：新增满载率趋势卡，展示最近 4 个已完成 7d 周期的峰值与平均值
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
import DualTrendCard from './usage/components/DualTrendCard'
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

const ONE_WEEK_SECONDS = 7 * 86400

/**
 * 从 Claude 快照构造「本周进行中」窗口（满载率趋势用）
 * @param {object|null} snapshot - Claude 额度快照
 * @returns {{periodStart: number, periodEnd: number, peakPercentage: number}|null}
 */
function buildClaudeCurrentCycle(snapshot) {
  const resetsAt = Number(snapshot?.sevenDayResetsAt)
  if (!Number.isFinite(resetsAt)) return null
  return {
    periodStart: resetsAt - ONE_WEEK_SECONDS,
    periodEnd: resetsAt,
    peakPercentage: snapshot?.sevenDayUsedPercentage,
  }
}

/**
 * Claude Code 会员额度状态页面
 * @returns {JSX.Element}
 */
export default function ClaudeUsageStatusPage() {
  const {
    statusState,
    loading,
    installing,
    saving,
    error,
    history,
    loadStatus,
    loadHistory,
    ensureInstalled,
    saveConfig,
  } = useClaudeUsageStatus()

  // Codex 额度（独立 hook，只读 ~/.codex/sessions 日志，零接入）
  const {
    statusState: codexState,
    loading: codexLoading,
    error: codexError,
    trend: codexTrend,
    loadStatus: loadCodexStatus,
    loadTrend: loadCodexTrend,
  } = useCodexUsageStatus()

  // Toast 提示状态
  const [toast, setToast] = useState(null)
  // 显示设置弹窗开关
  const [settingsOpen, setSettingsOpen] = useState(false)

  /**
   * 刷新：同时刷新状态快照和满载率历史
   */
  const handleRefresh = useCallback(() => {
    loadStatus()
    loadHistory()
    loadCodexStatus()
    loadCodexTrend()
  }, [loadStatus, loadHistory, loadCodexStatus, loadCodexTrend])

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

  const claudeCurrentCycle = buildClaudeCurrentCycle(statusState?.snapshot)
  const claudeHasTrend = statusState?.integrationState === 'ready' && Boolean(statusState?.snapshot?.hasRateLimits)
  const codexHasTrend = Boolean(codexTrend?.currentCycle) || (codexTrend?.completedCycles?.length > 0)
  const trendVisible = claudeHasTrend || codexHasTrend
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
      title="会员额度"
      subtitle="对比 Claude Code 与 Codex 的官方 rate_limits 与满载率趋势。"
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
          onEnsureInstalled: ensureInstalled,
        }}
        codex={{
          statusState: codexState,
          loading: codexLoading,
          error: codexError,
          onRefresh: loadCodexStatus,
        }}
        onRefresh={handleRefresh}
      />

      {/* 卡片 2：满载率趋势双栏对比（Claude 固定 7 天周期 / Codex 自然周峰值） */}
      {trendVisible && (
        <DualTrendCard
          claude={{
            currentCycle: claudeCurrentCycle,
            completedCycles: history.completedCycles,
            avgCaption: '近 4 个 7 天周期峰值平均',
          }}
          codex={{
            currentCycle: codexTrend.currentCycle,
            completedCycles: codexTrend.completedCycles,
            avgCaption: '近 4 个自然周峰值平均',
          }}
        />
      )}

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
