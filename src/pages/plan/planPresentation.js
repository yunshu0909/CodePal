/**
 * Plan card display contract.
 * - Round only visible amounts, never cost arithmetic or ordering.
 * - Lifecycle messages override ordinary profit descriptions.
 * - Incomplete numbers (records start mid-cycle, missing prices) explain themselves and are never red.
 * @module pages/plan/planPresentation
 */
const DAYS = 86400000;
const days = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAYS);
/** @param {number|null} value API/subscription ratio. @returns {string} Original rounded multiplier. */
export function formatMultiplier(value) {
  return typeof value !== 'number' || !Number.isFinite(value) ? '—' : value >= 10 ? Math.round(value) + '×' : value.toFixed(1) + '×';
}
/** @param {number|null} value USD. @returns {string} Original integer USD format or dash. */
export function formatUSD(value) {
  return typeof value !== 'number' || !Number.isFinite(value) ? '—' : '$' + Math.round(value).toLocaleString('en-US');
}
/** @param {string} date Calendar date. @returns {string} MM.DD. */
export function monthDay(date) {
  return date?.slice(5).replace('-', '.') || '';
}
/** @param {object} data Committed plan and selected server cycle result. @returns {object} Card presentation. */
export function describePlan({
  plan,
  cycle,
  usage,
  today,
  loading = false,
  error = null
}) {
  if (!cycle || !plan.cycles?.length) return {
    state: 'unset',
    multiplier: '—',
    subtitle: '填订阅费后计算',
    total: null,
    models: [],
    badge: '',
    progress: 0
  };
  const history = cycle.id ? cycle.id !== plan.cycles.at(-1).id : cycle.start !== plan.cycles.at(-1).start;
  const state = history ? 'history' : plan.stopped ? 'paused' : today >= cycle.end ? 'expired' : 'active';
  const total = error ? null : usage?.total ?? null;
  const ratio = total === null ? null : total / cycle.price;
  const recordsFrom = error ? null : usage?.recordsFrom || null;
  const missingCount = error ? 0 : usage?.missingCount || 0;
  // 数字不全时不下「没回本」的结论
  const bad = ratio !== null && ratio < 1 && total > 0 && !recordsFrom && !missingCount;
  const n = days(today, cycle.end),
    duration = days(cycle.start, cycle.end),
    warning = state === 'active' && n >= 1 && n <= 3;
  const badge = state === 'history' ? '已结束' : state === 'paused' ? '已停' : state === 'expired' ? '已到期 · 待确认' : warning ? '快到期' : '';
  // 副行一次只放一句：状态话 > 记录从 > 缺价格 > 还差 / 省了
  let subtitle = recordsFrom ? `记录从 ${monthDay(recordsFrom)} 起` : missingCount ? `${missingCount} 个模型缺价格，未计入` : total > 0 ? bad ? `还差 ${formatUSD(cycle.price - total)} 回本` : ratio >= 1 ? `省了 ${formatUSD(total - cycle.price)}` : '' : '';
  if (loading) subtitle = '正在统计…';
  if (state === 'paused') subtitle = '已停 · 最后一期结果';else if (state === 'expired') subtitle = '这期续了吗？';
  const remaining = state === 'history' ? `已结束 · ${duration} 天` : state === 'paused' ? '已停' : state === 'expired' ? `${monthDay(cycle.end)} 已到期` : n === 1 ? '今天到期' : `还剩 ${n} 天`;
  return {
    state,
    badge,
    warning,
    bad,
    estimated: cycle.estimated === true,
    multiplier: formatMultiplier(ratio),
    subtitle,
    total,
    models: error ? [] : usage?.models || [],
    remaining,
    progress: state === 'active' ? Math.min(1, Math.max(0, days(cycle.start, today) / duration)) : 1
  };
}
/** @param {Array<object>} models Sorted precise costs. @param {number|null} total Known subtotal. @returns {Array<object>} Six rows and aggregate other, preserving null prices. */
export function visibleModels(models, total) {
  const ordered = [...(models || [])].sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1) || a.name.localeCompare(b.name));
  let rows = ordered.slice(0, 6);
  if (ordered.length > 6) {
    // 缺价模型要能点开补价，不能被折进「其他」；它们占住可见行，挤出的是金额最小的已知模型
    // 有已计价模型时至少留一行给金额最高的那个，缺价行最多占 5 行
    const priced = ordered.filter(x => x.cost !== null);
    const missing = ordered.filter(x => x.cost === null).slice(0, priced.length ? 5 : 6);
    const shown = [...priced.slice(0, 6 - missing.length), ...missing];
    rows = shown;
    const rest = ordered.filter(x => !shown.includes(x)),
      known = rest.filter(x => x.cost !== null);
    rows.push({
      name: `其他 ${rest.length} 个`,
      cost: known.length ? known.reduce((s, x) => s + x.cost, 0) : null,
      other: true
    });
  }
  return rows.map((row, index) => ({
    ...row,
    index,
    fraction: row.cost !== null && total > 0 ? Math.min(1, Math.max(0, row.cost / total)) : 0
  }));
}
