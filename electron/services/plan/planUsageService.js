/**
 * Source-aware subscription API equivalent costs.
 * - Normalize aliases before vendor eligibility and pricing.
 * - Freeze one merged effective pricing snapshot for every query.
 * @module electron/services/plan/planUsageService
 */
const {
  pricingRegistrySpec
} = require('../registries/pricingRegistry');
const {
  getRemoteConfig
} = require('../remoteConfigLoader');

/** @param {object} packaged Bundled fallback. @param {object} remote Active loader snapshot. @returns {object} Independent immutable query snapshot. */
function getEffectivePricing(packaged = pricingRegistrySpec.packaged || pricingRegistrySpec.hardcoded, remote = getRemoteConfig('pricing')?.config) {
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
  return structuredClone(merged);
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
    const current = merged.get(key) || {
      key,
      name: pricing.models[key]?.displayName || canonical,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreate: 0
    };
    for (const field of Object.keys(tokens)) current[field] += tokens[field];
    merged.set(key, current);
  }
  let total = 0,
    priced = 0;
  const models = [];
  for (const row of merged.values()) {
    const entry = pricing.models[row.key];
    const valid = entry && ['input', 'output', 'cacheRead', 'cacheWrite'].every(field => typeof entry[field] === 'number' && Number.isFinite(entry[field]) && entry[field] >= 0);
    const cost = valid ? (row.input * entry.input + row.output * entry.output + row.cacheRead * entry.cacheRead + row.cacheCreate * entry.cacheWrite) / 1e6 : null;
    if (cost !== null) {
      total += cost;
      priced++;
    }
    models.push({
      name: row.name,
      cost
    });
  }
  models.sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1) || a.name.localeCompare(b.name));
  return {
    total: models.length && !priced ? null : total,
    models,
    excludedModels: [...excluded.values()]
  };
}
/** @param {object} deps Trusted ledger and daily cache services. @returns {Function} Safe cycle query. */
function createPlanUsageQuery({
  ledger,
  daily,
  nowFn = () => new Date(),
  pricingFn = getEffectivePricing
}) {
  return async (planId, cycleId) => {
    const snapshot = await ledger.getCycle(planId, cycleId);
    const cutoff = new Date(snapshot.cutoff);
    const pricing = pricingFn();
    const usage = await daily.query(planId, snapshot.cycle, cutoff);
    if(usage.pending)return {version:snapshot.plan.version,cycleId:snapshot.cycle.id,pending:true,total:null,models:[],cutoff:usage.cutoff||cutoff.toISOString(),dataRevision:usage.revision};
    const costs = await aggregatePlanCosts(planId, usage.records, pricing);
    return {
      ...costs,
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
  getEffectivePricing,
  aggregatePlanCosts,
  createPlanUsageQuery
};
