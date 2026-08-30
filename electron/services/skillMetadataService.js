/**
 * Skill 与 Plugin 本地元数据读取服务
 *
 * 负责：
 * - 只读解析 SKILL.md frontmatter 中的名称与描述
 * - 读取 Plugin manifest 的公开说明
 * - 枚举 Plugin 明确声明的 skills 目录，不递归猜测 cache
 * - 用 ready / missing / unavailable 表达元数据可信度
 *
 * @module electron/services/skillMetadataService
 */

const fs = require('fs/promises')
const path = require('path')

const PLUGIN_MANIFEST_PATHS = Object.freeze([
  ['.codex-plugin', 'plugin.json'],
  ['.claude-plugin', 'plugin.json'],
  ['plugin.json'],
])

function cleanScalar(value) {
  const trimmed = String(value || '').trim()
  if (!trimmed) return ''
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try { return JSON.parse(trimmed) } catch { return trimmed.slice(1, -1) }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replace(/''/g, "'")
  return trimmed
}

/**
 * 解析 SKILL.md 顶部的简单 YAML frontmatter。
 * @param {string} markdown SKILL.md 文本
 * @returns {{name:string,description:string}}
 */
function parseSkillFrontmatter(markdown) {
  const text = String(markdown || '').replace(/^\uFEFF/, '')
  if (!text.startsWith('---')) return { name: '', description: '' }
  const lines = text.split(/\r?\n/)
  const closingIndex = lines.slice(1).findIndex((line) => line.trim() === '---')
  if (closingIndex < 0) return { name: '', description: '' }
  const frontmatter = lines.slice(1, closingIndex + 1)
  const values = {}

  for (let index = 0; index < frontmatter.length; index += 1) {
    const match = frontmatter[index].match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/)
    if (!match) continue
    const [, key, rawValue] = match
    if (rawValue === '>' || rawValue === '|') {
      const chunks = []
      while (index + 1 < frontmatter.length && /^\s+/.test(frontmatter[index + 1])) {
        chunks.push(frontmatter[index + 1].trim())
        index += 1
      }
      values[key] = rawValue === '>' ? chunks.join(' ') : chunks.join('\n')
    } else {
      values[key] = cleanScalar(rawValue)
    }
  }
  return { name: values.name || '', description: values.description || '' }
}

/**
 * 读取单个 Skill 的安全元数据。
 * @param {string} skillPath Skill 根目录
 * @param {object} deps 测试依赖
 * @returns {Promise<{name:string,description:string,metadataStatus:string}>}
 */
async function readSkillMetadata(skillPath, deps = {}) {
  try {
    const content = await (deps.readFileFn || fs.readFile)(path.join(skillPath, 'SKILL.md'), 'utf8')
    const parsed = parseSkillFrontmatter(content)
    return {
      name: parsed.name,
      description: parsed.description,
      metadataStatus: parsed.name || parsed.description ? 'ready' : 'missing',
    }
  } catch (error) {
    return {
      name: '',
      description: '',
      metadataStatus: error?.code === 'ENOENT' ? 'missing' : 'unavailable',
    }
  }
}

async function readFirstManifest(rootPath, deps = {}) {
  const readFileFn = deps.readFileFn || fs.readFile
  for (const segments of PLUGIN_MANIFEST_PATHS) {
    try {
      const parsed = JSON.parse(await readFileFn(path.join(rootPath, ...segments), 'utf8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch (error) {
      if (error?.code !== 'ENOENT') return { __codepalUnavailable: true }
    }
  }
  return null
}

function pluginDescription(manifest) {
  return [
    manifest?.description,
    manifest?.interface?.longDescription,
    manifest?.interface?.shortDescription,
    manifest?.metadata?.description,
  ].find((value) => typeof value === 'string' && value.trim())?.trim() || ''
}

async function readChildSkills(rootPath, deps = {}) {
  const skillsRoot = path.join(rootPath, 'skills')
  let entries
  try {
    entries = await (deps.readdirFn || fs.readdir)(skillsRoot, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return { childSkills: [], unavailable: false }
    return { childSkills: [], unavailable: true }
  }

  const childSkills = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const skillPath = path.join(skillsRoot, entry.name)
    try {
      await (deps.accessFn || fs.access)(path.join(skillPath, 'SKILL.md'))
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      return { childSkills, unavailable: true }
    }
    const metadata = await readSkillMetadata(skillPath, deps)
    if (metadata.metadataStatus === 'unavailable') return { childSkills, unavailable: true }
    childSkills.push({
      name: metadata.name || entry.name,
      description: metadata.description,
    })
  }
  return { childSkills, unavailable: false }
}

/**
 * 读取 Plugin 的 manifest 和其明确 skills 子目录。
 * @param {string} rootPath 官方 CLI 返回的本地 Plugin 根目录
 * @param {object} deps 测试依赖
 * @returns {Promise<{description:string,childSkills:Array,metadataStatus:string}>}
 */
async function readPluginMetadata(rootPath, deps = {}) {
  if (!rootPath || !path.isAbsolute(rootPath)) {
    return { description: '', childSkills: [], metadataStatus: 'unavailable' }
  }
  try {
    await (deps.accessFn || fs.access)(rootPath)
  } catch {
    return { description: '', childSkills: [], metadataStatus: 'unavailable' }
  }

  const [manifest, skills] = await Promise.all([
    readFirstManifest(rootPath, deps),
    readChildSkills(rootPath, deps),
  ])
  if (manifest?.__codepalUnavailable || skills.unavailable) {
    return { description: '', childSkills: skills.childSkills, metadataStatus: 'unavailable' }
  }
  const description = pluginDescription(manifest)
  return {
    description,
    childSkills: skills.childSkills,
    metadataStatus: manifest || skills.childSkills.length > 0 ? 'ready' : 'missing',
  }
}

module.exports = {
  parseSkillFrontmatter,
  readSkillMetadata,
  readPluginMetadata,
}
