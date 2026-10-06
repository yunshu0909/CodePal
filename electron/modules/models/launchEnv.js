/**
 * 第三方模型接入 · 启动环境与参数构建
 *
 * 负责：
 * - 只对这一次启动构造 claude 子进程的环境：清掉别家地址 / Key / 模型变量，注入这家的地址、Key、模型
 * - 思考强度与上限走 --settings 覆盖（只设环境变量时用户自己的 effort 会盖过，Nexus issue-10 实测）
 * - 交互模式（人在终端）与后台模式（-p / --print，AI 调用与「测一下」）的差异
 * - 保留参数检查：这些参数由 CodePal 管理，用户传了就拒绝
 * - 后台模式限制重试次数：Claude Code 遇到 401 默认重试 11 次、要好几分钟（2026-09-27 实测），
 *   「测一下」只重试 1 次，审核默认 3 次（调用方自己设了 CLAUDE_CODE_MAX_RETRIES 就用它的）
 *
 * 规则来源：Nexus internal/app/claudelaunch/service.go（清理清单 421-439、覆盖 617-650、
 * 交互标记 658-661、保留参数 115-131、后台隔离 363-368）；#19 教训：不注入 CLAUDE_CODE_SUBPROCESS_ENV_SCRUB。
 *
 * @module electron/modules/models/launchEnv
 */

const path = require('path')
const { modelCapabilities } = require('./presets')

// 父环境里会把请求带去别家、或改变模型 / 能力的变量，启动前一律删掉
const SCRUB_ENV_KEYS = Object.freeze([
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_EFFORT_LEVEL', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  'ANTHROPIC_CUSTOM_HEADERS', 'HTTP_USER_AGENT', 'MAX_THINKING_TOKENS', 'ANTHROPIC_SMALL_FAST_MODEL',
  'CLAUDE_CODE_DISABLE_THINKING', 'CLAUDE_CODE_DISABLE_1M_CONTEXT',
  // Nexus 没处理的缺口：会员登录令牌可能让请求绕过注入的地址
  'CLAUDE_CODE_OAUTH_TOKEN',
  // 命令行自己靠它以 Node 方式运行，不能漏给 claude
  'ELECTRON_RUN_AS_NODE',
  // 「测一下」的本次调用编号，只给命令行写回结果用
  'CODEPAL_RUN_ID',
])

const RESERVED_FLAGS_INTERACTIVE = Object.freeze(['--model', '--fallback-model', '--settings', '--setting-sources', '--effort', '--autocompact', '--agent', '--agents'])
// dev-workflow 每次都会传 --effort，后台模式放行它
const RESERVED_FLAGS_PRINT = Object.freeze(['--model', '--fallback-model', '--settings', '--setting-sources'])

// 审核默认重试 3 次：网络抖动还能扛，Key 错了也不会卡十几分钟
const DEFAULT_PRINT_RETRIES = 3

const MODEL_VARS = Object.freeze([
  'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL',
])

/** 取到第一个独立 `--` 为止的参数（之后的是给 claude 的原文，不检查） */
function beforeDoubleDash(args) {
  const i = args.indexOf('--')
  return i === -1 ? args : args.slice(0, i)
}

/** @param {string[]} args @returns {boolean} 有 -p / --print 即后台模式 */
function isPrintMode(args) {
  return beforeDoubleDash(args).some((a) => a === '-p' || a === '--print')
}

/** @param {string[]} args @returns {boolean} 调用方是否要求 JSON 输出 */
function wantsJson(args) {
  const list = beforeDoubleDash(args)
  return list.some((a, i) => a === '--output-format=json' || (a === '--output-format' && list[i + 1] === 'json'))
}

/**
 * 检查保留参数（同时匹配 --x=值 写法，遇到独立的 -- 停止）
 * @param {'interactive'|'print'} mode
 * @param {string[]} args
 */
function checkReservedFlags(mode, args) {
  const reserved = mode === 'print' ? RESERVED_FLAGS_PRINT : RESERVED_FLAGS_INTERACTIVE
  for (const a of beforeDoubleDash(args)) {
    const name = a.split('=')[0]
    if (reserved.includes(name)) {
      const err = new Error(`这个参数由 CodePal 管理：${name}`)
      err.code = 'reserved_flag'
      throw err
    }
  }
}

/**
 * 这次启动用的思考等级（A-013、后-29）
 * - 终端交互模式：用模型接入里设的档位（终端手动用）；MiniMax 按模型能力校验（M3 没有档位不设），
 *   其余渠道照旧原样用（旧配置里的档位照常启动）
 * - 后台模式：只认调用方传进来的 --effort（审核用汇总页设的那个），按模型能力校验，非法或重复传拒绝；
 *   没传就不设，不再把模型接入里的档位塞进覆盖设置
 * @returns {string|null} 交互模式要写进覆盖设置的档位；后台模式恒为 null（等级由 --effort 原样交给 claude）
 */
function launchEffort(mode, model, capabilities, args, minimax) {
  if (mode !== 'print') return !minimax || capabilities.efforts.includes(model.effort) ? model.effort : null
  const list = beforeDoubleDash(args)
  let supplied = false
  for (let i = 0; i < list.length; i++) {
    const argument = list[i]
    if (argument !== '--effort' && !argument.startsWith('--effort=')) continue
    const value = argument === '--effort' ? list[++i] : argument.slice('--effort='.length)
    if (supplied || !capabilities.efforts.includes(value)) {
      const error = new Error('思考强度不对')
      error.code = 'invalid_input'
      throw error
    }
    supplied = true
  }
  return null
}

/**
 * 构造 claude 子进程的环境与参数
 * @param {object} p
 * @param {'interactive'|'print'} p.mode
 * @param {object} p.preset - 预设
 * @param {{name: string, effort: string, contextTokens: number, maxOutputTokens: number, autoCompactWindow?: number}} p.model
 * @param {string} p.key - Key 原文，只进环境变量
 * @param {object} p.parentEnv - 父进程环境（不会被修改）
 * @param {string[]} p.userArgs - 调用方给 claude 的参数
 * @param {string} p.modelsHome - 模型目录（后台模式的隔离配置目录在它下面）
 * @param {number} [p.maxRetries] - 后台模式重试次数（「测一下」传 1）；不传时用调用方环境里的值，再没有就 3
 * @returns {{env: object, args: string[]}}
 */
function buildLaunch({ mode, preset, model, key, parentEnv, userArgs, modelsHome, maxRetries }) {
  checkReservedFlags(mode, userArgs)
  const capabilities = modelCapabilities(preset, model.name)
  const minimax = preset.id === 'minimax-api' || preset.id === 'minimax-plan'
  const effort = launchEffort(mode, model, capabilities, userArgs, minimax)
  const env = { ...parentEnv }
  for (const k of SCRUB_ENV_KEYS) delete env[k]
  env.ANTHROPIC_BASE_URL = preset.baseUrl
  env[preset.authEnv] = key
  for (const k of MODEL_VARS) env[k] = model.name
  if (mode === 'interactive') {
    // 让 Claude Code 忽略用户 settings 里的模型与地址；HOME / 配置目录不动，skills 与插件照常可用
    env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
    env.DISABLE_TELEMETRY = '1'
  } else {
    delete env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST
    // 后台调用放在隔离配置目录，不进用户的会话记录与用量；持久目录，dev-workflow 的 --resume 可以续上
    env.CLAUDE_CONFIG_DIR = path.join(modelsHome, 'claude-home')
    env.CLAUDE_CODE_MAX_RETRIES = maxRetries !== undefined ? String(maxRetries) : (parentEnv.CLAUDE_CODE_MAX_RETRIES || String(DEFAULT_PRINT_RETRIES))
  }
  const overlay = JSON.stringify({
    // GLM 要求开启思考；只覆盖本次启动，不改用户全局 settings。
    ...(minimax ? { alwaysThinkingEnabled: capabilities.alwaysThinkingEnabled } : preset.alwaysThinkingEnabled ? { alwaysThinkingEnabled: true } : {}),
    env: {
      ...(effort !== null ? { CLAUDE_CODE_EFFORT_LEVEL: effort } : {}),
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(model.contextTokens),
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(model.autoCompactWindow || Math.min(model.contextTokens, 786432)),
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(model.maxOutputTokens),
    },
  })
  // 后台模式不读任何 settings 文件；用 = 写法，避免空参数在进程列表里错位泄露环境变量
  const args = ['--settings', overlay, ...(mode === 'print' ? ['--setting-sources='] : []), ...userArgs]
  return { env, args }
}

module.exports = {
  SCRUB_ENV_KEYS,
  RESERVED_FLAGS_INTERACTIVE,
  RESERVED_FLAGS_PRINT,
  isPrintMode,
  wantsJson,
  checkReservedFlags,
  buildLaunch,
}
