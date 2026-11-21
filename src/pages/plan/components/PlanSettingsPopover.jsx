/**
 * Anchored subscription settings: numeric drafts and an immediate renewal preference.
 * - Outside pointerdown/Escape cancel unsubmitted numeric edits before blur.
 * - Renewal saves independently, survives closing and rolls back on failure.
 * - Submitted saves survive closing; only touched fields turn invalid.
 * - Enter/blur submits only the numeric fields the user typed in (decided at that moment); the write queue fills
 *   the rest from the ledger at write time, using the shown hints only while the ledger is still unset.
 *   Untouched fields follow a newer plan read while open. Only an identical consecutive submission is dropped.
 * @module pages/plan/PlanSettingsPopover
 */
import React, { useEffect, useRef, useState } from 'react';
import { formatUSD } from '../planPresentation';
const legal = d => Number.isFinite(d.price) && d.price > 0 && Number.isInteger(d.billingDay) && d.billingDay >= 1 && d.billingDay <= 31;
const numeric = value => value.trim() === '' ? NaN : Number(value);
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
    // 用户在这一格里输入过：交的时候交它，新读到的订阅也不再盖它
    dirty = useRef({ price: false, billingDay: false }),
    // 上一笔交出去的内容：连着同一笔只交一次，中间改过别的（包括改回原值）照交；账本换了版本就重新算
    lastSent = useRef(null),
    draftNow = useRef(null),
    session = useRef(globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`),
    sequence = useRef(0);
  draftNow.current = draft;
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
  // 弹层开着时卡上换成新读到的订阅（切回后后台读到、别处改过）：没输入过的格子跟着换成新的
  useEffect(() => {
    const follow = {
      ...(!dirty.current.price && plan.price != null ? { price: String(plan.price) } : {}),
      ...(!dirty.current.billingDay && plan.billingDay != null ? { billingDay: String(plan.billingDay) } : {})
    };
    if (Object.keys(follow).length) setDraft(old => ({...old, ...follow}));
  }, [plan.price, plan.billingDay]);
  useEffect(() => {
    lastSent.current = null;
  }, [plan.version]);
  useEffect(() => {
    if (renewalPromise.current) return;
    const autoRenew = plan.autoRenew ?? false;
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
    }).catch(() => {
      // Keep numeric edits; only the failed preference returns to its saved state.
      const autoRenew = savedRenewal.current;
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
    // 回车这一刻就定下交什么：输入过的格子交用户填的；没输入过的交给写入队列照写入那一刻的账本，
    // 账本那时还没设过才用这里显示的提示值（fallback）。自动续费不交，由队列照账本补齐。
    const value = {},
      fallback = {};
    for (const field of ['price', 'billingDay']) (dirty.current[field] ? value : fallback)[field] = parsed[field];
    const saved = plan.price != null && plan.billingDay != null;
    if (!Object.keys(value).length && saved) return;
    if (!saved && Object.keys(fallback).length) value.fallback = fallback;
    const key = JSON.stringify(value);
    if (lastSent.current === key) return;
    lastSent.current = key;
    const id = `${planId}:${session.current}:${++sequence.current}`;
    let ok = false;
    try {
      ok = (await onSave(value, id))?.success !== false;
    } catch {}
    // 没存上：同一笔可以再交
    if (!ok && lastSent.current === key) lastSent.current = null;
    // 存上了、之后没再输入的格子：算回「没输入过」，以后跟着新读到的订阅走，也不再跟着别的格子交
    if (ok) for (const field of ['price', 'billingDay']) if (field in value && numeric(draftNow.current[field]) === value[field]) dirty.current[field] = false;
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
  return <div className="plan-pop np-pop" ref={root} role="dialog" aria-label={`${name} 订阅`} data-testid="plan-settings-popover" onKeyDown={e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void submit(true);
    }
  }}>
  <div className="plan-pop-title">{name} 订阅</div>
  <div className="plan-pop-row"><span>类型</span><div className="plan-in np-in plan-readonly" title={metadata?.type}>{metadata?.type && metadata.type !== '未知' ? `${metadata.type} · 本机读到` : '未知'}</div></div>
  <label className="plan-pop-row"><span>订阅费</span><div className="plan-in np-in"><span>$</span><input aria-label="订阅费" inputMode="decimal" autoFocus value={draft.price} aria-invalid={Boolean(touched.price && (!Number.isFinite(parsed.price) || parsed.price <= 0))} onChange={e => {
          dirty.current.price = true;
          const price = e.target.value;
          setDraft(old => ({...old, price}));
        }} onBlur={e => blur('price', e)} /></div></label>
  <label className="plan-pop-row"><span>账单日</span><div className="plan-in np-in"><span>每月</span><input aria-label="账单日" className="plan-day-input" inputMode="numeric" value={draft.billingDay} aria-invalid={Boolean(touched.billingDay && (!Number.isInteger(parsed.billingDay) || parsed.billingDay < 1 || parsed.billingDay > 31))} onChange={e => {
          dirty.current.billingDay = true;
          const billingDay = e.target.value;
          setDraft(old => ({...old, billingDay}));
        }} onBlur={e => blur('billingDay', e)} /><span>号</span></div></label>
  <div className="plan-pop-row"><span>自动续费</span><label className="plan-check"><input type="checkbox" aria-label="到期自动进下一周期" checked={draft.autoRenew} disabled={savingRenewal} onChange={e => saveRenewal(e.target.checked)} /><span>到期自动进下一周期</span></label></div>
  {warn && <div className="plan-hint plan-warn">改价从本周期起按 {formatUSD(parsed.price)} 算，倍数会变；已结束的周期按当时价格保留。</div>}
  <div className="plan-hint">回车保存。不勾自动续费，到期后会停下来让你确认一次。</div>
 </div>;
}
