/**
 * 第三方模型接入 · 命令行入口
 *
 * 负责：
 * - 终端命令 codepal-<模型名> / codepal-<供应商>（由 CodePal 安装到 ~/.local/bin）用
 *   ELECTRON_RUN_AS_NODE=1 以 CodePal 自带的 Node 跑本文件；CodePal 关着也能用
 * - 用法：cli.cjs launch <供应商> <模型名 | @first> [--test] -- <给 claude 的参数>
 *   @first = 这家列表里的第一个模型（每家稳定入口用，给 dev-workflow 审核，改名不影响）
 * - 顺序：--version / --help 直接转给 claude → 保留参数 → 找 claude 与版本 → 交互模式查 settings 冲突
 *   → 读配置与 Key → 构造环境启动 claude；前面任一步失败就退出、不读 Key
 * - 后台模式且调用方要求 JSON（或「测一下」）时，结束后把结果写进 status/，页面据此显示「能不能用」
 * - CodePal 自己的提示只写标准错误，标准输出只放 claude 的原样输出（dev-workflow 要解析它）
 *
 * @module electron/modules/models/cli
 */

const os = require('os')
const path = require('path')
const store = require('./store')
const { PRESETS } = require('./presets')
const launchEnv = require('./launchEnv')
const { locateClaude, checkClaudeVersion } = require('./claudeCli')
const { findSettingsConflicts } = require('./conflicts')
const { classifyResult } = require('./classify')
const { runClaude } = require('./runner')

// 「测一下」固定参数：只读、不加载 MCP、不开浏览器；和审核走同一个入口
const TEST_ARGS = Object.freeze(['--print', '--output-format', 'json', '--tools', 'Read', '--permission-mode', 'dontAsk', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-chrome'])
const TEST_PROMPT = 'Reply with exactly: CODEPAL_OK'
const TEST_TIMEOUT_MS = 60000

/** 写一行提示到标准错误并返回退出码 */
function die(message, code = 1) {
  process.stderr.write(`${message}\n`)
  return code
}

/** 拆出本命令自己的参数与给 claude 的参数 */
function splitArgs(rest) {
  const i = rest.indexOf('--')
  return { own: i === -1 ? rest : rest.slice(0, i), claudeArgs: i === -1 ? [] : rest.slice(i + 1) }
}

/** 去掉只给本命令用的环境变量，原样交给 claude */
function passthroughEnv() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

/**
 * 命令行主流程
 * @param {string[]} argv - 不含 node 与脚本路径
 * @returns {Promise<number>} 退出码
 */
async function main(argv) {
  if (argv[0] !== 'launch' || argv.length < 3) return die('用法：launch <供应商> <模型名 | @first> [--test] -- <给 claude 的参数>')
  const [, providerId, modelArg, ...rest] = argv
  const { own, claudeArgs } = splitArgs(rest)
  const test = own.includes('--test')
  const preset = PRESETS[providerId]
  if (!preset) return die(`不认识的供应商：${providerId}`)

  // dev-workflow 的 doctor 只调 --version / --help：原样转给 claude，不读 Key、不加任何字
  if (!test && claudeArgs.length === 1 && (claudeArgs[0] === '--version' || claudeArgs[0] === '--help')) {
    const claude = locateClaude()
    if (!claude) return die('没找到 Claude Code')
    const r = await runClaude({ claudePath: claude, env: passthroughEnv(), args: claudeArgs, mode: 'interactive' })
    return r.exitCode
  }

  const mode = test || launchEnv.isPrintMode(claudeArgs) ? 'print' : 'interactive'
  const userArgs = test ? [...TEST_ARGS] : claudeArgs
  try {
    launchEnv.checkReservedFlags(mode, userArgs)
  } catch (err) {
    return die(err.message, 2)
  }

  const claude = locateClaude()
  if (!claude) return die('没找到 Claude Code')
  const ver = checkClaudeVersion(claude)
  if (!ver.ok) return die(ver.current ? `需要 Claude Code ${ver.required} 或更新，当前 ${ver.current}` : `需要 Claude Code ${ver.required} 或更新`)

  if (mode === 'interactive') {
    const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
    const conflicts = findSettingsConflicts({ cwd: process.cwd(), configDir })
    if (conflicts.length) return die(`${conflicts.join('、')} · 没有修改你的 Claude 配置`)
  }

  let cfg
  try {
    cfg = store.readConfig()
  } catch {
    return die('模型配置读不出，打开 CodePal「模型接入」看看')
  }
  const prov = cfg.providers[providerId]
  if (!prov || !prov.keySet) return die(`${preset.name} 还没填 Key，在 CodePal「模型接入」里填`)
  const model = modelArg === '@first' ? prov.models[0] : prov.models.find((m) => m.id === modelArg)
  if (!model) return die(modelArg === '@first' ? `${preset.name} 还没有模型，在 CodePal「模型接入」里添加` : `${preset.name} 没有叫 ${modelArg} 的模型，在 CodePal「模型接入」里添加`)
  const key = store.readKey(providerId)
  if (!key) return die('本机保存的 Key 找不到了，重新填写')

  const modelsHome = store.resolveModelsHome()
  const { env, args } = launchEnv.buildLaunch({ mode, preset, model, key, parentEnv: process.env, userArgs, modelsHome, maxRetries: test ? 1 : undefined })
  if (mode === 'print') store.ensureDir(path.join(modelsHome, 'claude-home'))

  const result = await runClaude({
    claudePath: claude,
    env,
    args,
    mode,
    stdinText: test ? TEST_PROMPT : undefined,
    timeoutMs: test ? Number(process.env.CODEPAL_TEST_TIMEOUT_MS) || TEST_TIMEOUT_MS : undefined,
  })

  // 按调用方是否要求 JSON 决定写回，而不是看输出能不能解析：断网时标准输出是空的，也要让页面变红
  // 调用期间模型被移除、改名或同名重加：这次结果属于旧模型，不写回
  if (mode === 'print' && (test || launchEnv.wantsJson(claudeArgs)) && store.isCurrentModel(providerId, model)) {
    const verdict = classifyResult(result, providerId)
    const runId = test ? process.env.CODEPAL_RUN_ID : undefined
    try {
      store.writeStatus(providerId, model.id, { ...verdict, source: test ? 'test' : 'review', runId })
    } catch {
      process.stderr.write('CodePal：没能记录这次结果\n')
    }
  }
  return result.exitCode
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code },
    (err) => { process.stderr.write(`CodePal：${err.message}\n`); process.exitCode = 1 },
  )
}

module.exports = { main, TEST_ARGS, TEST_PROMPT }
