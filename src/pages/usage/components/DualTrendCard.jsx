/**
 * 满载率趋势双栏对比卡（Claude / Codex）
 *
 * 负责：
 * - 外壳（标题 + 两栏 grid + 1.5px 中缝 + footer + 窄屏堆叠）
 * - Claude 走固定 7 天周期；Codex 走自然周聚合峰值（口径在副标题/footer 标注）
 *
 * 复用 DualUsageCard.css 的外壳/品牌块类；trend 特有样式在 DualTrendCard.css。
 *
 * @module pages/usage/components/DualTrendCard
 */

import TrendColumn from './TrendColumn'
import './DualUsageCard.css'
import './DualTrendCard.css'

/**
 * 满载率趋势双栏对比卡
 * @param {object} props
 * @param {object} props.claude - { currentCycle, completedCycles, avgCaption }
 * @param {object} props.codex - { currentCycle, completedCycles, avgCaption }
 * @returns {JSX.Element}
 */
export default function DualTrendCard({ claude, codex }) {
  return (
    <section className="dual-card">
      <header className="dual-card__header">
        <h2 className="dual-card__title">满载率趋势</h2>
        <span className="dual-trend__sub">满载率高 = 用得值</span>
      </header>

      <div className="dual-grid">
        <TrendColumn
          brand="claude"
          mark="C"
          name="Claude Code"
          currentCycle={claude?.currentCycle}
          completedCycles={claude?.completedCycles}
          cyclesLabel="已完成周期"
          avgCaption={claude?.avgCaption}
          emptyHint="完整用完 1 个 7 天周期后，这里会出现满载率趋势"
          showAnomaly
        />
        <div className="dual-divider" aria-hidden="true" />
        <TrendColumn
          brand="codex"
          mark="Cx"
          name="Codex"
          currentCycle={codex?.currentCycle}
          completedCycles={codex?.completedCycles}
          cyclesLabel="近期周 · 自然周"
          avgCaption={codex?.avgCaption}
          emptyHint="用过几周 Codex 后，这里会出现按自然周的满载率趋势"
        />
      </div>

      <footer className="dual-card__footer">
        <span>满载率 = 最近 4 个周期峰值平均</span>
        <span>Codex 为滚动窗口，按自然周统计</span>
      </footer>
    </section>
  )
}
