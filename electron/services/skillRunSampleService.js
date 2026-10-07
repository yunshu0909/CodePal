/** Legacy service names delegate to the sole body-evidence engine. v1/v2 ledgers remain read-only during usage queries. */
const { aggregateUsage, listUsageRecords } = require('../modules/skills/usageEngine')
const {
  readInvocationLedger,
  atomicWriteInvocationLedger,
  defaultLedgerPath,
} = require('./skillInvocationLedgerService')
/**
 * @param {object} deps - 主进程依赖。
 * @param {object} params - 资产/窗口。
 * @returns {Promise<object>} 同一引擎聚合结果，包括批次、完整性和可读性；副作用同 aggregateUsage。
 */
function scanSkillRunSamples(deps, params = {}) {
  return aggregateUsage(deps, params)
}
/**
 * @param {object} deps - 主进程依赖。
 * @param {object} params - 身份/批次。
 * @returns {Promise<object>} 同批确认记录及完整性/可读性；副作用同 listUsageRecords。
 */
function listSkillInvocationRecords(deps, params = {}) {
  return listUsageRecords(deps, params)
}
/**
 * @param {object} params - 旧账本位置及可选名字；仅供旧调用方兼容。
 * @returns {Promise<object[]>} 历史请求，不代表正文成功加载；本统计引擎不调用此接口。
 */
async function loadSkillRunLedger(params = {}) {
  const ledger = await readInvocationLedger(params)
  return ledger.records.filter(
    (record) => !params.skillName || record.skillName === params.skillName
  )
}
/**
 * @param {object} params - 旧调用方的账本与请求。
 * @returns {Promise<*>} 兼容旧写接口；新统计查询不调用它。
 */
function writeSkillRunLedger(params = {}) {
  return atomicWriteInvocationLedger(params)
}
module.exports = {
  scanSkillRunSamples,
  listSkillInvocationRecords,
  loadSkillRunLedger,
  writeSkillRunLedger,
  defaultLedgerPath,
}
