/**
 * User-filled model prices for subscription cost queries.
 * - Highest pricing priority: local > cloud cache > packaged > hardcoded.
 * - One flat price per model for every date; clearing falls back to the catalog.
 * @module electron/services/plan/planPriceOverrideService
 */
const OVERRIDES_KEY = 'planPriceOverridesV1';
const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite'];
// 与 modelAlias.normalizeModelKey 同规则；CJS 无法同步引入 .mjs，只能在此重复一行
const normalizeKey = name => String(name ?? '').toLowerCase().replace(/[\s.]+/g, '-');

/** @param {object} deps electron-store compatible get/set. @returns {object} Override service. */
function createPlanPriceOverrideService({
  store
}) {
  const read = () => {
    const stored = store.get(OVERRIDES_KEY);
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  };
  const keyOf = model => {
    const key = normalizeKey(model);
    if (!key || key.length > 200) throw Error('INVALID_PRICE');
    return key;
  };
  return {
    /** @returns {Record<string, object>} Copy of all user-filled prices keyed by normalized model. */
    list: () => structuredClone(read()),
    /** @param {string} model Model key. @param {object} prices Four non-negative per-million rates. */
    set(model, prices) {
      const key = keyOf(model);
      if (!prices || FIELDS.some(f => typeof prices[f] !== 'number' || !Number.isFinite(prices[f]) || prices[f] < 0)) throw Error('INVALID_PRICE');
      store.set(OVERRIDES_KEY, {
        ...read(),
        [key]: Object.fromEntries(FIELDS.map(f => [f, prices[f]]))
      });
    },
    /** @param {string} model Model key to fall back to the catalog price. */
    clear(model) {
      const key = keyOf(model);
      const next = read();
      delete next[key];
      store.set(OVERRIDES_KEY, next);
    }
  };
}
module.exports = {
  OVERRIDES_KEY,
  createPlanPriceOverrideService
};
