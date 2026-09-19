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
  query: ['planId', 'cycleId'],
  'cycle-price': ['planId', 'cycleId', 'price', 'operationId', 'expectedVersion']
};
// 价格通道不带 planId：价格是全局的，两张卡共用
const priceFields = {
  'price-refresh': ['model'],
  'price-set-local': ['model', 'input', 'output', 'cacheRead', 'cacheWrite'],
  'price-clear-local': ['model']
};
const RATE_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite'];
const priceErrors = {
  'price-refresh': 'PLAN_PRICE_REFRESH_FAILED',
  'price-set-local': 'PLAN_PRICE_SAVE_FAILED',
  'price-clear-local': 'PLAN_PRICE_SAVE_FAILED'
};
const goodOperation = id => typeof id === 'string' && id.length > 0 && id.length <= 200;
function valid(kind, p) {
  if (!p || typeof p !== 'object' || Array.isArray(p) || !validPlanId(p.planId) || Object.keys(p).some(k => !fields[kind].includes(k))) return false;
  if (p.expectedVersion !== undefined && (!Number.isInteger(p.expectedVersion) || p.expectedVersion < 0)) return false;
  if (kind === 'save' && !Object.hasOwn(p, 'price') && !Object.hasOwn(p, 'billingDay')) return typeof p.autoRenew === 'boolean' && goodOperation(p.operationId);
  if (kind === 'save') return typeof p.price === 'number' && Number.isFinite(p.price) && p.price > 0 && Number.isInteger(p.billingDay) && p.billingDay >= 1 && p.billingDay <= 31 && typeof p.autoRenew === 'boolean' && goodOperation(p.operationId);
  if (kind === 'action') return ['renew', 'stop', 'restart'].includes(p.action) && goodOperation(p.operationId) && (p.cycleId === undefined || goodOperation(p.cycleId));
  if (kind === 'query') return goodOperation(p.cycleId);
  if (kind === 'cycle-price') return goodOperation(p.cycleId) && typeof p.price === 'number' && Number.isFinite(p.price) && p.price > 0 && goodOperation(p.operationId);
  return true;
}
function validPrice(kind, p) {
  if (!p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).some(k => !priceFields[kind].includes(k)) || !goodOperation(p.model)) return false;
  if (kind === 'price-set-local') return RATE_FIELDS.every(f => typeof p[f] === 'number' && Number.isFinite(p[f]) && p[f] >= 0);
  return true;
}
/** @param {unknown} key Legacy generic store argument. @returns {boolean} Reject direct Plan ledger/cache access through generic store writes. */
function isReservedPlanKey(key) {
  return typeof key !== 'string' || ['planLedgerV1', 'planDailySummaryV1', 'planPriceOverridesV1'].some(name => key === name || key.startsWith(name + '.') || key.startsWith(name + '['));
}
/** @param {object} deps Electron ipcMain and trusted service. @returns {void} Register plan and price handlers. */
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
        });else if (kind === 'cycle-price') data = await service.setCyclePrice(p.planId, p.cycleId, p.price, p.operationId, {
          expectedVersion: p.expectedVersion
        });else data = await service.query(p.planId, p.cycleId);
        return {
          success: true,
          data
        };
      } catch (error) {
        return {
          success: false,
          error: error?.message === 'PLAN_CONFLICT' ? 'PLAN_CONFLICT' : `PLAN_${kind.toUpperCase().replace('-', '_')}_FAILED`
        };
      }
    });
  }
  for (const kind of Object.keys(priceFields)) {
    ipcMain.handle('plan-' + kind, async (_event, p) => {
      if (!validPrice(kind, p)) return {
        success: false,
        error: 'INVALID_INPUT'
      };
      try {
        let data;
        if (kind === 'price-refresh') data = await service.refreshPrice(p.model);else if (kind === 'price-set-local') data = await service.setLocalPrice(p.model, Object.fromEntries(RATE_FIELDS.map(f => [f, p[f]])));else data = await service.clearLocalPrice(p.model);
        return {
          success: true,
          data
        };
      } catch {
        return {
          success: false,
          error: priceErrors[kind]
        };
      }
    });
  }
}
module.exports = {
  registerPlanHandlers,
  isReservedPlanKey
};
