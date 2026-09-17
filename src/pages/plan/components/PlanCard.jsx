/** Original compact Plan card with independent source/lifecycle states. @module pages/plan/PlanCard */
import React, { useCallback, useState } from 'react';
import Button from '../../../components/Button/Button';
import { describePlan, formatUSD, monthDay, visibleModels } from '../planPresentation';
import CycleNav from './CycleNav';
import PlanSettingsPopover from './PlanSettingsPopover';
const NAME = {
  claude: 'Claude Code',
  codex: 'Codex'
};
/** @param {object} props Committed snapshot and cycle result. @returns {JSX.Element} Design-replica card. */
export default function PlanCard({
  planId,
  name = NAME[planId],
  plan,
  metadata,
  today,
  cycle,
  usage,
  loading = false,
  error = null,
  acting = false,
  onSave,
  onAction,
  onNavigate
}) {
  const [settings, setSettings] = useState(false);
  const close = useCallback(() => setSettings(false), []);
  const view = describePlan({
    plan,
    cycle,
    usage,
    today,
    loading,
    error
  });
  const unset = view.state === 'unset';
  const rows = visibleModels(view.models, view.total);
  const icon = planId === 'claude' ? <path d="M3 12 8 3l5 9M5 9h6" /> : <><path d="M4 5l4-2 4 2v6l-4 2-4-2zM8 3v10M4 5l4 2 4-2" /></>;
  const progressClass = view.state === 'expired' ? 'plan-dead' : view.state === 'history' || view.state === 'paused' ? 'plan-off' : view.warning ? 'plan-warn' : '';
  return <section className={`plan-card ${view.state === 'paused' ? 'plan-paused' : ''} ${loading && !unset ? 'plan-sk' : ''}`} data-testid="plan-card" data-plan-id={planId}>
  <div className="plan-hd" data-testid="plan-card-header"><b><span className={`plan-app plan-app-${planId}`}><svg viewBox="0 0 16 16" aria-hidden="true">{icon}</svg></span>{name}<span className="plan-type">{metadata?.type || '未知'}</span></b><span>{view.badge && <span className={`plan-tag ${view.state === 'expired' ? 'plan-dead' : view.warning ? 'plan-warn' : 'plan-muted'}`}>{view.badge}</span>}</span></div>
  <div className="plan-top" data-testid="plan-card-number-region"><div className="plan-xw"><span className={`plan-x ${view.bad && !loading ? 'plan-bad' : ''} ${unset || view.total === null ? 'plan-na' : ''}`}>{loading && !unset ? '00×' : view.multiplier}</span>{view.subtitle && <span className={`plan-sub ${unset ? 'plan-link' : view.bad && view.state === 'active' && !loading ? 'plan-bad' : ''}`}>{view.subtitle}</span>}</div>
   <table className="plan-kv" data-testid="plan-values"><tbody><tr><td>订阅费</td><td className="plan-price"><Button variant="ghost" className={`plan-price-button ${unset ? 'plan-link' : ''}`} aria-label={`${name} 订阅设置`} onClick={() => setSettings(old => !old)}>{unset ? '设置' : loading ? '$00' : formatUSD(cycle.price)}</Button>{settings && <PlanSettingsPopover planId={planId} name={name} plan={plan} metadata={metadata} today={today} onSave={onSave} onClose={close} />}</td></tr><tr><td>等价 API</td><td><span>{loading && !unset ? '$0,000' : formatUSD(view.total)}</span></td></tr>
    {!unset && <tr><td>周期</td><td>{loading ? <><span className="plan-period-bar"><i style={{
                    width: '60%'
                  }} /></span><span>还剩 00 天</span></> : <><CycleNav cycles={plan.cycles} cycle={cycle} onNavigate={onNavigate} />{(!['expired', 'paused'].includes(view.state) || error) && <span className="plan-range">{monthDay(cycle.start)} – {monthDay(cycle.end)}</span>}<span className="plan-period-bar"><i className={progressClass} style={{
                    width: `${view.progress * 100}%`
                  }} /></span><span className={`plan-left ${progressClass}`}>{view.remaining}</span></>}</td></tr>}
   </tbody></table>
  </div>
  {view.state === 'expired' && <><div className="plan-actions"><Button variant="primary" size="sm" className="plan-action" disabled={acting} onClick={() => onAction('renew')}>续了一期</Button><Button size="sm" className="plan-action" disabled={acting} onClick={() => onAction('stop')}>不续了</Button></div><div className="plan-note">没勾自动续费，到期后停下来确认一次。续了一期：新周期从 {monthDay(cycle.end)} 起算，不从今天。</div></>}
  {view.state === 'paused' && <div className="plan-actions"><Button size="sm" className="plan-action" disabled={acting} onClick={() => onAction('restart')}>重新开始，从今天起算</Button></div>}
  {!unset && (loading ? <div className="plan-models" data-testid="plan-model-list">{[.7, .4, .1].map((f, i) => <div className="plan-mrow" key={i}><span className="plan-nm">模型名</span><span className="plan-model-bar"><i style={{
            width: `${f * 100}%`
          }} /></span><span className="plan-v">$000</span></div>)}</div> : rows.length ? <div className="plan-models" data-testid="plan-model-list">{rows.map((row, i) => <div className={`plan-mrow plan-model-${row.other ? 'other' : i}`} data-testid="plan-model-row" key={row.name}><span className="plan-nm" title={row.name}>{row.name}</span><span className="plan-model-bar"><i style={{
            width: `${row.fraction * 100}%`
          }} /></span><span className="plan-v" data-testid={i === rows.length - 1 ? 'plan-model-list-last-row' : undefined}>{formatUSD(row.cost)}</span></div>)}</div> : view.total === 0 ? <div className="plan-empty">{usage?.missingSource ? `没有找到 ${name} 的本地记录` : '本周期还没有用量'}</div> : null)}
 </section>;
}
