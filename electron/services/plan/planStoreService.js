/**
 * Atomic Plan ledger storage.
 * - One global queue for both cards sharing an electron-store envelope.
 * - Persist operation identities and publish only after successful writes.
 * @module electron/services/plan/planStoreService
 */
const {
  beijingDate,
  validDate,
  validateDraft,
  reconcilePlan,
  savePlan,
  performPlanAction
} = require('./planCycleService');
const LEDGER_KEY = 'planLedgerV1';
const emptyPlan = () => ({
  cycles: [],
  version: 0,
  stopped: false
});
const unknownMetadata = () => ({
  type: '未知',
  suggestedPrice: null,
  suggestedBillingDay: null
});
const validPlanId = id => id === 'claude' || id === 'codex';
function checkPlan(p) {
  if (!p || !Array.isArray(p.cycles) || !Number.isInteger(p.version) || p.version < 0 || typeof p.stopped !== 'boolean') throw Error('INVALID_LEDGER');
  if (p.cycles.length) validateDraft(p);
  let priorEnd = null;
  const ids = new Set();
  for (const c of p.cycles) {
    if (typeof c.id !== 'string' || !c.id || ids.has(c.id) || !validDate(c.start) || !validDate(c.end) || c.end <= c.start || typeof c.price !== 'number' || !Number.isFinite(c.price) || c.price <= 0 || priorEnd && c.start < priorEnd) throw Error('INVALID_LEDGER');
    ids.add(c.id);
    priorEnd = c.end;
  }
}
/** @param {object} dependencies Store and frozen clock; metadata is injected. @returns {object} Plan service. */
function createPlanStoreService({
  store,
  nowFn = () => new Date(),
  metadataFn = async () => unknownMetadata()
}) {
  let queue = Promise.resolve();
  const serialize = fn => {
    const result = queue.then(fn);
    queue = result.catch(() => {});
    return result;
  };
  function load() {
    const stored = store.get(LEDGER_KEY);
    if (stored === undefined) return {
      schemaVersion: 1,
      plans: {
        claude: emptyPlan(),
        codex: emptyPlan()
      },
      operations: []
    };
    const ledger = structuredClone(stored);
    if (!ledger || ledger.schemaVersion !== 1 || !ledger.plans || Object.keys(ledger.plans).some(id => !validPlanId(id)) || ledger.operations !== undefined && !Array.isArray(ledger.operations)) throw Error('INVALID_LEDGER');
    for (const id of ['claude', 'codex']) checkPlan(ledger.plans[id]);
    ledger.operations ??= [];
    if (ledger.operations.some(o => !o || !validPlanId(o.planId) || typeof o.operationId !== 'string' || !o.operationId || o.operationId.length > 200 || typeof o.kind !== 'string')) throw Error('INVALID_LEDGER');
    return ledger;
  }
  function guard(id, operationId, options, p) {
    if (!validPlanId(id)) throw Error('INVALID_PLAN');
    if (operationId !== null && (typeof operationId !== 'string' || !operationId || operationId.length > 200)) throw Error('INVALID_OPERATION');
    if (options?.expectedVersion !== undefined && options.expectedVersion !== p.version) throw Error('PLAN_CONFLICT');
    if (options?.cycleId !== undefined && options.cycleId !== p.cycles.at(-1)?.id) throw Error('PLAN_CONFLICT');
  }
  async function publish(id, transform, {
    operationId = null,
    kind = 'read',
    options = {}
  } = {}) {
    return serialize(async () => {
      const ledger = load();
      if (!validPlanId(id)) throw Error('INVALID_PLAN');
      const p = ledger.plans[id];
      const instant = new Date(nowFn());
      const cutoff = instant.toISOString();
      const today = beijingDate(instant);
      const already = operationId && ledger.operations.some(o => o.planId === id && o.operationId === operationId);
      if (already) return {
        plan: structuredClone(p),
        today,
        cutoff,
        changed: false,
        duplicate: true
      };
      guard(id, operationId, options, p);
      const next = transform(p, today);
      checkPlan(next);
      const changed = JSON.stringify(next) !== JSON.stringify(p);
      if (changed) {
        next.version = p.version + 1;
        ledger.plans[id] = next;
        if (operationId) ledger.operations.push({
          planId: id,
          operationId,
          kind
        });
        await store.set(LEDGER_KEY, ledger);
      }
      return {
        plan: structuredClone(changed ? next : p),
        today,
        cutoff,
        changed,
        duplicate: false
      };
    });
  }
  async function withMetadata(id, fn) {
    const snapshot = await fn;
    let metadata = unknownMetadata();
    try {
      metadata = await metadataFn(id);
    } catch {}
    return {
      ...snapshot,
      metadata
    };
  }
  return {
    read: id => withMetadata(id, publish(id, reconcilePlan)),
    save: async (id, draft, operationId, options) => {
      const renewalOnly = draft && Object.keys(draft).length === 1 && typeof draft.autoRenew === 'boolean';
      if (!renewalOnly) validateDraft(draft);
      if (Object.keys(draft).some(k => !['price', 'billingDay', 'autoRenew'].includes(k))) throw Error('INVALID_SETTINGS');
      return withMetadata(id, publish(id, (p, today) => renewalOnly ? reconcilePlan({...p,autoRenew:draft.autoRenew},today) : savePlan(p, draft, today), {
        operationId,
        kind: 'save',
        options
      }));
    },
    act: (id, action, operationId, options) => withMetadata(id, publish(id, (p, today) => performPlanAction(p, action, today), {
      operationId,
      kind: action,
      options
    })),
    getCycle: async (id, cycleId) => {
      const s = await publish(id, reconcilePlan);
      const c = s.plan.cycles.find(x => x.id === cycleId);
      if (!c) throw Error('INVALID_CYCLE');
      return {
        ...s,
        cycle: structuredClone(c)
      };
    }
  };
}
module.exports = {
  LEDGER_KEY,
  emptyPlan,
  validPlanId,
  createPlanStoreService
};
