/**
 * 出口 IP 卡
 *
 * 负责：
 * - 卡头：地球图标 + 「出口 IP」，右侧状态标签与「检测一次 / 检测中… / 重试」按钮
 * - 卡体五种画面：从未检测 / 首次检测中（骨架）/ 有结果 / 再次检测中（旧值不动）/ 失败
 * - 有结果时的副行与 10 分钟内的变化行
 *
 * 画面全部由 egressView.deriveEgressView 推导，本组件只渲染。
 *
 * @module pages/network/EgressIpCard
 */

import Button from '../../components/Button/Button'

/** 地球线形图标（与侧栏网络诊断同一个意象） */
function GlobeIcon() {
  return (
    <span className="nd-icon" aria-hidden="true">
      <svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" /><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12" /></svg>
    </span>
  )
}

/**
 * @param {Object} props
 * @param {ReturnType<import('./egressView').deriveEgressView>} props.view - 页面画面
 * @param {() => void} props.onCheck - 点「检测一次 / 重试」
 * @returns {JSX.Element}
 */
export default function EgressIpCard({ view, onCheck }) {
  const { mode, tag, button } = view

  return (
    <section className="np-card nd-ip-card">
      <div className="np-card-hd">
        <span className="np-card-title"><GlobeIcon />出口 IP</span>
        <span className="np-card-acts">
          {tag === 'stable' && <span className="np-tag np-tag--green">稳定</span>}
          {tag === 'changed' && <span className="np-tag np-tag--orange">刚变化</span>}
          <Button
            variant={button.primary ? 'primary' : 'secondary'}
            size="sm"
            disabled={button.disabled}
            onClick={onCheck}
            data-testid="nd-check"
          >
            {button.label}
          </Button>
        </span>
      </div>

      {mode === 'na' && (
        <div className="nd-body">
          <div className="np-hero-na">还没检测过</div>
          <div className="np-hero-hint">检测后显示出口 IP、归属地和检测时间</div>
        </div>
      )}

      {mode === 'first' && (
        <div className="nd-body" data-testid="nd-hero-skeleton">
          <div className="np-hero-num np-sk-text np-sk--pulse">203.0.113.24</div>
          <div className="np-sub"><span className="np-sk np-sk--pulse nd-sub-sk" /></div>
        </div>
      )}

      {(mode === 'ok' || mode === 'again') && (
        <div className="nd-body">
          <div className="np-hero-num">{view.ip}</div>
          <div className="np-sub" data-testid="nd-sub">
            {view.locationText && <>{view.locationText}{'　'}</>}上次检测 <span className="nd-num">{view.checkedText}</span>
          </div>
          {view.change && (
            <div className="nd-change" data-testid="nd-change">
              <span className="nd-num">{view.change.timeText}</span> 从 <span className="nd-num">{view.change.fromIp}</span>
              {/* 全角括号自带留白，括号后直接接文字；没有归属地时空一格 */}
              {view.change.fromLocationText ? `（${view.change.fromLocationText}）` : ' '}变为当前 IP
            </div>
          )}
        </div>
      )}

      {mode === 'fail' && (
        <div className="nd-body">
          <div className="np-hero-num na">—</div>
          <div className="np-errline nd-tight">{view.failText}</div>
          {view.lastSuccess && (
            <div className="np-sub" data-testid="nd-last-success">
              上次成功 <span className="nd-num">{view.lastSuccess.ip}</span>
              {view.lastSuccess.locationText && ` · ${view.lastSuccess.locationText}`} · <span className="nd-num">{view.lastSuccess.timeText}</span>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
