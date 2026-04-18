/**
 * Claude 会员额度满载率趋势卡 (v1.4.4)
 *
 * 负责：
 * - 展示最近 4 个正常已完成 7d 周期的峰值柱状条
 * - 展示本周进行中（不计入满载率）
 * - 计算并显示满载率 = 正常已完成周期峰值的算术平均值
 * - 近 30 天内异常条目（provider_reset 等非自然跳变）独立小节展示，不计入均值
 * - 正常样本为 0 时 header 展示"样本不足"；异常无条目时整个小节不渲染
 *
 * 视觉规则：
 * - 满载率高 = 用得值 = 好事，正常条目统一品牌蓝色 (--color-primary)
 * - 异常条目使用 warning 暖橙 (--color-warning)，明确"非常规"语义
 *
 * @module pages/usage/components/ClaudeUsageTrendCard
 */

import './ClaudeUsageTrendCard.css'
import { classifyHistory, cycleDurationDays } from '../usageHistoryUtils'

/**
 * 格式化 Unix 时间戳为 "M/D" 形式（用于日期范围展示）
 * @param {number|null|undefined} unixSeconds - Unix 秒时间戳
 * @returns {string}
 */
function formatShortDate(unixSeconds) {
  if (!unixSeconds) return '--'
  const date = new Date(Number(unixSeconds) * 1000)
  if (Number.isNaN(date.getTime())) return '--'
  return `${date.getMonth() + 1}/${date.getDate()}`
}

/**
 * 格式化距重置时间（参考 ClaudeUsageStatusCard 的 formatResetTime 但更紧凑）
 * @param {number|null|undefined} unixSeconds
 * @returns {string} 如 "2 天 16h" / "16h 23m" / "23m"
 */
function formatRemaining(unixSeconds) {
  if (!unixSeconds) return ''
  const date = new Date(Number(unixSeconds) * 1000)
  if (Number.isNaN(date.getTime())) return ''
  const diffMs = Math.max(0, date.getTime() - Date.now())
  const totalMinutes = Math.floor(diffMs / 60000)
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return `${days} 天 ${hours}h`
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`
  return `${minutes}m`
}

/**
 * 渲染本周进行中条
 * @param {object} props
 * @param {object|null} props.snapshot - 当前快照（提供当前 7d 百分比和重置时间）
 * @returns {JSX.Element|null}
 */
function CurrentWeekBar({ snapshot }) {
  const pct = snapshot?.sevenDayUsedPercentage
  const resetsAt = snapshot?.sevenDayResetsAt
  const hasValue = Number.isFinite(Number(pct))
  const pctNum = hasValue ? Math.max(0, Math.min(100, Number(pct))) : 0
  const periodStartSec = resetsAt ? Number(resetsAt) - 7 * 86400 : null
  const remaining = formatRemaining(resetsAt)

  return (
    <div className="trend-current-week">
      <div className="trend-current-week__head">
        <span className="trend-current-week__label">
          <span className="trend-current-week__dot" aria-hidden="true" />
          本周进行中
        </span>
        <span className="trend-current-week__pct">
          {hasValue ? `${Math.round(pctNum)}%` : '--'}
        </span>
      </div>
      <div className="trend-current-week__track">
        <div
          className="trend-current-week__fill"
          style={{ width: `${pctNum}%` }}
        />
      </div>
      <div className="trend-current-week__meta">
        <span>
          {periodStartSec ? formatShortDate(periodStartSec) : '--'}
          {' → '}
          {resetsAt ? formatShortDate(resetsAt) : '--'}
          {remaining && <> · 距重置 {remaining}</>}
        </span>
        <span className="trend-current-week__tag">不计入满载率</span>
      </div>
    </div>
  )
}

/**
 * 渲染单个正常已完成周期行
 * @param {object} props
 * @param {object} props.cycle - 周期数据 { periodStart, periodEnd, peakPercentage }
 * @returns {JSX.Element}
 */
function HistoryRow({ cycle }) {
  const peak = Number(cycle?.peakPercentage)
  const pctNum = Number.isFinite(peak) ? Math.max(0, Math.min(100, peak)) : 0
  return (
    <div className="trend-history-row">
      <span className="trend-history-row__date">
        {formatShortDate(cycle?.periodStart)} → {formatShortDate(cycle?.periodEnd)}
      </span>
      <div className="trend-history-row__bar">
        <div
          className="trend-history-row__fill"
          style={{ width: `${pctNum}%` }}
        />
      </div>
      <span className="trend-history-row__pct">
        {Number.isFinite(peak) ? `${Math.round(peak)}%` : '--'}
      </span>
    </div>
  )
}

/**
 * 渲染异常周期行（v1.4.4 新增）
 * @param {object} props
 * @param {object} props.cycle - 周期数据（含 anomaly: true）
 * @returns {JSX.Element}
 */
function AnomalyRow({ cycle }) {
  const peak = Number(cycle?.peakPercentage)
  const pctNum = Number.isFinite(peak) ? Math.max(0, Math.min(100, peak)) : 0
  const days = cycleDurationDays(cycle?.periodStart, cycle?.periodEnd)
  return (
    <div className="trend-history-row trend-history-row--anomaly">
      <div className="trend-history-row__date-group">
        <span className="trend-history-row__date">
          {formatShortDate(cycle?.periodStart)} → {formatShortDate(cycle?.periodEnd)}
        </span>
        <span className="trend-history-row__anomaly-tag">
          Anthropic 重置{days > 0 ? ` · ${days} 天` : ''}
        </span>
      </div>
      <div className="trend-history-row__bar">
        <div
          className="trend-history-row__fill"
          style={{ width: `${pctNum}%` }}
        />
      </div>
      <span className="trend-history-row__pct">
        {Number.isFinite(peak) ? `${Math.round(peak)}%` : '--'}
      </span>
    </div>
  )
}

/**
 * 满载率趋势卡
 * @param {object} props
 * @param {object|null} props.snapshot - 当前额度快照
 * @param {Array} props.completedCycles - 已完成周期（最新在前）
 * @param {boolean} [props.stale] - 是否为快照过期态，用于同步半透明
 * @returns {JSX.Element}
 */
export default function ClaudeUsageTrendCard({ snapshot, completedCycles, stale = false }) {
  const { normalCycles, normalCyclesTotal, recentAnomalies, avgPeak } = classifyHistory(completedCycles)

  const hasNormal = normalCycles.length > 0
  const hasAnomaly = recentAnomalies.length > 0

  // 副标题：优先按正常条目数展示，正常为 0 时退化到引导文案
  let subtitle
  if (normalCycles.length === 0) {
    subtitle = '完整用完 1 个正常 7 天周期后出现趋势'
  } else if (normalCycles.length < 4) {
    subtitle = `基于 ${normalCycles.length} 个已完成的 7 天周期`
  } else {
    subtitle = '基于最近 4 个已完成的 7 天周期'
  }

  const insufficientSample = avgPeak === null

  return (
    <section className={`trend-card${stale ? ' trend-card--stale' : ''}`}>
      <header className="trend-card__header">
        <div className="trend-card__title-group">
          <h2 className="trend-card__title">满载率趋势</h2>
          <div className="trend-card__subtitle">{subtitle}</div>
        </div>
        {insufficientSample ? (
          <div className="trend-card__value trend-card__value--insufficient">
            <span className="trend-card__value-num">样本不足</span>
          </div>
        ) : (
          <div className="trend-card__value">
            <span className="trend-card__value-num">{avgPeak}</span>
            <span className="trend-card__value-unit">%</span>
          </div>
        )}
      </header>

      <div className="trend-card__body">
        <CurrentWeekBar snapshot={snapshot} />

        {hasNormal && (
          <>
            <div className="trend-card__section-label">已完成周期</div>
            <div className="trend-card__history-list">
              {normalCycles.map((cycle, index) => (
                <HistoryRow
                  key={`normal-${cycle?.periodEnd ?? 'cycle'}-${index}`}
                  cycle={cycle}
                />
              ))}
            </div>
          </>
        )}

        {hasAnomaly && (
          <>
            <div className="trend-card__section-label trend-card__section-label--anomaly">
              异常周期 · 近 30 天
            </div>
            <div className="trend-card__anomaly-hint">
              Claude 官方在 7 天窗口内做了 reset，本次周期提前中断。不计入满载率平均。
            </div>
            <div className="trend-card__history-list trend-card__history-list--anomaly">
              {recentAnomalies.map((cycle, index) => (
                <AnomalyRow
                  key={`anomaly-${cycle?.periodEnd ?? 'cycle'}-${index}`}
                  cycle={cycle}
                />
              ))}
            </div>
          </>
        )}

        {!hasNormal && !hasAnomaly && (
          <div className="trend-card__empty-hint">
            完整用完 1 个 7 天周期后，这里会出现你的满载率趋势。
          </div>
        )}
      </div>

      <footer className="trend-card__footer">
        <span>
          {normalCyclesTotal === 0 ? '暂无正常完成周期' : null}
          {normalCyclesTotal > 0 && normalCyclesTotal < 4 && `共 ${normalCyclesTotal} 个正常完成周期 · 数据积累中`}
          {normalCyclesTotal >= 4 && `共 ${normalCyclesTotal} 个正常完成周期（展示最近 4 个）`}
          {hasAnomaly && <> · {recentAnomalies.length} 个近 30 天内异常</>}
        </span>
        {normalCyclesTotal > 0 && <span>满载率 = 正常周期峰值平均</span>}
      </footer>
    </section>
  )
}
