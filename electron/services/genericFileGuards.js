/**
 * 通用文件入口的用途校验
 *
 * 负责：
 * - 配置读写只认 `.config.json`；原文件已损坏时不覆盖、读取时也不改名
 * - 复制只允许「一个 Skill 文件夹 → 另一处的同名 Skill 文件夹」，上下级关系按真实路径判断
 * - 删除只允许已知 Skill 目录下的直接子项（含 SKILL.md 的目录或软链接），按真实路径判断
 * - 复制、删除本身也在这里执行：校验和执行用同一个规范化路径，软链接只删链接不删目标
 * - 渲染层 store 只开放用量目标的两个键
 *
 * 为什么不用「目录白名单」：仓库路径、新建项目路径都可以手动输入，白名单会误拒；
 * 这里按每个入口的真实用途收口，完整的「页面只传 ID」留给写入网关（架构优化路线 5）。
 *
 * @module electron/services/genericFileGuards
 */

const fs = require('fs/promises')
const path = require('path')

const CONFIG_FILE_NAME = '.config.json'

/** 渲染层可读写的 electron-store 键（唯一调用方：用量目标） */
const RENDERER_STORE_KEYS = new Set(['usageGoal', 'usageGoalDismissed'])

/** 允许删除 Skill 的目录（相对 home） */
const SKILL_ROOTS = [
  '.claude/skills',
  '.codex/skills',
  '.agents/skills',
  '.cursor/skills',
  '.trae/skills',
  'Documents/SkillManager',
]

function codedError(code) {
  return Object.assign(new Error(code), { code })
}

/**
 * 是否是配置文件路径（绝对路径 + 文件名为 .config.json）
 * @param {string} filePath - 已展开的路径
 * @returns {boolean}
 */
function isConfigPath(filePath) {
  return typeof filePath === 'string' && path.isAbsolute(filePath) && path.basename(filePath) === CONFIG_FILE_NAME
}

/**
 * 读配置：不存在返回 null；损坏返回 CONFIG_CORRUPTED（原文件原地不动）
 * @param {string} filePath
 * @returns {Promise<{exists: boolean, data: object|null, error: string|null}>}
 */
async function readConfigFile(filePath) {
  if (!isConfigPath(filePath)) throw codedError('CONFIG_PATH_NOT_ALLOWED')
  let content
  try {
    content = await fs.readFile(filePath, 'utf-8')
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, data: null, error: null }
    throw error
  }
  try {
    return { exists: true, data: JSON.parse(content), error: null }
  } catch {
    return { exists: true, data: null, error: 'CONFIG_CORRUPTED' }
  }
}

/**
 * 写配置前的检查：路径必须是 .config.json；原文件已损坏则拒绝覆盖（交给用户处理，不静默丢数据）
 * @param {string} filePath
 */
async function assertConfigWritable(filePath) {
  if (!isConfigPath(filePath)) throw codedError('CONFIG_PATH_NOT_ALLOWED')
  const current = await readConfigFile(filePath)
  if (current.error === 'CONFIG_CORRUPTED') throw codedError('CONFIG_CORRUPTED')
}

/**
 * 目录 / 文件的文件系统身份（设备号 + inode）：判断「是不是同一个东西」只看身份，
 * 不比较路径字符串（大小写、Unicode 写法、软链接都会让字符串比较出错）
 * @param {string} p
 * @returns {Promise<string>}
 */
async function identity(p) {
  const stat = await fs.stat(p)
  return `${stat.dev}:${stat.ino}`
}

/**
 * 一个已存在路径自身及其所有上级的身份集合
 * @param {string} existingPath - 真实路径（必须存在）
 * @returns {Promise<Set<string>>}
 */
async function lineageIdentities(existingPath) {
  const ids = new Set()
  let current = existingPath
  for (;;) {
    ids.add(await identity(current))
    const parent = path.dirname(current)
    if (parent === current) return ids
    current = parent
  }
}

/**
 * 最近一个已存在的上级（含自身）
 * @param {string} p - 绝对路径
 * @returns {Promise<string>}
 */
async function nearestExisting(p) {
  let current = path.resolve(p)
  for (;;) {
    try {
      await fs.stat(current)
      return current
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      const parent = path.dirname(current)
      if (parent === current) return current
      current = parent
    }
  }
}

/**
 * 是否是合法的 Skill 文件夹名：非空、单层、不是 . / ..（与 skillControlService.isSafeSkillName 一致；
 * .private 这类以点开头的 Skill 是合法的，工具配置目录由「已存在的目标必须是 Skill 目录」挡住）
 * @param {string} name
 * @returns {boolean}
 */
function isSkillFolderName(name) {
  return typeof name === 'string' && name.length > 0 && name !== '.' && name !== '..' && path.basename(name) === name && !name.includes('\0')
}

/**
 * 是否是 Skill 目录（含 SKILL.md 文件）
 * @param {string} dir
 * @returns {Promise<boolean>}
 */
async function hasSkillFile(dir) {
  try {
    return (await fs.stat(path.join(dir, 'SKILL.md'))).isFile()
  } catch {
    return false
  }
}

/**
 * 复制检查：源是一个 Skill 文件夹，目标是另一处的同名 Skill 文件夹（不存在、或已是 Skill 目录 / 软链接）
 * 上下级关系按文件身份判断，挡住经软链接上级、大小写 / Unicode 写法不同绕过的情况
 * @param {string} sourcePath - 已展开
 * @param {string} targetPath - 已展开
 * @returns {Promise<{source: string, target: string}>} 规范化后的路径，执行时必须用它们
 */
async function assertSkillCopy(sourcePath, targetPath) {
  if (!path.isAbsolute(sourcePath) || !path.isAbsolute(targetPath)) throw codedError('COPY_NOT_ALLOWED')
  const source = path.resolve(sourcePath)
  const target = path.resolve(targetPath)
  if (!isSkillFolderName(path.basename(target)) || path.basename(source) !== path.basename(target)) throw codedError('COPY_NOT_ALLOWED')
  // 源不是 Skill（不存在或没有 SKILL.md）统一按「源 Skill 不存在」返回，调用方沿用原有处理
  if (!(await hasSkillFile(source))) throw codedError('SOURCE_NOT_FOUND')
  const sourceId = await identity(source)
  // 目标是源本身或在源里面：目标最近的已存在上级（含自身）一路往上会碰到源
  if ((await lineageIdentities(await fs.realpath(await nearestExisting(target)))).has(sourceId)) throw codedError('COPY_NOT_ALLOWED')
  // 源在目标里面：目标已存在时，源一路往上会碰到目标
  try {
    const targetId = await identity(target)
    if ((await lineageIdentities(await fs.realpath(source))).has(targetId)) throw codedError('COPY_NOT_ALLOWED')
  } catch (error) {
    if (error.code === 'COPY_NOT_ALLOWED') throw error
    if (error.code !== 'ENOENT') throw codedError('COPY_NOT_ALLOWED')
  }
  try {
    const stat = await fs.lstat(target)
    if (!stat.isSymbolicLink() && !(stat.isDirectory() && (await hasSkillFile(target)))) throw codedError('COPY_NOT_ALLOWED')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error.code === 'COPY_NOT_ALLOWED' ? error : codedError('COPY_NOT_ALLOWED')
  }
  return { source, target }
}

/**
 * 校验并复制一个 Skill 文件夹
 * @param {string} sourcePath
 * @param {string} targetPath
 * @param {{force?: boolean}} [options]
 */
async function copySkillFolder(sourcePath, targetPath, options = {}) {
  const { source, target } = await assertSkillCopy(sourcePath, targetPath)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.cp(source, target, { recursive: true, force: options.force !== false })
}

/**
 * 删除检查：目标必须在某个已知 Skill 目录之下（任意深度，兼容嵌套的自定义仓库），自身不能是那些目录，
 * 且是软链接或含 SKILL.md 的目录；上下级关系按文件身份判断
 * @param {string} skillPath - 已展开
 * @param {string} homeDir
 * @returns {Promise<{path: string, isLink: boolean}|null>} 规范化路径与类型；不存在返回 null
 */
async function assertSkillDelete(skillPath, homeDir) {
  if (!path.isAbsolute(skillPath)) throw codedError('PATH_NOT_ALLOWED')
  const target = path.resolve(skillPath)
  if (!isSkillFolderName(path.basename(target))) throw codedError('PATH_NOT_ALLOWED')
  let realParent
  try {
    realParent = await fs.realpath(path.dirname(target))
  } catch {
    throw codedError('PATH_NOT_ALLOWED')
  }
  const rootIds = []
  for (const dir of SKILL_ROOTS) {
    try { rootIds.push(await identity(path.join(homeDir, dir))) } catch { /* 不存在的目录不参与 */ }
  }
  const parentLineage = await lineageIdentities(realParent)
  if (!rootIds.some((id) => parentLineage.has(id))) throw codedError('PATH_NOT_ALLOWED')
  let stat
  try {
    stat = await fs.lstat(target)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  if (stat.isSymbolicLink()) return { path: target, isLink: true }
  if (stat.isDirectory() && (await hasSkillFile(target))) return { path: target, isLink: false }
  throw codedError('PATH_NOT_ALLOWED')
}

/**
 * 校验并删除一个 Skill：软链接只 unlink 链接本身；目录递归删除。始终用规范化后的路径执行（不带尾斜杠）
 * @param {string} skillPath
 * @param {string} homeDir
 * @returns {Promise<void>} 目标不存在视为已删除
 */
async function deleteSkillPath(skillPath, homeDir) {
  const checked = await assertSkillDelete(skillPath, homeDir)
  if (!checked) return
  if (checked.isLink) await fs.unlink(checked.path)
  else await fs.rm(checked.path, { recursive: true, force: true })
}

/**
 * 渲染层是否可以读写这个 store 键
 * @param {unknown} key
 * @returns {boolean}
 */
function isRendererStoreKey(key) {
  return typeof key === 'string' && RENDERER_STORE_KEYS.has(key)
}

module.exports = {
  CONFIG_FILE_NAME,
  isConfigPath,
  readConfigFile,
  assertConfigWritable,
  assertSkillCopy,
  copySkillFolder,
  assertSkillDelete,
  deleteSkillPath,
  isRendererStoreKey,
}
