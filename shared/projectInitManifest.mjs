/**
 * 新建项目「会生成什么」的唯一清单（主进程与渲染层共用）
 *
 * 负责：
 * - 按 Git 方式与代码文件夹名算出要生成的每一项（文件夹 / 文件、模板来源、说明、仓库标签）
 * - 给出外层保留名（代码文件夹不能和它们同名）
 * - 名称合法性的纯规则（项目名称、代码文件夹名共用）
 *
 * 页面目录树和主进程实际生成都读这一份，避免两边各写一份对不上。
 * 纯函数、无副作用，不依赖 Node 或浏览器 API。
 *
 * @module shared/projectInitManifest
 */

/** Git 方式：双层（外层私人仓 + 代码仓）/ 只给代码建仓 / 跳过 */
export const GIT_MODES = Object.freeze(['dual', 'code', 'none'])
export const DEFAULT_GIT_MODE = 'dual'
export const DEFAULT_CODE_DIR = 'code'

/** 名字里不能出现的字符（文件系统非法字符），以及 . 和 .. */
export const INVALID_NAME_CHARS = /[\\/:*?"<>|]/

/**
 * 名字是否合法（非空、去首尾空格后不是 . / ..、不含非法字符）
 * @param {string} name
 * @returns {boolean}
 */
export function isValidName(name) {
  const trimmed = typeof name === 'string' ? name.trim() : ''
  if (!trimmed || trimmed === '.' || trimmed === '..') return false
  return !INVALID_NAME_CHARS.test(trimmed)
}

/**
 * 代码文件夹名：空时用默认 code
 * @param {string} name
 * @returns {string}
 */
export function resolveCodeDir(name) {
  const trimmed = typeof name === 'string' ? name.trim() : ''
  return trimmed || DEFAULT_CODE_DIR
}

/**
 * 外层清单项（不含代码文件夹）。
 * path：相对项目根；kind：dir / file；source：模板目录里的来源（空文件夹没有）；
 * template：写入时替换 {{PROJECT_NAME}} / {{CODE_DIR}}；note：目录树右侧说明；
 * when：哪些 Git 方式下生成（缺省 = 都生成）。
 */
const OUTER_ITEMS = Object.freeze([
  { path: 'AGENTS.md', kind: 'file', source: 'AGENTS.md', template: true, note: '协议（Codex 读）' },
  { path: 'CLAUDE.md', kind: 'file', source: 'CLAUDE.md', template: true, note: '协议（Claude Code 读，两份一致）' },
  { path: 'MEMORY.md', kind: 'file', source: 'MEMORY.md', note: '项目总览' },
  { path: 'memory', kind: 'dir', note: '记忆' },
  { path: 'memory/topics', kind: 'dir', note: '主题认知' },
  { path: 'memory/archive', kind: 'dir', note: '历史原文' },
  { path: 'ISSUES.md', kind: 'file', source: 'ISSUES.md', note: '需求池总览，自动生成' },
  { path: 'issues', kind: 'dir', note: '需求池：一条一个文件' },
  { path: 'issues/README.md', kind: 'file', source: 'issues/README.md', note: '规则' },
  { path: 'issues/收件箱.md', kind: 'file', source: 'issues/收件箱.md', note: '兜底，平时是空的' },
  { path: 'issues/_模板.md', kind: 'file', source: 'issues/_模板.md', note: '新建用的模板' },
  { path: 'issues/未关闭', kind: 'dir', note: '' },
  { path: 'issues/已完成', kind: 'dir', note: '' },
  { path: 'issues/已作废', kind: 'dir', note: '' },
  { path: 'specs', kind: 'dir', note: '工作单元' },
  { path: 'specs/README.md', kind: 'file', source: 'specs/README.md', note: '版本索引' },
  { path: 'docs', kind: 'dir', note: '沉淀' },
  { path: 'docs/README.md', kind: 'file', source: 'docs/README.md', note: '沉淀规则' },
  { path: 'docs/plan', kind: 'dir', note: '滚动计划' },
  { path: 'docs/research', kind: 'dir', note: '调研' },
  { path: 'docs/archive', kind: 'dir', note: '归档' },
  { path: 'docs/issue-check.py', kind: 'file', source: 'docs/issue-check.py', note: '需求池工具' },
  { path: 'docs/protocol-check.py', kind: 'file', source: 'docs/protocol-check.py', note: '协议检查' },
  { path: '.dev-workflow', kind: 'dir', note: '', when: ['dual', 'code'] },
  {
    path: '.dev-workflow/project-defaults.json', kind: 'file', source: 'dev-workflow/project-defaults.json',
    note: 'dev-workflow 用：哪些文件不能进代码仓', when: ['dual', 'code'],
  },
  { path: '.gitignore', kind: 'file', source: 'gitignore-outer.tpl', template: true, note: '外层仓不收代码文件夹', when: ['dual'] },
])

/** 外层会生成的顶层名字：代码文件夹不能和它们同名（比较不分大小写） */
export const OUTER_RESERVED_NAMES = Object.freeze(
  [...new Set(OUTER_ITEMS.map((item) => item.path.split('/')[0]))],
)

/**
 * 代码文件夹名是否和外层撞名
 * @param {string} codeDir
 * @returns {boolean}
 */
export function conflictsWithOuter(codeDir) {
  const lower = resolveCodeDir(codeDir).toLowerCase()
  return OUTER_RESERVED_NAMES.some((name) => name.toLowerCase() === lower)
}

/**
 * 按选项算出要生成的全部项（顺序即目录树顺序、即生成顺序）
 * @param {{gitMode?: string, codeDir?: string}} [options]
 * @returns {Array<{path: string, kind: 'dir'|'file', source?: string, template?: boolean, note: string, tag?: 'private'|'code'}>}
 */
export function buildManifest({ gitMode = DEFAULT_GIT_MODE, codeDir } = {}) {
  const mode = GIT_MODES.includes(gitMode) ? gitMode : DEFAULT_GIT_MODE
  const code = resolveCodeDir(codeDir)
  const items = OUTER_ITEMS
    .filter((item) => !item.when || item.when.includes(mode))
    .map(({ when, ...rest }) => ({ ...rest }))
  items.push({ path: code, kind: 'dir', note: '代码', tag: mode === 'none' ? undefined : 'code' })
  if (mode !== 'none') {
    items.push({ path: `${code}/.gitignore`, kind: 'file', source: 'gitignore-code.tpl', note: '代码仓的忽略规则（依赖、密钥等）' })
  }
  return items
}

/**
 * 目录树（给页面画）：根节点 + 按层级排好的行；path 是相对项目根的完整路径，同一棵树里唯一（页面拿它当 key）
 * @param {{projectName?: string, gitMode?: string, codeDir?: string}} [options]
 * @returns {{root: {name: string, tag?: 'private', note: string}, rows: Array<{path: string, name: string, depth: number, kind: 'dir'|'file', note: string, tag?: 'code'}>}}
 */
export function buildTree({ projectName, gitMode = DEFAULT_GIT_MODE, codeDir } = {}) {
  const name = typeof projectName === 'string' && projectName.trim() ? projectName.trim() : '项目名称'
  const rows = buildManifest({ gitMode, codeDir }).map((item) => {
    const parts = item.path.split('/')
    return {
      path: item.path,
      name: `${parts[parts.length - 1]}${item.kind === 'dir' ? '/' : ''}`,
      depth: parts.length,
      kind: item.kind,
      note: item.note,
      tag: item.tag,
    }
  })
  return {
    root: { name: `${name}/`, tag: gitMode === 'dual' ? 'private' : undefined, note: '协议、需求、记录和记忆' },
    rows,
  }
}
