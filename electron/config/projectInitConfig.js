/**
 * 新建项目初始化配置常量
 *
 * 负责：
 * - 模板定义（AGENTS.md / CLAUDE.md / MEMORY.md）
 * - 记忆协议源文件定义
 * - 模板 key 枚举与默认值
 * - Git 模式枚举
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
const SUPPORTED_GIT_MODES = new Set(['root', 'code', 'none'])
const PROJECT_NAME_INVALID_CHARS = /[\\/:*?"<>|]/

/**
 * 固定创建的子目录（不受模板选项影响）
 * memory/ 目录由记忆系统选项控制，不在此列表中
 */
const PLANNED_DIRECTORIES = Object.freeze(['docs', 'code'])

module.exports = {
  TEMPLATE_DEFINITIONS,
  MEMORY_PROTOCOL_SOURCE_FILE,
  TEMPLATE_KEYS,
  DEFAULT_TEMPLATE_KEYS,
  SUPPORTED_GIT_MODES,
  PROJECT_NAME_INVALID_CHARS,
  PLANNED_DIRECTORIES,
}
