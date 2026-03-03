/**
 * 技能目录扫描服务
 *
 * 负责：
 * - 扫描目录获取技能列表（含 SKILL.md 解析）
 * - 统计目录中的技能数量
 * - 扫描自定义路径下各工具子目录的技能分布
 * - 解析 SKILL.md 提取名称和描述
 *
 * @module electron/services/skillScanService
 */

const path = require('path')
const fs = require('fs/promises')

/**
 * 解析 SKILL.md 内容提取名称和描述
 * 优先从 YAML frontmatter 提取，如果没有则回退到 Markdown 标题
 * @param {string} content - SKILL.md 文件内容
 * @returns {{name: string, desc: string}}
 */
function parseSkillMd(content) {
  let name = ''
  let desc = ''

  // Try to parse YAML frontmatter first
  const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/)
  if (frontmatterMatch) {
    const frontmatter = frontmatterMatch[1]

    const nameMatch = frontmatter.match(/^name:\s*(.+)$/m)
    if (nameMatch) {
      name = nameMatch[1].trim()
    }

    const descMatch = frontmatter.match(/^description:\s*(.+)$/m)
    if (descMatch) {
      desc = descMatch[1].trim()
    }

    if (name && desc) {
      return { name, desc }
    }
  }

  // Fallback: parse Markdown content
  const lines = content.split('\n')

  if (!name) {
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.startsWith('# ')) {
        name = trimmed.slice(2).trim()
        break
      }
    }
  }

  if (!desc) {
    let foundName = false
    for (const line of lines) {
      const trimmed = line.trim()
      if (!foundName) {
        if (trimmed.startsWith('# ')) {
          foundName = true
        }
        continue
      }
      if (trimmed && !trimmed.startsWith('#')) {
        desc = trimmed
        break
      }
    }
  }

  if (!name) {
    name = 'Unnamed Skill'
  }

  return { name, desc }
}

/**
 * 检查路径是否存在
 * @param {string} filepath - 要检查的路径
 * @returns {Promise<boolean>}
 */
async function fileExists(filepath) {
  try {
    await fs.access(filepath)
    return true
  } catch {
    return false
  }
}

/**
 * 扫描目录获取技能列表（含 SKILL.md 解析）
 * @param {string} expandedPath - 已展开的绝对路径
 * @returns {Promise<{success: boolean, skills: Array, error: string|null}>}
 */
async function scanSkillDirectory(expandedPath) {
  const exists = await fileExists(expandedPath)
  if (!exists) {
    return { success: true, skills: [], error: 'DIRECTORY_NOT_FOUND' }
  }

  const stat = await fs.stat(expandedPath)
  if (!stat.isDirectory()) {
    return { success: false, error: 'NOT_A_DIRECTORY', skills: [] }
  }

  const entries = await fs.readdir(expandedPath, { withFileTypes: true })
  const skills = []

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const skillMdPath = path.join(expandedPath, entry.name, 'SKILL.md')
      const skillMdExists = await fileExists(skillMdPath)

      if (skillMdExists) {
        try {
          const content = await fs.readFile(skillMdPath, 'utf-8')
          const { name, desc } = parseSkillMd(content)
          skills.push({
            name: entry.name,
            displayName: name || entry.name,
            desc: desc || ''
          })
        } catch (err) {
          // 无法读取 SKILL.md 时仍包含该技能，使用文件夹名
          skills.push({
            name: entry.name,
            displayName: entry.name,
            desc: ''
          })
        }
      }
    }
  }

  return { success: true, skills, error: null }
}

/**
 * 统计目录中的技能数量（轻量版，不解析 SKILL.md 内容）
 * @param {string} expandedPath - 已展开的绝对路径
 * @returns {Promise<number>} 技能数量
 */
async function countSkillsInDirectory(expandedPath) {
  const exists = await fileExists(expandedPath)
  if (!exists) return 0

  try {
    const entries = await fs.readdir(expandedPath, { withFileTypes: true })
    let count = 0

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillMdPath = path.join(expandedPath, entry.name, 'SKILL.md')
        if (await fileExists(skillMdPath)) {
          count++
        }
      }
    }

    return count
  } catch {
    return 0
  }
}

/**
 * 工具子目录映射（key 与 toolDefinitions.id 一致）
 */
const TOOL_SUBDIRS = {
  'claude-code': '.claude/skills',
  'codex': '.codex/skills',
  'cursor': '.cursor/skills',
  'trae': '.trae/skills'
}

/**
 * 扫描自定义路径下各工具子目录的技能分布
 * @param {string} expandedPath - 已展开的绝对路径
 * @returns {Promise<{success: boolean, skills: Object, error: string|null}>}
 *   skills 格式: { 'claude-code': 5, codex: 3 }
 */
async function scanCustomPathSkills(expandedPath) {
  const exists = await fileExists(expandedPath)
  if (!exists) {
    return { success: false, skills: {}, error: 'PATH_NOT_FOUND' }
  }

  const stat = await fs.stat(expandedPath)
  if (!stat.isDirectory()) {
    return { success: false, skills: {}, error: 'NOT_A_DIRECTORY' }
  }

  const skills = {}

  for (const [toolId, subdir] of Object.entries(TOOL_SUBDIRS)) {
    const toolPath = path.join(expandedPath, subdir)
    const count = await countSkillsInDirectory(toolPath)
    if (count > 0) {
      skills[toolId] = count
    }
  }

  return { success: true, skills, error: null }
}

/**
 * 预设工具定义（与渲染进程 toolDefinitions 保持一致）
 */
const PRESET_TOOLS = [
  { id: 'claude-code', name: 'Claude Code', icon: 'CC', iconClass: 'cc', path: '~/.claude/skills/' },
  { id: 'codex', name: 'CodeX', icon: 'CX', iconClass: 'cx', path: '~/.codex/skills/' },
  { id: 'cursor', name: 'Cursor', icon: 'CU', iconClass: 'cu', path: '~/.cursor/skills/' },
  { id: 'trae', name: 'Trae', icon: 'TR', iconClass: 'tr', path: '~/.trae/skills/' }
]

module.exports = {
  parseSkillMd,
  scanSkillDirectory,
  countSkillsInDirectory,
  scanCustomPathSkills,
  PRESET_TOOLS,
}
