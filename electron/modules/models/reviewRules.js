/**
 * 审核规则文件 review-rules.json：只存你改过的项（§7.1）
 *
 * 文件形状：{ schemaVersion: 1, overrides: { "gates.lite.G1.reviewers": 3, … }, updatedAt }
 * 没有文件 = 全部用这个版本的建议值；「恢复默认」= 写一个空的 overrides。
 *
 * @module electron/modules/models/reviewRules
 */
const fs = require('fs')
const { isValidRule } = require('./reviewDefaults')

const RULES_FILE_INVALID_MESSAGE = '审核规则文件无法解析，修好或删除它后重试'
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

function invalidRules() {
  const error = new Error(RULES_FILE_INVALID_MESSAGE)
  error.code = 'RULES_FILE_INVALID'
  return error
}

/**
 * 读审核规则文件
 * @param {string} file 主进程解析的可信路径
 * @returns {object|null} 改过的项；文件不存在返回 null
 * @throws {Error} code=RULES_FILE_INVALID：格式不对、键不认识或取值超范围（不改写文件）
 */
function readOverrides(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  let value
  try {
    value = JSON.parse(text)
  } catch {
    throw invalidRules()
  }
  if (!object(value) || value.schemaVersion !== 1 || !object(value.overrides)) throw invalidRules()
  for (const [key, entry] of Object.entries(value.overrides)) {
    if (!isValidRule(key, entry)) throw invalidRules()
  }
  return { ...value.overrides }
}

/** @param {object} overrides 改过的项 @returns {string} 要落盘的文本 */
function serialize(overrides) {
  return JSON.stringify({ schemaVersion: 1, overrides, updatedAt: new Date().toISOString() }, null, 2) + '\n'
}

module.exports = { RULES_FILE_INVALID_MESSAGE, readOverrides, serialize }
