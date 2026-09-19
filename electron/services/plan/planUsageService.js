/**
 * Source-aware subscription API equivalent costs.
 * - Normalize aliases before vendor eligibility and pricing.
 * - Freeze one merged effective pricing snapshot for every query.
 * - Price each record by its Beijing date; user-filled prices override the catalog.
 * @module electron/services/plan/planUsageService
 */
const {
  pricingRegistrySpec
} = require('../registries/pricingRegistry');
const {
  getRemoteConfig
} = require('../remoteConfigLoader');

const RATE_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite'];
const validRates = entry => entry && RATE_FIELDS.every(field => typeof entry[field] === 'number' && Number.isFinite(entry[field]) && entry[field] >= 0);
const beijingDay = timestamp => {
  const time = new Date(timestamp).getTime();
  return Number.isFinite(time) ? new Date(time + 8 * 3600000).toISOString().slice(0, 10) : null;
};
/** @param {object} entry Catalog model entry. @param {string|null} day Beijing date. @returns {object} Rates effective on that date. */
function priceAt(entry, day) {
  // history 按 until 升序：第一个 day < until 的段就是当时价格；自填价不带 history，永远用顶层
  for (const segment of Array.isArray(entry.history) ? entry.history : []) if (day && day < segment.until) return segment;
  return entry;
}
/**
 * @param {object} packaged Bundled fallback. @param {object} remote Active loader snapshot.
 * @param {Record<string, object>} overrides User-filled prices keyed by normalized model.
 * @returns {object} Independent immutable query snapshot.
 */
function getEffectivePricing(packaged = pricingRegistrySpec.packaged || pricingRegistrySpec.hardcoded, remote = getRemoteConfig('pricing')?.config, overrides = {}) {
  const merged = remote?.models && typeof remote.models === 'object' ? {
    ...packaged,
    ...remote,
    models: {
      ...packaged.models,
      ...remote.models
    },
    aliases: {
      ...(packaged.aliases || {}),
      ...(remote.aliases || {})
    }
  } : packaged;
  const snapshot = structuredClone(merged);
  snapshot.models = { ...snapshot.models };
  for (const [key, rates] of Object.entries(overrides || {})) if (validRates(rates)) snapshot.models[key] = {
    ...(snapshot.models[key]?.displayName ? { displayName: snapshot.models[key].displayName } : {}),
    ...Object.fromEntries(RATE_FIELDS.map(field => [field, rates[field]])),
    own: true
  };
  return snapshot;
}
const safeToken = n => typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
/** @param {'claude'|'codex'} planId CLI source. @param {Array<object>} records Safe token records. @param {object} pricing Frozen snapshot. @returns {Promise<object>} Known subtotal, model costs and excluded diagnostics. */
async function aggregatePlanCosts(planId, records, pricing) {
  if (planId !== 'claude' && planId !== 'codex') throw Error('INVALID_PLAN');
  const {
    normalizeClaudeModelName,
    normalizeModelKey,
    resolveCanonicalName
  } = await import('../modelAlias.mjs');
  const keys = new Set(Object.keys(pricing.models || {}).map(normalizeModelKey));
  const merged = new Map(),
    excluded = new Map();
  for (const record of records || []) {
    if (record.source && record.source !== planId) continue;
    const raw = typeof record.model === 'string' ? record.model : 'unknown';
    const normalized = normalizeClaudeModelName(raw);
    const canonical = resolveCanonicalName(normalized, pricing.aliases, keys);
    const key = normalizeModelKey(canonical);
    const tokens = {
      input: safeToken(record.input),
      output: safeToken(record.output),
      cacheRead: safeToken(record.cacheRead),
      cacheCreate: safeToken(record.cacheCreate)
    };
    const count = Object.values(tokens).reduce((s, n) => s + n, 0);
    if (!count) continue;
    if (!(planId === 'claude' ? /^claude-[a-z0-9]/ : /^gpt-[a-z0-9]/).test(key)) {
      const model = raw.slice(0, 200);
      const diagnostic = excluded.get(model) || {
        model,
        count: 0,
        tokens: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheCreate: 0
        }
      };
      diagnostic.count++;
      for (const field of Object.keys(tokens)) diagnostic.tokens[field] += tokens[field];
      excluded.set(model, diagnostic);
      continue;
    }
    const entry = pricing.models[key];
    const current = merged.get(key) || {
      key,
      name: entry?.displayName || canonical,
      entry: validRates(entry) ? entry : null,
      cost: 0
    };
    if (current.entry) {
      const rates = priceAt(current.entry, beijingDay(record.timestamp));
      current.cost += (tokens.input * rates.input + tokens.output * rates.output + tokens.cacheRead * rates.cacheRead + tokens.cacheCreate * rates.cacheWrite) / 1e6;
    }
    merged.set(key, current);
  }
  let total = 0,
    priced = 0;
  const models = [];
  for (const row of merged.values()) {
    const cost = row.entry ? row.cost : null;
    if (cost !== null) {
      total += cost;
      priced++;
    }
    const own = row.entry?.own === true;
    models.push({
      name: row.name,
      key: row.key,
      cost,
      own,
      ...(own ? { prices: Object.fromEntries(RATE_FIELDS.map(field => [field, row.entry[field]])) } : {})
    });
  }
  models.sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1) || a.name.localeCompare(b.name));
  return {
    total: models.length && !priced ? null : total,
    models,
    missingCount: models.filter(m => m.cost === null).length,
    excludedModels: [...excluded.values()]
  };
}
/** @param {object} deps Trusted ledger and daily cache services. @returns {Function} Safe cycle query. */
function createPlanUsageQuery({
  ledger,
  daily,
  nowFn = () => new Date(),
  pricingFn = getEffectivePricing,
  earliestFn = async () => null
}) {
  return async (planId, cycleId) => {
    const snapshot = await ledger.getCycle(planId, cycleId);
    const cutoff = new Date(snapshot.cutoff);
    const pricing = pricingFn();
    const usage = await daily.query(planId, snapshot.cycle, cutoff);
    if(usage.pending)return {version:snapshot.plan.version,cycleId:snapshot.cycle.id,pending:true,total:null,models:[],cutoff:usage.cutoff||cutoff.toISOString(),dataRevision:usage.revision};
    const costs = await aggregatePlanCosts(planId, usage.records, pricing);
    let earliest = null;
    try {
      earliest = await earliestFn(planId);
    } catch {}
    const { start, end } = snapshot.cycle;
    return {
      ...costs,
      // 日志从这期中间才开始：数字不全，界面只说明、不下「没回本」的结论
      recordsFrom: typeof earliest === 'string' && earliest > start && earliest < end ? earliest : null,
      version: snapshot.plan.version,
      cycleId: snapshot.cycle.id,
      cutoff: usage.cutoff || cutoff.toISOString(),
      dataRevision: usage.revision,
      missingSource: usage.missingSource,
      metrics: usage.metrics
    };
  };
}
module.exports = {
  priceAt,
  getEffectivePricing,
  aggregatePlanCosts,
  createPlanUsageQuery
};
