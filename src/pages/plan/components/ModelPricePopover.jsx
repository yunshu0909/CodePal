/**
 * Model price popover behind a missing ("—") or user-filled amount.
 * - Missing: refresh the cloud catalog first; otherwise fill four per-million rates.
 * - User-filled: edit the rates or clear them to fall back to the catalog.
 * - Rates apply to every page and every cycle; failures keep the popover and typed values.
 * @module pages/plan/ModelPricePopover
 */
import React, { useRef, useState } from 'react';
import Button from '../../../components/Button/Button';
import usePopoverDismiss from '../usePopoverDismiss';
const FIELDS = [['input', '输入'], ['output', '输出'], ['cacheRead', '缓存读'], ['cacheWrite', '缓存写']];
/** @param {object} props Model row and price callbacks resolving to {success, found?}. @returns {JSX.Element} Upward anchored popover. */
export default function ModelPricePopover({
  model,
  onRefresh,
  onSaveLocal,
  onClearLocal,
  onClose
}) {
  const own = model.own === true;
  const [draft, setDraft] = useState(() => Object.fromEntries(FIELDS.map(([k]) => [k, own && model.prices ? String(model.prices[k]) : ''])));
  const [invalid, setInvalid] = useState([]);
  const [refresh, setRefresh] = useState(null);
  const [busy, setBusy] = useState(null);
  const root = useRef(null);
  const dismissed = usePopoverDismiss(root, onClose);
  const done = () => {
    dismissed.current = true;
    onClose();
  };
  const SKIPPED = Symbol('skipped');
  // 同一时间只跑一个动作；抛错按失败处理（返回 {success:false}），被跳过的点击什么都不做
  async function run(kind, action) {
    if (busy || dismissed.current) return SKIPPED;
    setBusy(kind);
    let result;
    try {
      result = await action();
    } catch {
      result = { success: false };
    }
    setBusy(null);
    return result;
  }
  async function refreshNow() {
    const result = await run('refresh', () => onRefresh(model.key));
    if (result === SKIPPED) return;
    if (result?.success && result.found) done();
    else setRefresh(result?.success ? 'none' : 'fail');
  }
  async function save() {
    const rates = Object.fromEntries(FIELDS.map(([k]) => [k, draft[k].trim() === '' ? NaN : Number(draft[k])]));
    const bad = FIELDS.map(([k]) => k).filter(k => !Number.isFinite(rates[k]) || rates[k] < 0);
    setInvalid(bad);
    if (bad.length) return;
    const result = await run('save', () => onSaveLocal(model.key, rates));
    if (result !== SKIPPED && result?.success !== false) done();
  }
  async function clear() {
    const result = await run('clear', () => onClearLocal(model.key));
    if (result !== SKIPPED && result?.success !== false) done();
  }
  const refreshHint = refresh === 'none' ? '云端也还没有这个模型的价格，可以先自己填。' : refresh === 'fail' ? '刷新失败，检查网络后再试。' : '';
  const hint = invalid.length ? '四个价都要填，不能是负数。' : busy === 'save' ? '保存中…' : '回车保存。所有页面、所有周期都按这个价算。';
  return <div className="plan-pop plan-pop-up" ref={root} role="dialog" aria-label={own ? `${model.name} 的价格` : `${model.name} 还没有价格`} data-testid="plan-model-price-popover" onKeyDown={e => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
      e.preventDefault();
      void save();
    }
  }}>
  <div className="plan-pop-title">{own ? `${model.name} 的价格` : `${model.name} 还没有价格`}</div>
  {!own && <><div className="plan-pop-act"><Button size="sm" className="plan-action" disabled={Boolean(busy)} onClick={refreshNow}>{busy === 'refresh' ? '刷新中…' : '从云端刷新'}</Button></div>
   {refreshHint && <div className={`plan-hint ${refresh === 'fail' ? 'plan-bad' : ''}`}>{refreshHint}</div>}
   <div className="plan-pop-sep" /></>}
  <div className="plan-pop-lab">{own ? '自己填的（美元 / 百万 token）' : '或者自己填（美元 / 百万 token）'}</div>
  <div className="plan-pop-grid">{FIELDS.map(([k, label]) => <label className="plan-pop-row" key={k}><span>{label}</span><div className={`plan-in ${busy === 'save' ? 'plan-busy' : ''}`}><input aria-label={label} inputMode="decimal" value={draft[k]} disabled={busy === 'save'} aria-invalid={invalid.includes(k)} onChange={e => setDraft(old => ({
          ...old,
          [k]: e.target.value
        }))} /></div></label>)}</div>
  <div className={`plan-hint ${invalid.length ? 'plan-warn' : ''}`}>{hint}</div>
  {own && <Button variant="ghost" className="plan-pop-clear" disabled={Boolean(busy)} onClick={clear}>清除自填，改用云端价格</Button>}
 </div>;
}
