/**
 * Claude 会员额度单栏
 *
 * 负责：
 * - Claude 侧完整 10 态渲染（含 statusLine 接入流程：未接入/冲突/接入失败等）
 * - 复用 usageColumnKit 的展示原子，保证与 Codex 栏视觉完全一致
 *
 * 态逻辑沿用原 ClaudeUsageStatusCard（去掉外层卡壳，改为栏内紧凑空态）。
 *
 * @module pages/usage/components/ClaudeUsageColumn
 */

import { useState } from 'react'
import ClaudeStatusLineTakeoverModal from './ClaudeStatusLineTakeoverModal'
import { BrandHead, SourceMeta, UsageRows, ColumnEmpty, ColumnFoot, formatUpdatedAt, STALE_MS, useStaleDeadline } from './usageColumnKit'

/**
 * 派生 Claude 渲染态（沿用原 ClaudeUsageStatusCard.deriveRenderState）
 * @param {object|null} statusState - 后端状态
 * @param {string|null} error - 前端错误
 * @returns {string}
 */
function deriveRenderState(statusState, error) {
  if (error && !statusState) return 'read_error'
  if (!statusState) return 'read_error'

  const integration = statusState.integrationState || 'not_configured'
  const snapshot = statusState.snapshot
  const config = statusState.config

  if (integration === 'waiting_for_data') {
    if (snapshot?.updatedAt) return 'no_rate_limits'
    return 'waiting_first_data'
  }

  if (integration === 'ready') {
    if (config?.displayMode === 'off') return 'off_with_data'
    if (snapshot?.updatedAt && (Date.now() - Number(snapshot.updatedAt) * 1000) > STALE_MS) {
      return 'stale'
    }
  }

  return integration
}

/**
 * 渲染态 → 徽章
 * @param {string} renderState
 * @returns {{variant: string, label: string}}
 */
function getBadge(renderState) {
  switch (renderState) {
    case 'ready':
    case 'off_with_data': return { variant: 'ready', label: '已接入' }
    case 'stale': return { variant: 'waiting', label: '2 小时未更新' }
    case 'waiting_first_data': return { variant: 'waiting', label: '等待数据' }
    case 'no_rate_limits': return { variant: 'waiting', label: '无额度数据' }
    case 'conflict': return { variant: 'danger', label: '检测到自定义配置' }
    case 'not_configured': return { variant: 'waiting', label: '尚未接入' }
    case 'not_installed': return { variant: 'absent', label: '未安装 Claude Code' }
    case 'setup_failed': return { variant: 'danger', label: '接入失败' }
    case 'read_error': return { variant: 'danger', label: '读取异常' }
    default: return { variant: 'absent', label: '未知状态' }
  }
}

/**
 * Claude 会员额度单栏
 * @param {object} props
 * @param {object|null} props.statusState - 后端状态
 * @param {boolean} props.loading - 加载中
 * @param {boolean} props.installing - 安装/修复中
 * @param {string|null} props.error - 错误信息
 * @param {() => void} props.onRefresh - 刷新本栏
 * @param {(options?: {force?: boolean}) => void} props.onEnsureInstalled - 安装/修复
 * @returns {JSX.Element}
 */
export default function ClaudeUsageColumn({ statusState, loading, installing, error, onRefresh, onEnsureInstalled }) {
  const [takeoverOpen, setTakeoverOpen] = useState(false)
  useStaleDeadline(statusState?.snapshot?.updatedAt)
  const renderState = deriveRenderState(statusState, error)
  // 托管事实与提交状态都由服务层随状态返回，UI 必须消费，否则会谎报"已接入/已切换"
  const managedNotice = statusState?.managedNotice || null
  const badge = getBadge(renderState)
  const snapshot = statusState?.snapshot || null
  const updatedAtLabel = formatUpdatedAt(snapshot?.updatedAt)
  const isData = renderState === 'ready' || renderState === 'off_with_data' || renderState === 'stale'

  return (
    <div className={`usage-col${renderState === 'stale' ? ' usage-col--stale' : ''}`}>
      <BrandHead brand="claude" mark="C" name="Claude Code" badge={badge} />
      <SourceMeta
        source="statusLine rate_limits 快照"
        update="运行 Claude Code 对话时"
      />

      {renderState === 'off_with_data' && (
        <div className="usage-col__hint">⏸ 状态栏显示已关闭 · 本页数据照常实时同步</div>
      )}

      {renderState === 'stale' && (
        <div className="usage-col__stale-note">
          ⚠ 最近 2 小时没有观察到新额度数据。最后观察于 {updatedAtLabel}；当前数值可能仍有效，打开 Claude Code 对话后可更新。
        </div>
      )}

      {isData && <UsageRows snapshot={snapshot} />}
      {isData && <ColumnFoot updatedAtLabel={updatedAtLabel} />}

      {renderState === 'waiting_first_data' && (
        <ColumnEmpty
          icon="⏳"
          iconVariant="warning"
          title="等待首个额度快照"
          desc={managedNotice
            ? <>{managedNotice}</>
            : <>状态栏已接入，但 Claude Code 还没发送 rate_limits。打开一次对话，额度会自动出现。</>}
          primaryLabel={loading ? '刷新中...' : '刷新状态'}
          primaryLoading={loading}
          onPrimary={onRefresh}
        />
      )}

      {renderState === 'no_rate_limits' && (
        <ColumnEmpty
          icon="ⓘ"
          iconVariant="warning"
          title="当前账号没有额度数据"
          desc={<>脚本已运行但账号没返回 rate_limits。常见原因：</>}
          reasons={
            <>
              <span>① 不是 Claude Max 订阅（只有 Max 才有 5h/7d 额度）</span>
              <span>② 或 Claude Code 指向第三方 API（Kimi 等），不实现该字段</span>
            </>
          }
          primaryLabel={loading ? '刷新中...' : '刷新状态'}
          primaryLoading={loading}
          onPrimary={onRefresh}
          hint={`最后同步 ${updatedAtLabel}`}
        />
      )}

      {renderState === 'not_configured' && (
        <ColumnEmpty
          icon="⚡"
          iconVariant="primary"
          title="一键接入会员额度"
          desc={<>点击后 CodePal 才会配置 Claude Code 状态栏脚本，不会因打开本页自动写入 settings.json。</>}
          primaryLabel={installing ? '处理中...' : '立即接入'}
          primaryLoading={installing}
          onPrimary={() => onEnsureInstalled?.({ force: false })}
        />
      )}

      {renderState === 'conflict' && (
        <ColumnEmpty
          icon="⚠"
          iconVariant="warning"
          title="检测到已有自定义 statusLine"
          desc={<>CodePal 不会自动覆盖你的状态栏脚本。查看接管说明并再次确认后，才会备份并替换配置。</>}
          primaryLabel="查看接管说明"
          primaryLoading={installing}
          onPrimary={() => setTakeoverOpen(true)}
        />
      )}

      {renderState === 'not_installed' && (
        <ColumnEmpty
          icon="○"
          title="本机未安装 Claude Code"
          desc={<>安装 Claude Code CLI 后回来刷新，再由你确认是否接入会员额度。</>}
          primaryLabel={loading ? '刷新中...' : '刷新状态'}
          primaryLoading={loading}
          onPrimary={onRefresh}
        />
      )}

      {renderState === 'setup_failed' && (
        <ColumnEmpty
          icon="✕"
          iconVariant="danger"
          title={statusState?.committed ? '配置已写入但未通过校验' : '无法写入 Claude 配置'}
          desc={statusState?.committed
            ? <>文件已经被改动，但回读校验或持久化未达成{statusState?.durability === 'unsynced' ? '（目录项未持久化）' : ''}。请检查 settings.json 内容后重试。</>
            : <>写入 ~/.claude/settings.json 失败，通常是权限不足或文件被占用。</>}
          primaryLabel={installing ? '处理中...' : '重试接入'}
          primaryLoading={installing}
          onPrimary={() => onEnsureInstalled?.({ force: false })}
          hint={error ? `错误详情:${error}` : undefined}
        />
      )}

      {renderState === 'read_error' && (
        <ColumnEmpty
          icon="✕"
          iconVariant="danger"
          title="无法读取额度状态"
          desc="读取 Claude 会员额度时出错。可能是快照损坏、权限不足或主进程通信异常。"
          primaryLabel={loading ? '重试中...' : '重试'}
          primaryLoading={loading}
          onPrimary={onRefresh}
          hint={error ? `错误详情:${error}` : undefined}
        />
      )}

      <ClaudeStatusLineTakeoverModal
        open={takeoverOpen}
        loading={installing}
        onClose={() => setTakeoverOpen(false)}
        onConfirm={() => onEnsureInstalled?.({ force: true })}
      />
    </div>
  )
}
