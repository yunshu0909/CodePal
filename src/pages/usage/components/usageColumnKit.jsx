/**
 * 会员额度「单栏」共享展示套件
 *
 * 负责：
 * - 两栏对比卡（Claude / Codex）共用的纯展示原子，保证两栏视觉完全一致
 * - 进度条（UsageRow）+ 颜色断点（60/85，与状态栏脚本对齐）+ 时间格式化
 * - 栏头品牌块（BrandHead）+ 紧凑空态（ColumnEmpty）
 *
 * 不含任何 Claude/Codex 各自的状态机逻辑——那些在 ClaudeUsageColumn / CodexUsageColumn。
 *
 * @module pages/usage/components/usageColumnKit
 */

import Button from '../../../components/Button/Button'

// 快照过期阈值：与 Claude 卡严格一致（2 小时）。没用工具时数据本就不会变，2h 是合理的"有点旧了"信号。
export const STALE_MS = 2 * 60 * 60 * 1000

// 颜色断点与 claudeUsageStatusService.js 的 color_pct 严格对齐：<60 绿 / 60-85 黄 / ≥85 红
const PCT_WARNING_THRESHOLD = 60
const PCT_DANGER_THRESHOLD = 85

/**
 * 已用百分比 → 色阶后缀
 * @param {number|null|undefined} value - 已用百分比
 * @returns {'success'|'warning'|'danger'|'dim'}
 */
export function pctColorClass(value) {
  const num = Number(value)
  if (!Number.isFinite(num)) return 'dim'
  if (num < PCT_WARNING_THRESHOLD) return 'success'
  if (num < PCT_DANGER_THRESHOLD) return 'warning'
  return 'danger'
}

/**
 * 格式化重置时间
 * @param {number|string|null|undefined} unixSeconds - Unix 秒
 * @returns {{remaining: string, absolute: string}}
 */
export function formatResetTime(unixSeconds) {
  if (!unixSeconds) return { remaining: '--', absolute: '' }
  const date = new Date(Number(unixSeconds) * 1000)
  if (Number.isNaN(date.getTime())) return { remaining: '--', absolute: '' }

  const diffMs = Math.max(0, date.getTime() - Date.now())
  const totalMinutes = Math.floor(diffMs / 60000)
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60

  let remaining
  if (days > 0) {
    remaining = `${days} 天 ${hours}h`
  } else if (hours > 0) {
    remaining = `${hours}h ${String(minutes).padStart(2, '0')}m`
  } else {
    remaining = `${minutes}m`
  }

  const absolute = days > 0
    ? date.toLocaleString('zh-CN', { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
    : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })

  return { remaining, absolute }
}

/**
 * 格式化快照更新时间
 * @param {number|string|null|undefined} unixSeconds - Unix 秒
 * @returns {string}
 */
export function formatUpdatedAt(unixSeconds) {
  if (!unixSeconds) return '尚未同步'
  const date = new Date(Number(unixSeconds) * 1000)
  if (Number.isNaN(date.getTime())) return '尚未同步'
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
}

/**
 * 栏头：品牌色块 + 工具名 + 状态徽章
 * @param {object} props
 * @param {'claude'|'codex'} props.brand - 品牌（决定方块色）
 * @param {string} props.mark - 方块内字母标记（C / Cx）
 * @param {string} props.name - 工具显示名
 * @param {{variant: string, label: string}} props.badge - 徽章
 * @returns {JSX.Element}
 */
export function BrandHead({ brand, mark, name, badge }) {
  return (
    <div className="usage-col__head">
      <span className={`usage-brand-tile usage-brand-tile--${brand}`}>{mark}</span>
      <span className="usage-col__name">{name}</span>
      <span className="usage-col__spacer" />
      <span className={`usage-badge usage-badge--${badge.variant}`}>{badge.label}</span>
    </div>
  )
}

/**
 * 单条额度行（5h / 7d 水平进度条）
 * @param {object} props
 * @param {string} props.label - 标签
 * @param {number|null|undefined} props.pct - 已用百分比
 * @param {number|null|undefined} props.resetsAt - 重置时间 unix 秒
 * @returns {JSX.Element}
 */
export function UsageRow({ label, pct, resetsAt }) {
  const colorClass = pctColorClass(pct)
  // 用 Number.isFinite 判，0% 是合法值不能漏
  const hasValue = Number.isFinite(Number(pct))
  const width = hasValue ? Math.min(100, Math.max(0, Number(pct))) : 0
  const reset = formatResetTime(resetsAt)

  return (
    <div className="usage-row">
      <div className="usage-row__head">
        <span className="usage-row__label">{label}</span>
        <strong className={`usage-row__pct usage-row__pct--${colorClass}`}>
          {hasValue ? `${Math.round(Number(pct))}%` : '--'}
        </strong>
      </div>
      <div className="usage-row__bar">
        <div
          className={`usage-row__fill usage-row__fill--${hasValue ? colorClass : 'success'}`}
          style={{ width: `${width}%` }}
        />
      </div>
      {hasValue && (
        <div className="usage-row__meta">
          距重置 <strong>{reset.remaining}</strong>
          {reset.absolute && <> · 将于 {reset.absolute} 重置</>}
        </div>
      )}
    </div>
  )
}

/**
 * 两条额度行主体（5h + 7d）
 * @param {object} props
 * @param {object|null} props.snapshot - 归一化快照
 * @returns {JSX.Element}
 */
export function UsageRows({ snapshot }) {
  return (
    <div className="usage-col__rows">
      <UsageRow label="5 小时额度" pct={snapshot?.fiveHourUsedPercentage} resetsAt={snapshot?.resetsAt} />
      <UsageRow label="7 天额度" pct={snapshot?.sevenDayUsedPercentage} resetsAt={snapshot?.sevenDayResetsAt} />
    </div>
  )
}

/**
 * 栏内紧凑空态（比整卡空态小一号）
 * @param {object} props
 * @param {string} props.icon - 图标字符
 * @param {'neutral'|'warning'|'danger'|'primary'} [props.iconVariant] - 图标配色
 * @param {string} props.title - 标题
 * @param {React.ReactNode} [props.desc] - 描述
 * @param {React.ReactNode} [props.reasons] - 原因列表
 * @param {string} [props.primaryLabel] - 主按钮文案
 * @param {() => void} [props.onPrimary] - 主按钮回调
 * @param {boolean} [props.primaryLoading] - 主按钮 loading
 * @param {React.ReactNode} [props.hint] - 底部提示
 * @returns {JSX.Element}
 */
export function ColumnEmpty({
  icon,
  iconVariant = 'neutral',
  title,
  desc,
  reasons,
  primaryLabel,
  onPrimary,
  primaryLoading = false,
  hint,
}) {
  return (
    <div className="usage-col-empty">
      <div className={`usage-col-empty__icon usage-col-empty__icon--${iconVariant}`}>{icon}</div>
      <div className="usage-col-empty__title">{title}</div>
      {desc && <div className="usage-col-empty__desc">{desc}</div>}
      {reasons && <div className="usage-col-empty__reasons">{reasons}</div>}
      {primaryLabel && (
        <Button variant="primary" size="sm" onClick={onPrimary} loading={primaryLoading}>
          {primaryLabel}
        </Button>
      )}
      {hint && <div className="usage-col-empty__hint">{hint}</div>}
    </div>
  )
}

/**
 * 栏底「最后同步」meta 行（ready 态用）
 * @param {object} props
 * @param {string} props.updatedAtLabel - 已格式化的同步时间
 * @returns {JSX.Element}
 */
export function ColumnFoot({ updatedAtLabel }) {
  return <div className="usage-col__foot">最后同步 {updatedAtLabel}</div>
}
