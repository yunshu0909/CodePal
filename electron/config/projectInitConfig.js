/**
 * 新建项目初始化配置常量
 *
 * 负责：
 * - 模板定义（AGENTS.md / CLAUDE.md / MEMORY.md）
 * - 记忆协议源文件定义
 * - 模板 key 枚举与默认值
 * - Git 模式枚举（V1.2.5 旧版字符串模式 + V1.6.1 新版多选 gitConfig 对象）
 * - V1.2.5 → V1.6.1 数据迁移工具
 * - 项目名称校验规则
 * - 固定目录列表
 *
 * @module electron/config/projectInitConfig
 */

/**
 * 可用模板定义（copy 型：源文件 → 目标位置）
 * key 用于前后端交互，sourceFile 用于定位模板源文件
 */
const TEMPLATE_DEFINITIONS = Object.freeze({
  agents: {
    key: 'agents',
    sourceFile: 'AGENTS.md',
    targetSegments: ['AGENTS.md'],
  },
  claude: {
    key: 'claude',
    sourceFile: 'CLAUDE.md',
    targetSegments: ['CLAUDE.md'],
  },
  memory: {
    key: 'memory',
    sourceFile: 'MEMORY.md',
    targetSegments: ['MEMORY.md'],
  },
})

/**
 * 记忆协议源文件名
 * 勾选记忆系统时，将此文件内容追加到被勾选的指引文件（AGENTS.md / CLAUDE.md）末尾
 */
const MEMORY_PROTOCOL_SOURCE_FILE = 'memory-protocol.md'

const TEMPLATE_KEYS = Object.freeze(Object.keys(TEMPLATE_DEFINITIONS))
const DEFAULT_TEMPLATE_KEYS = Object.freeze(['agents', 'claude', 'memory'])

/**
 * V1.2.5 旧版 Git 模式字符串枚举（保留：现有 service/handler/UI 仍在使用）
 * T2/T3 完成后，新代码应改用 gitConfig 对象（见下方）
 */
const SUPPORTED_GIT_MODES = new Set(['root', 'code', 'none'])

const PROJECT_NAME_INVALID_CHARS = /[\\/:*?"<>|]/

/**
 * 固定创建的子目录（不受模板选项影响）
 * memory/ 目录由记忆系统选项控制，不在此列表中
 */
const PLANNED_DIRECTORIES = Object.freeze(['docs', 'code'])

// ============================================================
// V1.6.1: Git 多选模式（gitConfig 对象，替代旧 gitMode 字符串）
// ============================================================

/**
 * gitConfig 对象的合法字段名
 *  - rootGit: 是否在项目根目录初始化 git（管私人内容）
 *  - codeGit: 是否在 code/ 子目录初始化 git（管开源代码）
 *  - skipGit: 是否跳过 git 初始化（与 rootGit/codeGit 互斥）
 */
const GIT_CONFIG_KEYS = Object.freeze(['rootGit', 'codeGit', 'skipGit'])

/**
 * V1.6.1 默认 gitConfig：等价于 V1.2.5 的 'root' 模式
 * 保持默认行为对老用户透明
 */
const DEFAULT_GIT_CONFIG = Object.freeze({
  rootGit: true,
  codeGit: false,
  skipGit: false,
})

/**
 * "跳过 Git" 的固定 gitConfig（用于 Git 未安装的预检兜底）
 */
const SKIP_GIT_CONFIG = Object.freeze({
  rootGit: false,
  codeGit: false,
  skipGit: true,
})

/**
 * 校验 gitConfig 对象的合法性
 *
 * 合法条件：
 * 1. 是对象，且 rootGit/codeGit/skipGit 都是 boolean
 * 2. 互斥：skipGit=true 时 rootGit/codeGit 必须都为 false
 * 3. 不能全空：至少一个为 true
 *
 * @param {unknown} cfg
 * @returns {boolean}
 */
function isValidGitConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return false
  if (typeof cfg.rootGit !== 'boolean') return false
  if (typeof cfg.codeGit !== 'boolean') return false
  if (typeof cfg.skipGit !== 'boolean') return false
  // 互斥规则
  if (cfg.skipGit && (cfg.rootGit || cfg.codeGit)) return false
  // 不能全空（PRD §2.US-01 场景4 兜底逻辑）
  if (!cfg.rootGit && !cfg.codeGit && !cfg.skipGit) return false
  return true
}

/**
 * V1.2.5 旧 gitMode 字符串迁移到 V1.6.1 gitConfig 对象
 * 用于读取持久化的旧配置时一次性转换
 *
 * @param {'root'|'code'|'none'|unknown} legacyMode
 * @returns {{rootGit: boolean, codeGit: boolean, skipGit: boolean}} 总是返回合法 gitConfig
 */
function migrateGitMode(legacyMode) {
  switch (legacyMode) {
    case 'root': return { rootGit: true,  codeGit: false, skipGit: false }
    case 'code': return { rootGit: false, codeGit: true,  skipGit: false }
    case 'none': return { rootGit: false, codeGit: false, skipGit: true  }
    default:     return { ...DEFAULT_GIT_CONFIG }
  }
}

/**
 * gitConfig → 旧 gitMode 字符串（向后兼容用）
 *
 * 限制：双层模式（rootGit && codeGit）无法用单一字符串表达，返回 'root'（外层优先）。
 * 这只是 T1 阶段过渡兼容；T2 改完 service 后，调用方应直接用 gitConfig，避免有损转换。
 *
 * @param {{rootGit: boolean, codeGit: boolean, skipGit: boolean}} cfg
 * @returns {'root'|'code'|'none'}
 */
function gitConfigToLegacyMode(cfg) {
  if (!cfg) return 'root'
  if (cfg.skipGit) return 'none'
  if (cfg.codeGit && !cfg.rootGit) return 'code'
  // rootGit 单选 或 双层 → 都映射成 'root'（双层在 V1.2.5 字符串体系下不可表示）
  return 'root'
}

module.exports = {
  TEMPLATE_DEFINITIONS,
  MEMORY_PROTOCOL_SOURCE_FILE,
  TEMPLATE_KEYS,
  DEFAULT_TEMPLATE_KEYS,
  SUPPORTED_GIT_MODES,
  PROJECT_NAME_INVALID_CHARS,
  PLANNED_DIRECTORIES,
  // V1.6.1 新增（T1）：
  GIT_CONFIG_KEYS,
  DEFAULT_GIT_CONFIG,
  SKIP_GIT_CONFIG,
  isValidGitConfig,
  migrateGitMode,
  gitConfigToLegacyMode,
}
