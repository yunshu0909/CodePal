/**
 * 新建项目页面常量
 *
 * 负责：
 * - 表单默认值与预览断点
 * - 初始化内容勾选项定义（TEMPLATE_OPTIONS）
 * - Git 模式定义（GIT_MODES）
 * - 数据驱动的预览树节点（TREE_NODES）
 *
 * @module pages/projectInit/projectInitConstants
 */

export const DEFAULT_TARGET_PATH = '~/Documents/projects/'
export const PROJECT_NAME_INVALID_CHARS = /[\\/:*?"<>|]/
export const PREVIEW_COLLAPSE_BREAKPOINT = 1024
export const PREVIEW_MEDIA_QUERY = `(max-width: ${PREVIEW_COLLAPSE_BREAKPOINT}px)`

export const DEFAULT_SUCCESS_MODAL_SUMMARY = Object.freeze({
  projectPath: '',
  createdDirectoryCount: 0,
  configStatus: '未生成',
})

/**
 * 初始化内容勾选项
 * isGuideFile=true 的项是「指引文件」，记忆系统依赖至少一个
 */
export const TEMPLATE_OPTIONS = [
  {
    key: 'agents',
    label: 'AGENTS.md',
    desc: 'Codex 项目指引文件 — 协作方式、工作单元流程、Git 工作流、文件体量信号，让 Codex 按统一标准干活',
    isGuideFile: true,
  },
  {
    key: 'claude',
    label: 'CLAUDE.md',
    desc: 'Claude Code 项目指引文件 — 与 AGENTS.md 内容一致，让 Claude Code 按统一标准干活',
    isGuideFile: true,
  },
  {
    key: 'memory',
    label: '记忆系统',
    desc: '生成 MEMORY.md + memory/ 目录，让 AI 跨对话记住项目上下文、偏好和关键决策。首次对话时 AI 会引导你完成初始化',
    depHint: '需要至少启用一个指引文件（AGENTS.md 或 CLAUDE.md）',
    isGuideFile: false,
  },
  {
    key: 'specs',
    label: '工作单元结构（含示例）',
    desc: '生成 specs/ 工作单元目录 + 一个填好的示例单元（plan → design → prd → test），教 AI 按链路干活。可随时删除',
    isGuideFile: false,
  },
  {
    key: 'gitignore',
    label: '.gitignore',
    desc: '生成通用忽略规则（node_modules / dist / .env 等），避免误纳入版本',
    isGuideFile: false,
  },
]

/** 默认全部勾选 */
export const DEFAULT_TEMPLATE_SELECTION = Object.freeze({
  agents: true,
  claude: true,
  memory: true,
  specs: true,
  gitignore: true,
})

export const GIT_MODES = [
  { key: 'root', icon: '🌿', title: '根目录初始化', desc: '全项目纳入版本控制' },
  { key: 'code', icon: '📦', title: '仅代码目录', desc: '只在 code/ 文件夹初始化' },
  { key: 'none', icon: '🚫', title: '跳过 Git', desc: '稍后手动执行 git init' },
]

/**
 * 预览树节点（数据驱动）。新增节点只改这里，不动渲染逻辑。
 * visibleWhen(s) 的 s = { templateSelection, gitMode }；缺省视为始终显示。
 * kind: 'file' → 📄 / 'dir' → 📁；success: .git 等绿色高亮；indent: 1 或 2。
 */
export const TREE_NODES = [
  { key: 'root-git', name: '.git/', kind: 'dir', indent: 1, success: true, annotation: '版本控制', visibleWhen: (s) => s.gitMode === 'root' },
  { key: 'gitignore', name: '.gitignore', kind: 'file', indent: 1, annotation: '忽略规则', testId: 'project-tree-gitignore', visibleWhen: (s) => s.templateSelection.gitignore },
  { key: 'agents', name: 'AGENTS.md', kind: 'file', indent: 1, annotation: 'Codex 指引', testId: 'project-tree-agents', visibleWhen: (s) => s.templateSelection.agents },
  { key: 'claude', name: 'CLAUDE.md', kind: 'file', indent: 1, annotation: 'Claude Code 指引', testId: 'project-tree-claude', visibleWhen: (s) => s.templateSelection.claude },
  { key: 'memory-file', name: 'MEMORY.md', kind: 'file', indent: 1, annotation: '长期记忆', testId: 'project-tree-memory', visibleWhen: (s) => s.templateSelection.memory },
  { key: 'memory-dir', name: 'memory/', kind: 'dir', indent: 1, annotation: '每日记忆', testId: 'project-tree-memory-dir', visibleWhen: (s) => s.templateSelection.memory },
  { key: 'specs', name: 'specs/', kind: 'dir', indent: 1, annotation: '工作单元', testId: 'project-tree-specs', visibleWhen: (s) => s.templateSelection.specs },
  { key: 'specs-example', name: '_example-示例功能/', kind: 'dir', indent: 2, annotation: '示例单元', testId: 'project-tree-specs-example', visibleWhen: (s) => s.templateSelection.specs },
  { key: 'docs', name: 'docs/', kind: 'dir', indent: 1, annotation: '调研 / 决策记录' },
  { key: 'code', name: 'code/', kind: 'dir', indent: 1, annotation: '项目代码' },
  { key: 'code-git', name: '.git/', kind: 'dir', indent: 2, success: true, annotation: '版本控制', visibleWhen: (s) => s.gitMode === 'code' },
]
