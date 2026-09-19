/** Cycle navigation over recorded and estimated periods; ends explain themselves on hover. @module pages/plan/CycleNav */
import React from 'react';
import Button from '../../../components/Button/Button';
/** @param {object} props Recorded cycles and selected cycle. @returns {JSX.Element} Original two small arrows. */
export default function CycleNav({
  cycles,
  cycle,
  onNavigate
}) {
  const index = cycles.findIndex(c => c.id === cycle.id);
  const atFirst = index <= 0,
    atLast = index < 0 || index >= cycles.length - 1;
  // disabled 的 button 不触发悬停提示，到头的原因挂在外层 span 上（按钮本身 pointer-events: none）
  return <><span className="plan-nv-wrap" title={atFirst ? '已是最早一期' : undefined}><Button variant="ghost" className="plan-nv" aria-label="上一周期" disabled={atFirst} onClick={() => onNavigate(cycles[index - 1].id)}>‹</Button></span><span className="plan-nv-wrap" title={atLast ? '已是本期' : undefined}><Button variant="ghost" className="plan-nv" aria-label="下一周期" disabled={atLast} onClick={() => onNavigate(cycles[index + 1].id)}>›</Button></span></>;
}
