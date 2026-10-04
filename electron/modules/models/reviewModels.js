/** Public review snapshot: explicit safe fields only, generated from current available models. */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const commands = require('./commands')
const { PRESETS } = require('./presets')

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

function modelCommand(vendor, model) {
  const file = path.resolve(commands.binDir(), commands.commandName(model.slug, vendor.id))
  try {
    if (!fs.statSync(file).isFile()) return ''
    fs.accessSync(file, fs.constants.X_OK)
    return file
  } catch {
    return ''
  }
}

/**
 * 从当前可用且启用的模型派生无凭证公开快照。
 * @param {Array<object>} vendors 主进程发现并叠加偏好的来源与模型。
 * @returns {object} schemaVersion/generatedAt/generator/models，仅含审核调用所需字段。
 * 只检查已装命令是否可执行，不写文件；被挡住的来源即使留有旧偏好也被排除。
 */
function buildReviewModels(vendors) {
  const models = []
  for (const vendor of vendors) {
    if (vendor.blocked) continue
    for (const model of vendor.models) {
      if (!model.enabled) continue
      const subscription = vendor.id === 'claude' || vendor.id === 'codex'
      const record = {
        id: model.id,
        vendor: vendor.id,
        family: FAMILIES[vendor.id],
        runner: vendor.id === 'claude' ? 'claude-cli' : vendor.id === 'codex' ? 'codex-exec' : 'codepal',
        model: model.slug,
        displayName: model.displayName,
        effort: model.effort,
        billing: subscription ? 'subscription' : PRESETS[vendor.id].type === '套餐' ? 'plan' : 'paid',
      }
      if (!subscription) record.command = modelCommand(vendor, model)
      models.push(record)
    }
  }
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), generator: `CodePal ${generatorVersion()}`, models }
}

/**
 * @param {string} root 主进程解析的模型配置目录，必须已存在。
 * @param {Array<object>} vendors 当前可用模型来源。
 * @returns {object} 已写入的公开快照。
 * 以0644临时inode原子替换review-models.json；失败抛原始文件错误并清理临时文件。
 */
function writeReviewModels(root, vendors) {
  const snapshot = buildReviewModels(vendors)
  atomicWrite(path.join(root, 'review-models.json'), JSON.stringify(snapshot, null, 2) + '\n', 0o644)
  return snapshot
}

module.exports = { atomicWrite, buildReviewModels, writeReviewModels }
