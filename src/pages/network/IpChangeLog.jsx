/**
 * IP 变化记录
 *
 * 负责：
 * - 分组名「IP 变化记录」+ 右端「近 7 天 N 次」
 * - 每条一行：时间（今天 / 昨天 / M月D日）[检测时发现] … 旧 IP → 新 IP，新的在上
 * - 空态单卡：没得比「还没有 IP 变化记录」，比过没变「近 7 天没有 IP 变化」
 *
 * @module pages/network/IpChangeLog
 */

/**
 * @param {Object} props
 * @param {ReturnType<import('./egressView').deriveEgressView>} props.view
 * @returns {JSX.Element}
 */
export default function IpChangeLog({ view }) {
  return (
    <>
      <div className="np-glabel">
        IP 变化记录
        {view.logCountText && <span className="nd-count">{view.logCountText}</span>}
      </div>
      {view.log.length > 0 ? (
        <div className="np-card np-card--form">
          {view.log.map((row) => (
            <div className="np-row" key={row.key} data-testid="nd-log-row">
              <span className="nd-time">
                {row.timeText}
                {row.foundByManual && <span className="nd-found">检测时发现</span>}
              </span>
              <span className="nd-ip">
                <span className="nd-old">{row.fromIp}</span>
                <span className="nd-arrow">→</span>
                {row.toIp}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="np-card"><div className="np-empty">{view.emptyText}</div></div>
      )}
    </>
  )
}
