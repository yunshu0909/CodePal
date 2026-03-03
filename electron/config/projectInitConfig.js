/**
 * 新建项目初始化配置常量
 *
 * 负责：
 * - 模板定义（AGENTS.md / CLAUDE.md / design-system.html）
 * - 模板 key 枚举与默认值
 * - Git 模式枚举
 * - 项目名称校验规则
 *
 * @module electron/config/projectInitConfig
 */

/**
 * 可用模板定义
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
  design: {
    key: 'design',
    sourceFile: 'design-system.html',
    targetSegments: ['design', 'design-system.html'],
  },
})

const TEMPLATE_KEYS = Object.freeze(Object.keys(TEMPLATE_DEFINITIONS))
const DEFAULT_TEMPLATE_KEYS = Object.freeze(['agents', 'claude', 'design'])
const SUPPORTED_GIT_MODES = new Set(['root', 'code', 'none'])
const PROJECT_NAME_INVALID_CHARS = /[\\/:*?"<>|]/

module.exports = {
  TEMPLATE_DEFINITIONS,
  TEMPLATE_KEYS,
  DEFAULT_TEMPLATE_KEYS,
  SUPPORTED_GIT_MODES,
  PROJECT_NAME_INVALID_CHARS,
}
