/**
 * 审核规则的默认值正本（后-03、后-19、后-50）
 *
 * 负责：
 * - 这个版本的建议值与它的版本号；CodePal 生成审核配置、dev 读不到配置时的内置默认值都从这一份来
 * - 规则键白名单与每个键允许的取值（页面只传「改哪一项、改成什么」，主进程按这里校验，后-04）
 * - 生效值 = 默认值 + 你改过的项（后-16）；亲手改回建议值就去掉这一项（后-13）
 *
 * 纯数据与纯函数，不读写文件。
 *
 * @module electron/modules/models/reviewDefaults
 */

/** 建议值的版本；改了任何建议值就换一个，审核配置里写明用的是哪一版（后-18） */
const DEFAULTS_VERSION = '2026.10.1'
/** 能读审核配置的最低 dev 版本（dev 审核解耦那一版）；审核配置和两端比较都只用这一个常量 */
const MIN_DEV_WORKFLOW = '0.12.13'

const GATE_IDS = Object.freeze(['lite.G0', 'lite.G1', 'formal.G1', 'formal.G2b', 'formal.G3', 'formal.G4'])

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

const DEFAULTS = deepFreeze({
  selfReview: false,
  gates: {
    'lite.G0': { reviewers: 1, rounds: 3 },
    'lite.G1': { reviewers: 2, rounds: 3 },
    'formal.G1': { reviewers: 1, rounds: 3 },
    'formal.G2b': { reviewers: 1, rounds: 2 },
    'formal.G3': { reviewers: 1, rounds: 3 },
    'formal.G4': { reviewers: 2, rounds: 3 },
  },
  advanced: { timeoutMinutes: 20, failoverMax: 3, autoExtendRounds: 1 },
})

const REVIEWERS = Object.freeze([1, 2, 3])
const ROUNDS = Object.freeze([1, 2, 3, 4, 5])
const ALLOWED = Object.freeze({
  selfReview: Object.freeze([false, true]),
  ...Object.fromEntries(
    GATE_IDS.flatMap((gate) => [
      [`gates.${gate}.reviewers`, REVIEWERS],
      [`gates.${gate}.rounds`, ROUNDS],
    ]),
  ),
  'advanced.timeoutMinutes': Object.freeze([5, 10, 15, 20, 30, 45, 60]),
  'advanced.failoverMax': Object.freeze([0, 1, 2, 3, 4, 5]),
  'advanced.autoExtendRounds': Object.freeze([0, 1, 2, 3]),
})
const RULE_KEYS = Object.freeze(Object.keys(ALLOWED))

function invalid(message = '这项规则的取值不对') {
  const error = new Error(message)
  error.code = 'invalid_input'
  return error
}

/** @param {string} key 规则键 @returns {Array<number|boolean>} 允许的取值（未知键返回空数组） */
function allowedValues(key) {
  return Object.hasOwn(ALLOWED, key) ? [...ALLOWED[key]] : []
}

/** @returns {boolean} 键在白名单里且取值在它允许的范围内（严格相等，不做类型转换） */
function isValidRule(key, value) {
  return typeof key === 'string' && Object.hasOwn(ALLOWED, key) && ALLOWED[key].includes(value)
}

/** 按点分键读出规则对象里的值 */
function valueAt(rules, key) {
  if (key === 'selfReview') return rules.selfReview
  const [group, ...rest] = key.split('.')
  if (group === 'gates') return rules.gates[`${rest[0]}.${rest[1]}`]?.[rest[2]]
  return rules.advanced[rest[0]]
}

function assign(rules, key, value) {
  if (key === 'selfReview') rules.selfReview = value
  else if (key.startsWith('gates.')) {
    const [, a, b, field] = key.split('.')
    rules.gates[`${a}.${b}`][field] = value
  } else rules.advanced[key.slice('advanced.'.length)] = value
}

/**
 * 生效值 = 默认值，再用改过的项盖上去（后-16）
 * @param {object} overrides 改过的项 { 规则键: 值 }；不认识或取值不对的项忽略（由读文件时把关）
 * @param {object} [base=DEFAULTS] 这个版本的默认值
 * @returns {object} 新对象 { selfReview, gates, advanced }，可随意修改
 */
function effectiveRules(overrides = {}, base = DEFAULTS) {
  const rules = structuredClone(base)
  for (const [key, value] of Object.entries(overrides || {})) {
    if (isValidRule(key, value)) assign(rules, key, value)
  }
  return rules
}

/**
 * 记下一次修改：改回这个版本的建议值就去掉这一项（后-13）
 * @param {object} overrides 现在的改过项（不修改它）
 * @param {string} key 规则键
 * @param {*} value 新值
 * @param {object} [base=DEFAULTS]
 * @returns {object} 新的改过项
 * @throws {Error} code=invalid_input：键不在白名单或取值不在范围内
 */
function applyOverride(overrides, key, value, base = DEFAULTS) {
  if (!isValidRule(key, value)) throw invalid()
  const next = { ...(overrides || {}) }
  if (valueAt(base, key) === value) delete next[key]
  else next[key] = value
  return next
}

/** @returns {boolean} 一份完整的生效规则（selfReview / 6 道关 / 高级三项）每一项都在范围内 */
function isValidRules(rules) {
  if (!rules || typeof rules !== 'object' || !rules.gates || !rules.advanced) return false
  if (Object.keys(rules.gates).length !== GATE_IDS.length || Object.keys(rules.advanced).length !== 3) return false
  return RULE_KEYS.every((key) => isValidRule(key, valueAt(rules, key)))
}

/** 版本号按数字逐段比较（0.12.13 > 0.12.9）；不是 x.y.z 数字段的返回 NaN */
function compareVersions(a, b) {
  const parse = (v) => (typeof v === 'string' && /^\d+(\.\d+)*$/.test(v) ? v.split('.').map(Number) : null)
  const x = parse(a)
  const y = parse(b)
  if (!x || !y) return NaN
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const diff = (x[i] || 0) - (y[i] || 0)
    if (diff) return diff
  }
  return 0
}

module.exports = {
  DEFAULTS_VERSION,
  MIN_DEV_WORKFLOW,
  GATE_IDS,
  DEFAULTS,
  RULE_KEYS,
  allowedValues,
  isValidRule,
  isValidRules,
  effectiveRules,
  applyOverride,
  compareVersions,
}
