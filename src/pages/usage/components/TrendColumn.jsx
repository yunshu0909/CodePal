/**
 * 满载率趋势单栏（Claude / Codex 共用）
 *
 * 负责：
 * - 大数字（满载率 = 正常周期峰值平均）+ 本周进行中条 + 已完成周期列表
 * - Claude 可选异常小节（provider_reset）；Codex 不传则不显示
 * - 两栏都走同一套 classifyHistory，数据来源不同（Claude 固定周期 / Codex 自然周）
 *
 * @module pages/usage/components/TrendColumn
 */

import { classifyHistory, cycleDurationDays } from '../usageHistoryUtils'

/**
 * 格式化为 M/D
 * @param {number|null|undefined} sec - unix 秒
 * @returns {string}
 */
function formatShortDate(sec) {
  if (!sec) return '--'
  const d = new Date(Number(sec) * 1000)
  if (Number.isNaN(d.getTime())) return '--'
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/**
 * 距某时刻的剩余时长
 * @param {number|null|undefined} sec - unix 秒
 * @returns {string}
 */
function formatRemaining(sec) {
  if (!sec) return ''
  const d = new Date(Number(sec) * 1000)
  if (Number.isNaN(d.getTime())) return ''
  const diff = Math.max(0, d.getTime() - Date.now())
  const m = Math.floor(diff / 60000)
  const days = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  const mm = m % 60
  if (days > 0) return `${days} 天 ${h}h`
  if (h > 0) return `${h}h ${String(mm).padStart(2, '0')}m`
  return `${mm}m`
}

/**
 * 满载率趋势单栏
 * @param {object} props
 * @param {'claude'|'codex'} props.brand - 品牌
 * @param {string} props.mark - 方块字母
 * @param {string} props.name - 工具名
 * @param {object|null} props.currentCycle - 本周进行中 { periodStart, periodEnd, peakPercentage }
 * @param {Array} props.completedCycles - 已完成周期（raw，内部 classifyHistory）
 * @param {string} props.cyclesLabel - 已完成区小标题
 * @param {string} props.avgCaption - 大数字下方说明
 * @param {boolean} [props.showAnomaly] - 是否显示异常小节（仅 Claude）
 * @param {string} [props.emptyHint] - 无已完成周期时的引导
 * @returns {JSX.Element}
 */
export default function TrendColumn({
  brand,
  mark,
  name,
  currentCycle,
  completedCycles,
  cyclesLabel,
  avgCaption,
  showAnomaly = false,
  emptyHint,
}) {
  const { normalCycles, recentAnomalies, avgPeak } = classifyHistory(completedCycles, undefined, currentCycle)
  const insufficientSample = avgPeak === null
  const hasAnomaly = showAnomaly && recentAnomalies.length > 0

  const curPctRaw = Number(currentCycle?.peakPercentage)
  const hasCur = Number.isFinite(curPctRaw)
  const curPct = hasCur ? Math.max(0, Math.min(100, curPctRaw)) : 0

  return (
    <div className="trend-col">
      <div className="trend-col__head">
        <span className={`usage-brand-tile usage-brand-tile--${brand}`}>{mark}</span>
        <span className="trend-col__name">{name}</span>
        <span className="trend-col__spacer" />
        {insufficientSample ? (
          <span className="trend-col__avg trend-col__avg--insufficient">样本不足</span>
        ) : (
          <span className="trend-col__avg">
            <span className="trend-col__avg-num">{avgPeak}</span>
            <span className="trend-col__avg-unit">%</span>
          </span>
        )}
      </div>
      <div className="trend-col__cap">{avgCaption}</div>

      {currentCycle && (
        <div className="cur-week">
          <div className="cur-week__head">
            <span className="cur-week__label"><span className="cur-week__dot" aria-hidden="true" />本周进行中</span>
            <span className="cur-week__pct">{hasCur ? `${Math.round(curPct)}%` : '--'}</span>
          </div>
          <div className="cur-week__track"><div className="cur-week__fill" style={{ width: `${curPct}%` }} /></div>
          <div className="cur-week__meta">
            <span>
              {formatShortDate(currentCycle.periodStart)} → {formatShortDate(currentCycle.periodEnd)}
              {formatRemaining(currentCycle.periodEnd) && <> · 距重置 {formatRemaining(currentCycle.periodEnd)}</>}
            </span>
            <span className="cur-week__tag">不计入</span>
          </div>
        </div>
      )}

      {normalCycles.length > 0 && (
        <>
          <div className="trend-sec-label">{cyclesLabel}</div>
          <div className="trend-list">
            {normalCycles.map((c, i) => {
              const peak = Number(c?.peakPercentage)
              const w = Number.isFinite(peak) ? Math.max(0, Math.min(100, peak)) : 0
              return (
                <div className="hrow" key={`n-${c?.periodEnd ?? 'c'}-${i}`}>
                  <span className="hrow__date">{formatShortDate(c?.periodStart)} → {formatShortDate(c?.periodEnd)}</span>
                  <div className="hrow__bar"><div className="hrow__fill" style={{ width: `${w}%` }} /></div>
                  <span className="hrow__pct">{Number.isFinite(peak) ? `${Math.round(peak)}%` : '--'}</span>
                </div>
              )
            })}
          </div>
        </>
      )}

      {hasAnomaly && (
        <>
          <div className="trend-sec-label trend-sec-label--anomaly">异常周期 · 近 30 天</div>
          <div className="trend-list">
            {recentAnomalies.map((c, i) => {
              const peak = Number(c?.peakPercentage)
              const w = Number.isFinite(peak) ? Math.max(0, Math.min(100, peak)) : 0
              const days = cycleDurationDays(c?.periodStart, c?.periodEnd)
              return (
                <div className="hrow hrow--anomaly" key={`a-${c?.periodEnd ?? 'c'}-${i}`}>
                  <span className="hrow__date">⚠ {formatShortDate(c?.periodStart)} → {formatShortDate(c?.periodEnd)}{days > 0 ? ` · ${days} 天` : ''}</span>
                  <div className="hrow__bar"><div className="hrow__fill" style={{ width: `${w}%` }} /></div>
                  <span className="hrow__pct">{Number.isFinite(peak) ? `${Math.round(peak)}%` : '--'}</span>
                </div>
              )
            })}
          </div>
        </>
      )}

      {normalCycles.length === 0 && !hasAnomaly && (
        <div className="trend-empty">{emptyHint || avgCaption}</div>
      )}
    </div>
  )
}
