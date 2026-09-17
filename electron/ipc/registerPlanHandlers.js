/**
 * Plan IPC boundary.
 * - Fixed plan IDs, legal form fields and existing server cycle identities.
 * - Stable error codes; never forward reader/scanner exception text.
 * @module electron/ipc/registerPlanHandlers
 */
const {
  validPlanId
} = require('../services/plan/planStoreService');
const fields = {
  read: ['planId'],
  save: ['planId', 'price', 'billingDay', 'autoRenew', 'operationId', 'expectedVersion'],
  action: ['planId', 'action', 'operationId', 'expectedVersion', 'cycleId'],
  query: ['planId', 'cycleId']
};
const goodOperation = id => typeof id === 'string' && id.length > 0 && id.length <= 200;
function valid(kind, p) {
  if (!p || typeof p !== 'object' || Array.isArray(p) || !validPlanId(p.planId) || Object.keys(p).some(k => !fields[kind].includes(k))) return false;
  if (p.expectedVersion !== undefined && (!Number.isInteger(p.expectedVersion) || p.expectedVersion < 0)) return false;
  if (kind === 'save' && !Object.hasOwn(p, 'price') && !Object.hasOwn(p, 'billingDay')) return typeof p.autoRenew === 'boolean' && goodOperation(p.operationId);
  if (kind === 'save') return typeof p.price === 'number' && Number.isFinite(p.price) && p.price > 0 && Number.isInteger(p.billingDay) && p.billingDay >= 1 && p.billingDay <= 31 && typeof p.autoRenew === 'boolean' && goodOperation(p.operationId);
  if (kind === 'action') return ['renew', 'stop', 'restart'].includes(p.action) && goodOperation(p.operationId) && (p.cycleId === undefined || goodOperation(p.cycleId));
  if (kind === 'query') return goodOperation(p.cycleId);
  return true;
}
/** @param {unknown} key Legacy generic store argument. @returns {boolean} Reject direct Plan ledger/cache access through generic store writes. */
function isReservedPlanKey(key) {
  return typeof key !== 'string' || ['planLedgerV1', 'planDailySummaryV1'].some(name => key === name || key.startsWith(name + '.') || key.startsWith(name + '['));
}
/** @param {object} deps Electron ipcMain and trusted service. @returns {void} Register four handlers. */
function registerPlanHandlers({
  ipcMain,
  service
}) {
  for (const kind of Object.keys(fields)) {
    ipcMain.handle('plan-' + kind, async (_event, p) => {
      if (!valid(kind, p)) return {
        success: false,
        error: 'INVALID_INPUT'
      };
      try {
        let data;
        if (kind === 'read') data = await service.read(p.planId);else if (kind === 'save') data = await service.save(p.planId, {
          ...(Object.hasOwn(p, 'price') ? {price:p.price,billingDay:p.billingDay} : {}),
          autoRenew: p.autoRenew
        }, p.operationId, {
          expectedVersion: p.expectedVersion
        });else if (kind === 'action') data = await service.act(p.planId, p.action, p.operationId, {
          expectedVersion: p.expectedVersion,
          cycleId: p.cycleId
        });else data = await service.query(p.planId, p.cycleId);
        return {
          success: true,
          data
        };
      } catch (error) {
        return {
          success: false,
          error: error?.message === 'PLAN_CONFLICT' ? 'PLAN_CONFLICT' : `PLAN_${kind.toUpperCase()}_FAILED`
        };
      }
    });
  }
}
module.exports = {
  registerPlanHandlers,
  isReservedPlanKey
};
