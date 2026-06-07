/**
 * 会员额度双栏对比卡（Claude / Codex 同屏对比 5h + 7d 当前额度）
 *
 * 负责：
 * - 外层卡壳（标题 + 两栏 grid + 1.5px 中缝 + 统一刷新 footer）
 * - 两栏独立渲染各自状态，一栏异常不拖垮另一栏
 * - 窄窗口下两栏塌成上下堆叠（见 DualUsageCard.css）
 *
 * @module pages/usage/components/DualUsageCard
 */

import ClaudeUsageColumn from './ClaudeUsageColumn'
import CodexUsageColumn from './CodexUsageColumn'
import Button from '../../../components/Button/Button'
import './DualUsageCard.css'

/**
 * 会员额度双栏对比卡
 * @param {object} props
 * @param {object} props.claude - Claude 栏数据 { statusState, loading, installing, error, onRefresh, onEnsureInstalled }
 * @param {object} props.codex - Codex 栏数据 { statusState, loading, error, onRefresh }
 * @param {() => void} props.onRefresh - 卡片级总刷新（同刷两端）
 * @returns {JSX.Element}
 */
export default function DualUsageCard({ claude, codex, onRefresh }) {
  const refreshing = Boolean(claude?.loading || codex?.loading)

  return (
    <section className="dual-card">
      <header className="dual-card__header">
        <h2 className="dual-card__title">会员额度</h2>
      </header>

      <div className="dual-grid">
        <ClaudeUsageColumn
          statusState={claude?.statusState}
          loading={claude?.loading}
          installing={claude?.installing}
          error={claude?.error}
          onRefresh={claude?.onRefresh}
          onEnsureInstalled={claude?.onEnsureInstalled}
        />
        <div className="dual-divider" aria-hidden="true" />
        <CodexUsageColumn
          statusState={codex?.statusState}
          loading={codex?.loading}
          error={codex?.error}
          onRefresh={codex?.onRefresh}
        />
      </div>

      <footer className="dual-card__footer">
        <span>额度来自各工具官方 rate_limits</span>
        <Button variant="ghost" size="sm" onClick={onRefresh} disabled={refreshing}>
          {refreshing ? '刷新中...' : '刷新状态'}
        </Button>
      </footer>
    </section>
  )
}
