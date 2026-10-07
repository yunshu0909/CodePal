/** Ordinary asset identities and verified aliases. Reads management facts; never imports or edits assets. */
const fs = require('fs/promises')
const path = require('path')
const crypto = require('crypto')
const { resolveSkillRepoPath } = require('../../services/skillRepoPath')
const { listOperations } = require('./operationJournal')
const { skillsDataDir } = require('./skillsDataDir')
const { getTranscriptRoot } = require('../../services/transcriptLocatorService')

const hash = (text) => crypto.createHash('sha256').update(String(text)).digest('hex')
const expand = (text, homeDir) =>
  text.startsWith('~/') ? path.join(homeDir, text.slice(2)) : path.resolve(text)
const normalized = (text, homeDir) => path.normalize(expand(text, homeDir))
const excluded = (target) =>
  /(?:^|\/)(?:plugins?|\.system)(?:\/|$)/.test(target) || /\/plugins\/cache\//.test(target)

/**
 * @param {object} deps - 主进程 homeDir、env 和可选 storeDir。
 * @returns {Promise<object>} 普通资产真实路径身份、经收进记录证明的历史别名及日志根。
 * 每次读取当前管理事实；不打开 Skill 正文，不导入、部署或修改用户资产。
 */
async function readUsageSources(deps) {
  const homeDir = deps.homeDir
  const env = deps.env || process.env
  const resolved = await resolveSkillRepoPath({ homeDir })
  const central = normalized(resolved, homeDir)
  const roots = [
    { path: central, kind: 'central' },
    { path: path.join(homeDir, '.claude', 'skills'), kind: 'global' },
    { path: path.join(homeDir, '.agents', 'skills'), kind: 'global' },
    { path: path.join(homeDir, '.codex', 'skills'), kind: 'global' },
  ]
  const byPath = new Map()
  const assets = new Map()
  const diagnostics = []
  for (const root of roots) {
    let names
    try {
      names = await fs.readdir(root.path)
    } catch (error) {
      if (error.code !== 'ENOENT')
        diagnostics.push({
          code: 'ASSET_DIRECTORY_UNREADABLE',
          scope: 'all',
          availability: 'error',
        })
      continue
    }
    for (const name of names.sort()) {
      if (name.startsWith('.')) continue
      const target = path.join(root.path, name, 'SKILL.md')
      try {
        const stat = await fs.stat(target)
        if (!stat.isFile()) continue
        const real = await fs.realpath(target)
        if (excluded(real)) continue
        const assetId = 'asset_' + hash(real).slice(0, 24)
        let asset = assets.get(assetId)
        if (!asset) {
          asset = { assetId, name, kind: root.kind, canonicalPath: real }
          assets.set(assetId, asset)
        }
        if (root.kind === 'central') asset.kind = 'central'
        byPath.set(target, asset)
        byPath.set(real, asset)
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')
          diagnostics.push({ code: 'ASSET_IDENTITY_UNREADABLE', name, scope: 'asset' })
      }
    }
  }
  // A completed collection proves a historical alias only if the retained body came from this source.
  const aliases = []
  for (const op of await listOperations(homeDir)) {
    if (op.state !== 'done' || op.from?.scope !== 'global') continue
    if (!(op.steps || []).every((step) => step.state === 'done' || step.status === 'done')) continue
    const libraryStep = op.steps.find((step) => step.id === 'library')
    const same = op.from?.digest && libraryStep?.before?.digest === op.from.digest
    if (!['create', 'replace'].includes(op.libraryMode) && !same) continue
    const asset = byPath.get(path.join(op.library?.path || '', 'SKILL.md'))
    if (!asset) continue
    for (const location of [op.from.absolutePath, op.from.real].filter(Boolean)) {
      aliases.push({ target: path.join(location, 'SKILL.md'), asset, until: Date.parse(op.at) })
    }
  }
  const preferred = new Map()
  for (const asset of assets.values()) {
    if (!preferred.has(asset.name) || asset.kind === 'central') preferred.set(asset.name, asset)
  }
  return {
    assets: [...assets.values()],
    preferred,
    diagnostics,
    roots: {
      claude: getTranscriptRoot('claude', { homeDir, env }),
      codex: getTranscriptRoot('codex', { homeDir, env }),
    },
    storeDir: deps.storeDir || path.join(skillsDataDir(homeDir), 'usage-v3'),
    resolve(target, at) {
      if (typeof target !== 'string' || !target || excluded(target)) return { excluded: true }
      const absolute = normalized(target, homeDir)
      const alias = aliases.find((item) => item.target === absolute && Date.parse(at) <= item.until)
      if (alias) return { asset: alias.asset }
      if (byPath.has(absolute)) return { asset: byPath.get(absolute) }
      // Project/development paths remain outside ordinary usage, even when short names match.
      const ordinaryRoot = roots.some((root) => absolute.startsWith(root.path + path.sep))
      return ordinaryRoot
        ? { unknown: true, name: path.basename(path.dirname(absolute)) }
        : { excluded: true }
    },
  }
}
module.exports = { readUsageSources, hash }
