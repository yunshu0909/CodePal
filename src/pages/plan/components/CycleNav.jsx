/**
 * Cycle navigation over recorded and estimated periods.
 * - A disabled end arrow explains itself with a page-drawn hint: 0.3s hover, or instantly on click.
 * - A click-shown hint fades out by itself; hovering an enabled arrow never shows one.
 * @module pages/plan/CycleNav
 */
import React, { useEffect, useRef, useState } from 'react';
import Button from '../../../components/Button/Button';
const HOVER_DELAY = 300,
  CLICK_HOLD = 1350,
  FADE = 150;
const HINTS = {
  prev: '已是最早一期',
  next: '已是本期'
};
/** @param {object} props Recorded cycles and selected cycle. @returns {JSX.Element} Original two small arrows with end-of-range hints. */
export default function CycleNav({
  cycles,
  cycle,
  onNavigate
}) {
  const index = cycles.findIndex(c => c.id === cycle.id);
  const atFirst = index <= 0,
    atLast = index < 0 || index >= cycles.length - 1;
  // hint = { side, leaving }：leaving 时先淡出再移除
  const [hint, setHint] = useState(null);
  const timers = useRef([]);
  const clear = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  };
  useEffect(() => clear, []);
  const later = (fn, ms) => timers.current.push(setTimeout(fn, ms));
  const hide = () => {
    clear();
    setHint(null);
  };
  const hover = (side, disabled) => {
    clear();
    if (disabled) later(() => setHint({ side, leaving: false }), HOVER_DELAY);
  };
  const tap = (side, disabled) => {
    if (!disabled) return;
    clear();
    setHint({ side, leaving: false });
    later(() => setHint({ side, leaving: true }), CLICK_HOLD);
    later(() => setHint(null), CLICK_HOLD + FADE);
  };
  // 禁用的按钮不接收鼠标事件（pointer-events: none），悬停和点击都落在外层 span 上
  const arrow = (side, label, glyph, disabled, target) => <span className="plan-nv-wrap" onMouseEnter={() => hover(side, disabled)} onMouseLeave={hide} onClick={() => tap(side, disabled)}>
      <Button variant="ghost" className="plan-nv" aria-label={label} disabled={disabled} onClick={() => onNavigate(target)}>{glyph}</Button>
      {hint?.side === side && disabled && <span className={`plan-nv-tip ${hint.leaving ? 'plan-leaving' : ''}`} role="tooltip">{HINTS[side]}</span>}
    </span>;
  return <>{arrow('prev', '上一周期', '‹', atFirst, cycles[index - 1]?.id)}{arrow('next', '下一周期', '›', atLast, cycles[index + 1]?.id)}</>;
}
