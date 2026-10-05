/**
 * 第三方模型接入 · 供应商预设
 *
 * 负责：
 * - 每家供应商的 Anthropic 兼容地址、认证环境变量、Key 前缀、默认模型与参数
 * - 已知模型的上限；用户新加的未知模型用这家的默认值
 *
 * 数值来源：DeepSeek 官方定价页（2026-09-26 取数：deepseek-flash 上下文 1M、输出 384K）；
 * 自动压缩窗口沿用 Nexus 实测值（Nexus internal/domain/claude_profile.go:65-67）。
 * 输出上限：Claude Code 发请求时 max_tokens 最多 128,000（2026-09-27 抓包实测，设更大也被压回），所以默认与上限都取 128,000。
 * 思考强度：DeepSeek 只认 low / high / max，medium、xhigh 会被它当成 high（官方「思考模式」文档），所以只给三档。
 *
 * @module electron/modules/models/presets
 */

/** Claude Code 请求里 max_tokens 的上限；输出上限不能超过它 */
const MAX_OUTPUT_CAP = 128000

const DEEPSEEK_DEFAULTS = Object.freeze({
  effort: 'max',
  contextTokens: 1000000,
  maxOutputTokens: MAX_OUTPUT_CAP,
  autoCompactWindow: 786432,
})

// MiniMax 官方 Claude Code 文档：M3 默认关闭思考；Flash 强制思考且支持五档。
const MINIMAX_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max'])
const MINIMAX_DEFAULTS = Object.freeze({
  effort: null,
  contextTokens: 1000000,
  maxOutputTokens: MAX_OUTPUT_CAP,
  autoCompactWindow: 786432,
})
const MINIMAX_FLASH_DEFAULTS = Object.freeze({ ...MINIMAX_DEFAULTS, effort: 'max' })
const MINIMAX_MODELS = Object.freeze({
  'MiniMax-M3': MINIMAX_DEFAULTS,
  'MiniMax-M3.1-Flash-Preview': MINIMAX_FLASH_DEFAULTS,
})

function minimaxPreset(id, name, type, defaultModel) {
  return Object.freeze({
    id, name, type, defaultModel,
    baseUrl: 'https://api.minimax.cn/anthropic',
    authEnv: 'ANTHROPIC_API_KEY',
    keyPrefix: '',
    efforts: defaultModel === 'MiniMax-M3' ? Object.freeze([]) : MINIMAX_EFFORTS,
    defaults: MINIMAX_DEFAULTS,
    models: MINIMAX_MODELS,
  })
}

/**
 * 新渠道共享 Claude Code 参数边界，各自持有不可变默认值。
 * @param {object} config - 官方地址、认证方式与模型
 * @returns {object} 不可变渠道预设
 */
function channelPreset(config) {
  const { maxOutputTokens = MAX_OUTPUT_CAP, efforts = ['low', 'high', 'max'], ...meta } = config
  const defaults = Object.freeze({
    effort: 'high',
    contextTokens: 1048576,
    maxOutputTokens,
    autoCompactWindow: 786432,
  })
  return Object.freeze({
    ...meta,
    efforts: Object.freeze(efforts),
    defaults,
    models: Object.freeze({ [meta.defaultModel]: defaults }),
  })
}

const PRESETS = Object.freeze({
  deepseek: Object.freeze({
    id: 'deepseek',
    name: 'DeepSeek',
    type: '按量',
    baseUrl: 'https://api.deepseek.com/anthropic',
    authEnv: 'ANTHROPIC_AUTH_TOKEN',
    keyPrefix: 'sk-',
    defaultModel: 'deepseek-flash',
    // 这家真正区分的思考强度（照 Claude Code 原值，不翻译）
    efforts: Object.freeze(['low', 'high', 'max']),
    defaults: DEEPSEEK_DEFAULTS,
    models: Object.freeze({
      'deepseek-flash': DEEPSEEK_DEFAULTS,
      'deepseek-v4-pro': DEEPSEEK_DEFAULTS,
    }),
  }),
  // 官方 Claude Code 接入文档（2026-09-28）；API 和套餐即使同址也独立保管 Key。
  // https://mimo.mi.com/docs/integration/claudecode
  'mimo-api': channelPreset({
    id: 'mimo-api', name: 'MiMo API', type: '按量',
    baseUrl: 'https://api.xiaomimimo.com/anthropic',
    authEnv: 'ANTHROPIC_AUTH_TOKEN', keyPrefix: 'sk-',
    defaultModel: 'mimo-v2.6-pro', efforts: ['high'],
  }),
  // https://docs.bigmodel.cn/cn/guide/develop/claude/introduction
  'zhipu-api': channelPreset({
    id: 'zhipu-api', name: '智谱 API', type: '按量',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    authEnv: 'ANTHROPIC_API_KEY', keyPrefix: '',
    defaultModel: 'glm-5.3', alwaysThinkingEnabled: true,
  }),
  // https://platform.kimi.com/docs/guide/claude-code-kimi
  'kimi-api': channelPreset({
    id: 'kimi-api', name: 'Kimi API', type: '按量',
    baseUrl: 'https://api.moonshot.cn/anthropic',
    authEnv: 'ANTHROPIC_AUTH_TOKEN', keyPrefix: '',
    defaultModel: 'kimi-k3', maxOutputTokens: 32768,
  }),
  // https://docs.bigmodel.cn/cn/coding-plan/quick-start
  'zhipu-coding': channelPreset({
    id: 'zhipu-coding', name: '智谱 Coding Plan', type: '套餐',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    authEnv: 'ANTHROPIC_API_KEY', keyPrefix: '',
    defaultModel: 'glm-5.3', alwaysThinkingEnabled: true,
  }),
  // https://www.kimi.com/code/docs/en/third-party-tools/claude-code.html
  'kimi-coding': channelPreset({
    id: 'kimi-coding', name: 'Kimi Coding Plan', type: '套餐',
    baseUrl: 'https://api.kimi.com/coding/',
    authEnv: 'ANTHROPIC_API_KEY', keyPrefix: '',
    defaultModel: 'kimi-for-coding', maxOutputTokens: 32768,
  }),
  'minimax-api': minimaxPreset('minimax-api', 'MiniMax API', '按量', 'MiniMax-M3'),
  'minimax-plan': minimaxPreset('minimax-plan', 'MiniMax M Plan', '套餐', 'MiniMax-M3.1-Flash-Preview'),
})

/**
 * 取某个模型的默认参数：预设里有就用它自己的，没有用这家的默认
 * @param {object} preset - PRESETS 里的一家
 * @param {string} name - 模型名
 * @returns {{effort: string, contextTokens: number, maxOutputTokens: number, autoCompactWindow: number}}
 */
function modelDefaults(preset, name) {
  const known = Object.keys(preset.models).find((k) => k.toLowerCase() === String(name).toLowerCase())
  return { ...(known ? preset.models[known] : preset.defaults) }
}

/** 模型能力在两个 MiniMax 渠道间相同；未知型号不推断可调档位。 */
function modelCapabilities(preset, name) {
  if (preset.id === 'minimax-api' || preset.id === 'minimax-plan') {
    const flash = String(name).toLowerCase() === 'minimax-m3.1-flash-preview'
    return { efforts: flash ? MINIMAX_EFFORTS : [], alwaysThinkingEnabled: flash }
  }
  return { efforts: preset.efforts, alwaysThinkingEnabled: preset.alwaysThinkingEnabled }
}

module.exports = { PRESETS, MAX_OUTPUT_CAP, modelDefaults, modelCapabilities }
