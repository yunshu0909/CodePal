/**
 * Anchored subscription settings: numeric drafts and an immediate renewal preference.
 * - Outside pointerdown/Escape cancel unsubmitted numeric edits before blur.
 * - Renewal saves independently, survives closing and rolls back on failure.
 * - Submitted saves survive closing; only touched fields turn invalid.
 * @module pages/plan/PlanSettingsPopover
 */
import React, { useEffect, useRef, useState } from 'react';
import { formatUSD } from '../planPresentation';
const legal = d => Number.isFinite(d.price) && d.price > 0 && Number.isInteger(d.billingDay) && d.billingDay >= 1 && d.billingDay <= 31;
const numeric = value => value.trim() === '' ? NaN : Number(value);
const same = (a, b) => a.price === b.price && a.billingDay === b.billingDay && a.autoRenew === b.autoRenew;
/** @param {object} props Last saved plan, safe hints and save callback. @returns {JSX.Element} Original anchored popover. */
export default function PlanSettingsPopover({
  planId,
  name,
  plan,
  metadata,
  today,
  onSave,
  onClose
}) {
  const initial = {
    price: plan.price ?? metadata?.suggestedPrice ?? '',
    billingDay: plan.billingDay ?? metadata?.suggestedBillingDay ?? '',
    autoRenew: plan.autoRenew ?? false
  };
  const [draft, setDraft] = useState({
    price: String(initial.price),
    billingDay: String(initial.billingDay),
    autoRenew: initial.autoRenew
  });
  const [touched, setTouched] = useState({});
  const [savingRenewal, setSavingRenewal] = useState(false);
  const renewalPromise = useRef(null);
  const savedRenewal = useRef(plan.autoRenew ?? false);
  savedRenewal.current = plan.autoRenew ?? false;
  const root = useRef(null),
    canceled = useRef(false),
    // Safe hints populate the draft; equality must compare saved settings.
    committed = useRef({
      price: numeric(String(plan.price ?? '')),
      billingDay: numeric(String(plan.billingDay ?? '')),
      autoRenew: plan.autoRenew ?? false
    }),
    pending = useRef(new Map()),
    session = useRef(globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`),
    sequence = useRef(0);
  const parsed = {
    price: numeric(draft.price),
    billingDay: numeric(draft.billingDay),
    autoRenew: draft.autoRenew
  };
  useEffect(() => {
    const cancel = () => {
      if (canceled.current) return;
      canceled.current = true;
      onClose();
    };
    const outside = e => {
      if (root.current && !root.current.parentElement.contains(e.target)) cancel();
    };
    const esc = e => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', esc, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', esc, true);
    };
  }, [onClose]);
  useEffect(() => {
    if (renewalPromise.current) return;
    const autoRenew = plan.autoRenew ?? false;
    committed.current = {...committed.current, autoRenew};
    setDraft(old => ({...old, autoRenew}));
  }, [plan.autoRenew]);
  function saveRenewal(autoRenew) {
    if (canceled.current || renewalPromise.current) return;
    setDraft(old => ({...old, autoRenew}));
    setSavingRenewal(true);
    const id = `${planId}:${session.current}:${++sequence.current}`;
    let request;
    try { request = Promise.resolve(onSave({autoRenew}, id)); }
    catch (error) { request = Promise.reject(error); }
    renewalPromise.current = request.then(result => {
      if (result?.success === false) throw Error('save');
      committed.current = {...committed.current, autoRenew};
    }).catch(() => {
      // Keep numeric edits; only the failed preference returns to its saved state.
      const autoRenew = savedRenewal.current;
      committed.current = {...committed.current, autoRenew};
      setDraft(old => ({...old, autoRenew}));
    }).finally(() => {
      renewalPromise.current = null;
      setSavingRenewal(false);
    });
  }
  async function submit(all = false) {
    if (canceled.current) return;
    if (all) setTouched({
      price: true,
      billingDay: true
    });
    if (!legal(parsed)) return;
    // Enter/number blur must use the result of an in-flight independent renewal save.
    if (renewalPromise.current) await renewalPromise.current;
    const value = {...parsed, autoRenew:committed.current.autoRenew};
    if (same(value, committed.current)) return;
    const key = JSON.stringify(value);
    if (pending.current.has(key)) return;
    const id = `${planId}:${session.current}:${++sequence.current}`;
    pending.current.set(key, id);
    try {
      const result = await onSave(value, id);
      if (result?.success !== false) committed.current = value;
    } catch {} finally {
      pending.current.delete(key);
    }
  }
  function blur(field, event) {
    if (canceled.current) return;
    setTouched(old => ({
      ...old,
      [field]: true
    }));
    if (event.relatedTarget && root.current?.contains(event.relatedTarget)) void submit();
  }
  const current = plan.cycles?.at(-1);
  const warn = current && !plan.stopped && current.end > today && Number.isFinite(parsed.price) && parsed.price > 0 && parsed.price !== plan.price;
  return <div className="plan-pop" ref={root} role="dialog" aria-label={`${name} 订阅`} data-testid="plan-settings-popover" onKeyDown={e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void submit(true);
    }
  }}>
  <div className="plan-pop-title">{name} 订阅</div>
  <div className="plan-pop-row"><span>类型</span><div className="plan-in plan-readonly" title={metadata?.type}>{metadata?.type && metadata.type !== '未知' ? `${metadata.type} · 本机读到` : '未知'}</div></div>
  <label className="plan-pop-row"><span>订阅费</span><div className="plan-in"><span>$</span><input aria-label="订阅费" inputMode="decimal" autoFocus value={draft.price} aria-invalid={Boolean(touched.price && (!Number.isFinite(parsed.price) || parsed.price <= 0))} onChange={e => setDraft(old => ({
          ...old,
          price: e.target.value
        }))} onBlur={e => blur('price', e)} /></div></label>
  <label className="plan-pop-row"><span>账单日</span><div className="plan-in"><span>每月</span><input aria-label="账单日" className="plan-day-input" inputMode="numeric" value={draft.billingDay} aria-invalid={Boolean(touched.billingDay && (!Number.isInteger(parsed.billingDay) || parsed.billingDay < 1 || parsed.billingDay > 31))} onChange={e => setDraft(old => ({
          ...old,
          billingDay: e.target.value
        }))} onBlur={e => blur('billingDay', e)} /><span>号</span></div></label>
  <div className="plan-pop-row"><span>自动续费</span><label className="plan-check"><input type="checkbox" aria-label="到期自动进下一周期" checked={draft.autoRenew} disabled={savingRenewal} onChange={e => saveRenewal(e.target.checked)} /><span>到期自动进下一周期</span></label></div>
  {warn && <div className="plan-hint plan-warn">改价从本周期起按 {formatUSD(parsed.price)} 算，倍数会变；已结束的周期按当时价格保留。</div>}
  <div className="plan-hint">回车保存。不勾自动续费，到期后会停下来让你确认一次。</div>
 </div>;
}
