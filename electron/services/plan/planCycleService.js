/**
 * Plan cycle ledger transformations.
 * - Beijing date arithmetic independent of host timezone.
 * - Immutable ended records and user-saved billing anchors.
 * - Estimated history before the first saved cycle, floored at 2026-01.
 * @module electron/services/plan/planCycleService
 */
const DAY_MS = 86400000;
// 补历史的硬下限：第一个起点不早于这一天的周期（用户定「最早今年 1 月」）
const HISTORY_FLOOR = '2026-01-01';
const clone = value => structuredClone(value);

/** @param {Date} instant Query instant. @returns {string} Beijing calendar date. */
function beijingDate(instant = new Date()) {
  const date = new Date(instant);
  if (!Number.isFinite(date.getTime())) throw Error('INVALID_DATE');
  return new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 10);
}
/** @param {string} key ISO calendar date. @returns {boolean} Valid date. */
function validDate(key) {
  return typeof key === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(key) && Number.isFinite(Date.parse(key + 'T00:00:00Z')) && new Date(key + 'T00:00:00Z').toISOString().slice(0, 10) === key;
}
/** @param {string} key Date. @returns {Date} Beijing midnight. */
function beijingMidnight(key) {
  if (!validDate(key)) throw Error('INVALID_DATE');
  return new Date(key + 'T00:00:00+08:00');
}
function monthBoundary(year, month, day) {
  const base = new Date(Date.UTC(year, month, 1));
  const y = base.getUTCFullYear(),
    m = base.getUTCMonth();
  return new Date(Date.UTC(y, m, Math.min(day, new Date(Date.UTC(y, m + 1, 0)).getUTCDate()))).toISOString().slice(0, 10);
}
function validateDraft(draft) {
  if (!draft || typeof draft.price !== 'number' || !Number.isFinite(draft.price) || draft.price <= 0 || !Number.isInteger(draft.billingDay) || draft.billingDay < 1 || draft.billingDay > 31 || typeof draft.autoRenew !== 'boolean') throw Error('INVALID_SETTINGS');
}
/** @param {string} after Date excluded from new endpoint. @param {number} day Saved day. @returns {string} First billing boundary strictly after date. */
function nextBillingDate(after, day) {
  if (!validDate(after) || !Number.isInteger(day) || day < 1 || day > 31) throw Error('INVALID_DATE');
  const [y, m] = after.split('-').map(Number);
  const boundary = monthBoundary(y, m - 1, day);
  return boundary > after ? boundary : monthBoundary(y, m, day);
}
/** @param {number} day Billing anchor. @param {string} today Beijing day. @returns {{start:string,end:string}} Containing period. */
function containingCycle(day, today) {
  if (!validDate(today) || !Number.isInteger(day) || day < 1 || day > 31) throw Error('INVALID_DATE');
  const [y, m] = today.split('-').map(Number);
  const thisMonth = monthBoundary(y, m - 1, day);
  const start = thisMonth <= today ? thisMonth : monthBoundary(y, m - 2, day);
  return {
    start,
    end: nextBillingDate(start, day)
  };
}
function appendCycle(p, start, end) {
  p.cycles.push({
    id: `${start}:${end}:${p.cycles.length}`,
    start,
    end,
    price: p.price
  });
}
/** @param {object} plan Saved plan. @param {string} today Frozen Beijing date. @returns {object} Copy with local renewal records. */
function reconcilePlan(plan, today) {
  const p = clone(plan);
  if (!p.cycles.length || p.stopped || !p.autoRenew) return p;
  validateDraft(p);
  let count = 0;
  while (p.cycles.at(-1).end <= today) {
    if (++count > 10000) throw Error('INVALID_LEDGER');
    const start = p.cycles.at(-1).end;
    appendCycle(p, start, nextBillingDate(start, p.billingDay));
  }
  return p;
}
/**
 * 在已记录的第一期之前补出推算周期。
 * 下限 = max(第一个起点 ≥ HISTORY_FLOOR 的周期, 包含最早用量日期的周期)；只往前补、不回缩。
 * @param {object} plan Saved plan.
 * @param {string|null} earliest Earliest Beijing date with usage for this source.
 * @returns {object} Copy with estimated cycles prepended, or an unchanged copy.
 */
function backfillPlan(plan, earliest) {
  const p = clone(plan);
  const first = p.cycles[0];
  if (!first || !validDate(earliest) || !Number.isInteger(p.billingDay)) return p;
  const floorCycle = containingCycle(p.billingDay, HISTORY_FLOOR);
  const floor = floorCycle.start >= HISTORY_FLOOR ? floorCycle.start : floorCycle.end;
  const fromLogs = containingCycle(p.billingDay, earliest).start;
  let start = fromLogs > floor ? fromLogs : floor;
  const added = [];
  while (start < first.start) {
    const next = nextBillingDate(start, p.billingDay);
    // 首期起点不在账单日上（重新开始时按当天起算）时，最后一段截到首期起点
    const end = next < first.start ? next : first.start;
    added.push({ id: `${start}:${end}:e`, start, end, price: p.price, estimated: true });
    start = end;
  }
  if (added.length) p.cycles = [...added, ...p.cycles];
  return p;
}
/**
 * 单独改一期已结束的订阅费（最后一期走完整设置，不从这里改）。
 * @param {object} plan Committed plan. @param {string} cycleId Target cycle. @param {number} price New positive price.
 * @returns {object} Copy with only that cycle repriced and no longer estimated.
 */
function setCyclePrice(plan, cycleId, price) {
  const p = clone(plan);
  const index = p.cycles.findIndex(c => c.id === cycleId);
  if (index < 0 || index === p.cycles.length - 1) throw Error('INVALID_CYCLE');
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) throw Error('INVALID_SETTINGS');
  Object.assign(p.cycles[index], { price, estimated: false });
  return p;
}
/** @param {object} plan Last committed plan. @param {object} draft Whole legal form. @param {string} today Frozen date. @returns {object} New ledger, never mutates input. */
function savePlan(plan, draft, today) {
  validateDraft(draft);
  const p = clone(plan);
  const last = p.cycles.at(-1);
  const changedDay = p.billingDay !== draft.billingDay;
  Object.assign(p, {
    price: draft.price,
    billingDay: draft.billingDay,
    autoRenew: draft.autoRenew
  });
  if (!last) {
    const range = containingCycle(p.billingDay, today);
    appendCycle(p, range.start, range.end);
  } else if (!p.stopped && last.end > today) {
    last.price = p.price;
    if (changedDay) {
      const endedHistory = p.cycles.slice(0, -1).some(c => c.end <= today);
      const range = endedHistory ? {
        start: last.start,
        end: nextBillingDate(today, p.billingDay)
      } : containingCycle(p.billingDay, today);
      Object.assign(last, range, {
        id: `${range.start}:${range.end}:${p.cycles.length - 1}`
      });
    }
  }
  return reconcilePlan(p, today);
}
/** @param {object} plan Committed plan. @param {'renew'|'stop'|'restart'} action Local action. @param {string} today Frozen date. @returns {object} Atomic transformation. */
function performPlanAction(plan, action, today) {
  const p = clone(plan);
  validateDraft(p);
  const last = p.cycles.at(-1);
  if (!last) throw Error('PLAN_NOT_CONFIGURED');
  if (action === 'restart') {
    if (!p.stopped) return p;
    p.stopped = false;
    p.billingDay = Number(today.slice(8));
    appendCycle(p, today, nextBillingDate(today, p.billingDay));
  } else if (action === 'renew') {
    if (p.stopped || last.end > today) throw Error('INVALID_ACTION_STATE');
    appendCycle(p, last.end, nextBillingDate(last.end, p.billingDay));
  } else if (action === 'stop') {
    if (p.stopped) return p;
    if (last.end > today) throw Error('INVALID_ACTION_STATE');
    p.stopped = true;
  } else throw Error('INVALID_ACTION');
  return p;
}
module.exports = {
  DAY_MS,
  HISTORY_FLOOR,
  backfillPlan,
  setCyclePrice,
  beijingDate,
  beijingMidnight,
  validDate,
  validateDraft,
  containingCycle,
  nextBillingDate,
  reconcilePlan,
  savePlan,
  performPlanAction
};
