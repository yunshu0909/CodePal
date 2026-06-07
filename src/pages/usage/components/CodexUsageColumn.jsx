/**
 * Codex 会员额度单栏
 *
 * 负责：
 * - Codex 侧 4 态渲染（ready / no_data / no_rate_limits / read_error）+ stale 派生
 * - Codex 零接入：无安装/配置流程，空态按钮只有「刷新」
 *
 * @module pages/usage/components/CodexUsageColumn
 */

import { BrandHead, UsageRows, ColumnEmpty, ColumnFoot, formatUpdatedAt, STALE_MS } from './usageColumnKit'

/**
 * 派生 Codex 渲染态
 * @param {object|null} statusState - 后端返回状态
 * @param {string|null} error - 前端错误
 * @returns {string}
 */
function deriveCodexRenderState(statusState, error) {
  if (error && !statusState) return 'read_error'
  if (!statusState) return 'read_error'

  const integration = statusState.integrationState || 'read_error'
  if (integration === 'ready') {
    const updatedAt = statusState.snapshot?.updatedAt
    if (updatedAt && (Date.now() - Number(updatedAt) * 1000) > STALE_MS) return 'stale'
    return 'ready'
  }
  // no_data / no_rate_limits / read_error 原样透传
  return integration
}

/**
 * 渲染态 → 徽章
 * @param {string} renderState
 * @returns {{variant: string, label: string}}
 */
function getBadge(renderState) {
  switch (renderState) {
    case 'ready': return { variant: 'ready', label: '已接入' }
    case 'stale': return { variant: 'waiting', label: '数据过期' }
    case 'no_data': return { variant: 'absent', label: '未检测到' }
    case 'no_rate_limits': return { variant: 'waiting', label: '无额度数据' }
    case 'read_error': return { variant: 'danger', label: '读取异常' }
    default: return { variant: 'absent', label: '未知状态' }
  }
}

/**
 * Codex 会员额度单栏
 * @param {object} props
 * @param {object|null} props.statusState - 后端状态
 * @param {boolean} props.loading - 加载中
 * @param {string|null} props.error - 错误信息
 * @param {() => void} props.onRefresh - 刷新本栏
 * @returns {JSX.Element}
 */
export default function CodexUsageColumn({ statusState, loading, error, onRefresh }) {
  const renderState = deriveCodexRenderState(statusState, error)
  const badge = getBadge(renderState)
  const snapshot = statusState?.snapshot || null
  const updatedAtLabel = formatUpdatedAt(snapshot?.updatedAt)
  const isData = renderState === 'ready' || renderState === 'stale'

  return (
    <div className={`usage-col${renderState === 'stale' ? ' usage-col--stale' : ''}`}>
      <BrandHead brand="codex" mark="Cx" name="Codex" badge={badge} />

      {renderState === 'stale' && (
        <div className="usage-col__stale-note">
          ⚠ 数据可能已过期 — 最后同步于 {updatedAtLabel}，用一次 Codex 即自动刷新。
        </div>
      )}

      {isData && <UsageRows snapshot={snapshot} />}
      {isData && <ColumnFoot updatedAtLabel={updatedAtLabel} />}

      {renderState === 'no_data' && (
        <ColumnEmpty
          icon="○"
          title="未检测到 Codex 使用记录"
          desc={<>近期没有可读的 Codex 额度数据。用一次 Codex CLI 后回来刷新，这里会显示它的 5h / 7d 额度。</>}
          primaryLabel={loading ? '刷新中...' : '刷新状态'}
          primaryLoading={loading}
          onPrimary={onRefresh}
        />
      )}

      {renderState === 'no_rate_limits' && (
        <ColumnEmpty
          icon="ⓘ"
          iconVariant="warning"
          title="Codex 未返回额度数据"
          desc={
            <>
              检测到 Codex 使用记录，但日志里没有额度字段。常见原因：使用 API key 模式，
              或不是 ChatGPT 订阅账号（只有订阅用户才有 5h / 7d 额度）。
            </>
          }
          primaryLabel={loading ? '刷新中...' : '刷新状态'}
          primaryLoading={loading}
          onPrimary={onRefresh}
        />
      )}

      {renderState === 'read_error' && (
        <ColumnEmpty
          icon="✕"
          iconVariant="danger"
          title="无法读取 Codex 额度"
          desc="读取 Codex 日志时出错，可能是文件损坏或权限不足。"
          primaryLabel={loading ? '重试中...' : '重试'}
          primaryLoading={loading}
          onPrimary={onRefresh}
          hint={error ? `错误详情:${error}` : undefined}
        />
      )}
    </div>
  )
}
