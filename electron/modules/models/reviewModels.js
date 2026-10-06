/**
 * 给 dev 读的审核配置 review-config.json（§7.2；取代没人读的 review-models.json，后-44）
 *
 * 负责：
 * - 从「排好顺序、打开且现在能用的模型」+ 生效的审核规则算出审核配置；只放审核需要的字段：
 *   不放任何 Key、Token，也不放本机命令路径（接入模型由 dev 按 provider + model 走 CodePal 命令行入口，后-49、后-51）
 * - 内容（去掉 generatedAt、generator）没变就不写（后-08、后-17）；写时先写临时文件再替换（后-11）
 * - 第一次写时删掉旧的 review-models.json
 * - 校验已有的审核配置：坏 JSON、不认识的版本、取值超范围都算坏了（后-02、后-32）
 *
 * 文件名沿用 reviewModels.js（承接定稿 §8 写的 reviewConfig.js）：插件的先写测试流程暂时删不掉已有文件。
 *
 * @module electron/modules/models/reviewModels
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { DEFAULTS_VERSION, MIN_DEV_WORKFLOW, GATE_IDS, isValidRules } = require('./reviewDefaults')

const CONFIG_FILE = 'review-config.json'
const LEGACY_FILE = 'review-models.json'

function generatorVersion() {
  try {
    const file = path.resolve(__dirname, '../../../package.json').replace(/app\.asar\.unpacked(?=[/\\])/, 'app.asar')
    return JSON.parse(fs.readFileSync(file, 'utf8')).version
  } catch {
    return '2.1.x'
  }
}

const FAMILIES = {
  claude: 'anthropic',
  codex: 'openai',
  deepseek: 'deepseek',
  'mimo-api': 'mimo',
  'zhipu-api': 'zhipu',
  'zhipu-coding': 'zhipu',
  'kimi-api': 'kimi',
  'kimi-coding': 'kimi',
  'minimax-api': 'minimax',
  'minimax-plan': 'minimax',
}

/** @param {string} file 可信目标路径。 @param {string|Buffer} text 要写的字节。 @param {number} mode inode权限。 @returns {void} 原子替换；失败清理临时文件并抛原始错误。 */
function atomicWrite(file, text, mode) {
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  try {
    fs.writeFileSync(temporary, text, { mode, flag: 'wx' })
    fs.chmodSync(temporary, mode)
    fs.renameSync(temporary, file)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}

/** 一个模型在审核配置里的记录；订阅模型由 dev 直接调对应命令行，接入模型带 provider */
function modelRecord({ vendorId, model }) {
  const runner = vendorId === 'claude' ? 'claude-cli' : vendorId === 'codex' ? 'codex-exec' : 'codepal'
  const record = { id: model.id, family: FAMILIES[vendorId] || vendorId, runner }
  if (runner === 'codepal') record.provider = vendorId
  record.model = model.slug
  record.displayName = model.displayName
  record.effort = model.efforts.length ? model.effort : null
  return record
}

/**
 * @param {Array<{vendorId: string, model: object}>} models 已按顺序、只含打开且现在能用的模型
 * @param {{selfReview: boolean, gates: object, advanced: object}} rules 生效的审核规则
 * @param {{version?: string}} [defaults] 用的是哪一版默认值
 * @returns {object} 审核配置
 */
function buildReviewConfig(models, rules, defaults = {}) {
  return {
    schemaVersion: 1,
    generator: `CodePal ${generatorVersion()}`,
    generatedAt: new Date().toISOString(),
    defaultsVersion: defaults.version || DEFAULTS_VERSION,
    minDevWorkflow: MIN_DEV_WORKFLOW,
    selfReview: rules.selfReview,
    models: models.map(modelRecord),
    gates: Object.fromEntries(GATE_IDS.map((id) => [id, { reviewers: rules.gates[id].reviewers, rounds: rules.gates[id].rounds }])),
    advanced: { ...rules.advanced },
  }
}

/** 比较用：去掉每次都会变的生成时间与生成器版本 */
function contentOf(config) {
  const { generatedAt, generator, ...rest } = config
  return JSON.stringify(rest)
}

const MODEL_KEYS = new Set(['id', 'family', 'runner', 'provider', 'model', 'displayName', 'effort'])
function validModel(model) {
  return (
    model &&
    typeof model === 'object' &&
    Object.keys(model).every((key) => MODEL_KEYS.has(key)) &&
    typeof model.id === 'string' &&
    typeof model.model === 'string' &&
    ['claude-cli', 'codex-exec', 'codepal'].includes(model.runner) &&
    (model.effort === null || typeof model.effort === 'string')
  )
}

/**
 * 读已有的审核配置
 * @param {string} root 配置目录
 * @returns {{state: 'missing'|'invalid'|'valid', config: object|null}}
 */
function readReviewConfig(root) {
  let text
  try {
    text = fs.readFileSync(path.join(root, CONFIG_FILE), 'utf8')
  } catch (error) {
    return { state: error.code === 'ENOENT' ? 'missing' : 'invalid', config: null }
  }
  try {
    const config = JSON.parse(text)
    const ok =
      config &&
      config.schemaVersion === 1 &&
      typeof config.defaultsVersion === 'string' &&
      typeof config.minDevWorkflow === 'string' &&
      Array.isArray(config.models) &&
      config.models.every(validModel) &&
      isValidRules({ selfReview: config.selfReview, gates: config.gates, advanced: config.advanced })
    return ok ? { state: 'valid', config } : { state: 'invalid', config: null }
  } catch {
    return { state: 'invalid', config: null }
  }
}

/**
 * 写审核配置：内容没变不写；写成功后删掉旧审核清单
 * @param {string} root 主进程解析的配置目录（必须已存在）
 * @param {object} config buildReviewConfig 的结果
 * @returns {{written: boolean}}
 * @throws 原始文件错误（临时文件已清理，原文件不变）
 */
function writeReviewConfig(root, config) {
  const current = readReviewConfig(root)
  let written = false
  if (current.state !== 'valid' || contentOf(current.config) !== contentOf(config)) {
    atomicWrite(path.join(root, CONFIG_FILE), JSON.stringify(config, null, 2) + '\n', 0o644)
    written = true
  }
  // 审核配置换好就算这次写完；旧审核清单删不掉不影响结果（下次写时再删），不能让已提交的审核配置和设置对不上
  try {
    fs.rmSync(path.join(root, LEGACY_FILE), { force: true })
  } catch {
    // 留着旧清单无害：新版 dev 只读审核配置
  }
  return { written }
}

module.exports = { CONFIG_FILE, atomicWrite, buildReviewConfig, readReviewConfig, writeReviewConfig, contentOf }
