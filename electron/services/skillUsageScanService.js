/** Compatibility aggregate entry, with the same evidence and batch identity as invocation details. */
const { scanSkillRunSamples } = require('./skillRunSampleService')
/**
 * @param {object} deps - 主进程依赖。
 * @param {object} params - 资产/窗口。
 * @returns {Promise<object>} 唯一引擎结果，包括批次、完整性和可读性；副作用同 scanSkillRunSamples。
 */
async function scanSkillUsage(deps, params = {}) {
  return scanSkillRunSamples(deps, params)
}
module.exports = { scanSkillUsage }
