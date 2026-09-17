/** Recorded-cycle navigation; never fabricates older periods. @module pages/plan/CycleNav */
import React from 'react';
import Button from '../../../components/Button/Button';
/** @param {object} props Recorded cycles and selected cycle. @returns {JSX.Element} Original two small arrows. */
export default function CycleNav({
  cycles,
  cycle,
  onNavigate
}) {
  const index = cycles.findIndex(c => c.id === cycle.id);
  return <><Button variant="ghost" className="plan-nv" aria-label="上一周期" disabled={index <= 0} onClick={() => onNavigate(cycles[index - 1].id)}>‹</Button><Button variant="ghost" className="plan-nv" aria-label="下一周期" disabled={index < 0 || index >= cycles.length - 1} onClick={() => onNavigate(cycles[index + 1].id)}>›</Button></>;
}
