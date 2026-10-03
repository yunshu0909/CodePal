/**
 * Skills 要处理（specs/v2.1.11-Skills要处理-实现）测试共用的假家目录
 *
 * 负责：
 * - 在 mkdtemp 建的临时目录里造家目录、资产库、两个工具的全局目录和项目目录
 * - 写一个 Skill（SKILL.md + 可选的其他文件）、建链接、读回一个目录的全部文件
 * - Codex 官方接口替身：开关记在内存，记下每次调用，不碰 config.toml、不起真实 Codex
 * 所有写入只发生在临时目录，测试结束整个删掉。
 *
 * @module tests/skills/inbox/helpers
 */

import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 造一个假家目录
 * @param {string} label - 临时目录前缀里的标记
 * @returns {Promise<{sandbox: string, homeDir: string, repoPath: string, dataDir: string, cleanup: () => Promise<void>}>}
 */
export async function makeHome(label, { createRepo = true } = {}) {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), `codepal-inbox-${label}-`))
  const homeDir = path.join(sandbox, 'home')
  const repoPath = path.join(homeDir, 'Documents', 'SkillManager')
  await fs.mkdir(homeDir, { recursive: true })
  if (createRepo) await fs.mkdir(repoPath, { recursive: true })
  return {
    sandbox,
    homeDir,
    repoPath,
    dataDir: path.join(homeDir, 'Library', 'Application Support', 'CodePal', 'skills'),
    cleanup: () => fs.rm(sandbox, { recursive: true, force: true }),
  }
}

/**
 * 写一个 Skill 目录
 * @param {string} root - 放 Skill 的上级目录
 * @param {string} name
 * @param {string} body - SKILL.md 正文（也当说明）
 * @param {Record<string,string>} [files] - 其他文件：相对路径 → 内容
 * @returns {Promise<string>} Skill 目录
 */
export async function writeSkill(root, name, body = name, files = {}) {
  const dir = path.join(root, name)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${body}\n---\n\n${body}\n`)
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, relative)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, content)
  }
  return dir
}

/** 建目录链接（父目录不存在就建） */
export async function link(target, linkPath) {
  await fs.mkdir(path.dirname(linkPath), { recursive: true })
  await fs.symlink(target, linkPath, 'dir')
  return linkPath
}

/**
 * 读回一个目录的全部文件（相对路径 → 内容），用来逐字比对；链接本身记成 「-> 目标」
 * @param {string} dir
 * @returns {Promise<Record<string,string>|null>} 不存在时为 null
 */
export async function readTree(dir) {
  let stat
  try { stat = await fs.lstat(dir) } catch { return null }
  if (stat.isSymbolicLink()) return { '': `-> ${await fs.readlink(dir)}` }
  const out = {}
  async function walk(current, relative) {
    for (const entry of (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(current, entry.name)
      const rel = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) out[rel] = `-> ${await fs.readlink(abs)}`
      else if (entry.isDirectory()) await walk(abs, rel)
      else out[rel] = await fs.readFile(abs, 'utf8')
    }
  }
  await walk(dir, '')
  return out
}

/** 路径上是不是一个指向 target 的链接 */
export async function isLinkTo(linkPath, target) {
  try {
    const stat = await fs.lstat(linkPath)
    if (!stat.isSymbolicLink()) return false
    return (await fs.realpath(linkPath)) === (await fs.realpath(target))
  } catch {
    return false
  }
}

export const exists = async (target) => fs.lstat(target).then(() => true, () => false)

/** 读 Claude settings.json（没有时为 {}） */
export async function readClaudeSettings(homeDir) {
  try {
    return JSON.parse(await fs.readFile(path.join(homeDir, '.claude', 'settings.json'), 'utf8'))
  } catch {
    return {}
  }
}

export async function writeClaudeSettings(homeDir, data) {
  await fs.mkdir(path.join(homeDir, '.claude'), { recursive: true })
  await fs.writeFile(path.join(homeDir, '.claude', 'settings.json'), JSON.stringify(data, null, 2))
}

/**
 * Codex 官方接口替身：列出两个全局目录里的 Skill（报解析链接后的 SKILL.md 路径），开关记在内存
 * @returns {{calls: Array, list: Function, write: Function, disabled: Set<string>}}
 */
export function createFakeCodexApi({ homeDir }) {
  const calls = []
  const disabled = new Set()
  const listRoot = (root) => {
    let entries = []
    try { entries = fsSync.readdirSync(root, { withFileTypes: true }) } catch { return [] }
    return entries
      .filter((entry) => !entry.name.startsWith('.'))
      .map((entry) => path.join(root, entry.name, 'SKILL.md'))
      .filter((skillMd) => fsSync.existsSync(skillMd))
      .map((skillMd) => fsSync.realpathSync(skillMd))
      .map((real) => ({ name: path.basename(path.dirname(real)), path: real, scope: 'user', pluginId: null, enabled: !disabled.has(real) }))
  }
  return {
    calls,
    disabled,
    async list() {
      calls.push({ op: 'list' })
      return [...listRoot(path.join(homeDir, '.agents', 'skills')), ...listRoot(path.join(homeDir, '.codex', 'skills'))]
    },
    async write({ skillMdPath, enabled }) {
      const real = fsSync.realpathSync(skillMdPath)
      calls.push({ op: 'write', path: real, enabled })
      if (enabled) disabled.delete(real)
      else disabled.add(real)
      return { effectiveEnabled: enabled }
    },
  }
}

/** 断言一个 promise 被拒绝，返回错误码 */
export const codeOf = async (promise) => promise.then(() => null, (error) => error?.code || 'UNKNOWN')
