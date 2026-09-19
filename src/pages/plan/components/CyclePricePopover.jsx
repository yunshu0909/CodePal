/**
 * Single ended-cycle subscription price.
 * - Only this cycle changes; the plan price and other cycles stay.
 * - Enter saves; illegal input stays local; a failed save keeps the typed value.
 * @module pages/plan/CyclePricePopover
 */
import React, { useRef, useState } from 'react';
import { monthDay } from '../planPresentation';
import usePopoverDismiss from '../usePopoverDismiss';
/** @param {object} props Cycle and save callback resolving to {success}. @returns {JSX.Element} Anchored one-field popover. */
export default function CyclePricePopover({
  cycle,
  onSave,
  onClose
}) {
  const [value, setValue] = useState(String(cycle.price));
  const [invalid, setInvalid] = useState(false);
  const [saving, setSaving] = useState(false);
  const root = useRef(null);
  const dismissed = usePopoverDismiss(root, onClose);
  async function submit() {
    if (saving || dismissed.current) return;
    const price = value.trim() === '' ? NaN : Number(value);
    if (!Number.isFinite(price) || price <= 0) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setSaving(true);
    let ok = false;
    try {
      ok = (await onSave(price))?.success !== false;
    } catch {}
    if (ok) {
      dismissed.current = true;
      onClose();
    } else setSaving(false);
  }
  const hint = invalid ? '订阅费要大于 0。' : saving ? '保存中…' : '只改这一期，其他期不变。回车保存。';
  return <div className="plan-pop np-pop" ref={root} role="dialog" aria-label={`${monthDay(cycle.start)} – ${monthDay(cycle.end)} 这一期`} data-testid="plan-cycle-price-popover" onKeyDown={e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void submit();
    }
  }}>
  <div className="plan-pop-title">{monthDay(cycle.start)} – {monthDay(cycle.end)} 这一期</div>
  <label className="plan-pop-row"><span>订阅费</span><div className={`plan-in np-in ${saving ? 'plan-busy' : ''}`}><span>$</span><input aria-label="订阅费" inputMode="decimal" autoFocus value={value} disabled={saving} aria-invalid={invalid} onChange={e => setValue(e.target.value)} /></div></label>
  <div className={`plan-hint ${invalid ? 'plan-warn' : ''}`}>{hint}</div>
 </div>;
}
