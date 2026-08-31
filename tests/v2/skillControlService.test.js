/**
 * v2.0 Skill 控制中心服务测试
 *
 * 所有写入只发生在 mkdtemp 创建的临时 HOME。
 *
 * @module tests/v2/skillControlService
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

let buildSkillManifest
let getSkillControlSnapshot
let executeSkillCommand
let discoverCodexSkills
let applyCodexCommand
let discoverClaudeSkills
let applyClaudeCommand

beforeAll(async () => {
  try {
    const servicePath = '../../electron/services/skillControlService.js'
    const codexPath = '../../electron/services/skillAdapters/codexSkillAdapter.js'
    const claudePath = '../../electron/services/skillAdapters/claudeSkillAdapter.js'
    const service = await import(/* @vite-ignore */ servicePath)
    const codex = await import(/* @vite-ignore */ codexPath)
    const claude = await import(/* @vite-ignore */ claudePath)
    ;({ buildSkillManifest, getSkillControlSnapshot, executeSkillCommand } = service.default || service)
    ;({ discoverCodexSkills, applyCodexCommand } = codex.default || codex)
    ;({ discoverClaudeSkills, applyClaudeCommand } = claude.default || claude)
  } catch (error) {
    throw new Error(`not implemented: ${error.message}`)
  }
})

// Trace targets: SC-001 dual provider snapshot; SC-005 partial source isolation;
// SC-006 protected origins and project allowlist; SC-008 codex and claude atomic mutations.

async function writeSkill(root, name, body = name) {
  const skillPath = path.join(root, name)
  await fs.mkdir(skillPath, { recursive: true })
  await fs.writeFile(path.join(skillPath, 'SKILL.md'), `---
name: ${name}
description: ${body}
---
# ${body}
`)
  return skillPath
}

describe('v2.0 Skill control service', () => {
  let sandbox
  let homeDir
  let repoPath

  beforeEach(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'codepal-v2-'))
    homeDir = path.join(sandbox, 'home')
    repoPath = path.join(sandbox, 'catalog')
    await fs.mkdir(homeDir, { recursive: true })
    await fs.mkdir(repoPath, { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(sandbox, { recursive: true, force: true })
  })

  it('SC-001 builds stable whole-directory manifests', async () => {
    const skillPath = await writeSkill(repoPath, 'shared-skill', 'first')
    await fs.mkdir(path.join(skillPath, 'references'))
    await fs.writeFile(path.join(skillPath, 'references', 'guide.md'), 'guide')

    const first = await buildSkillManifest(skillPath)
    const second = await buildSkillManifest(skillPath)
    expect(second).toEqual(first)

    await fs.writeFile(path.join(skillPath, 'references', 'guide.md'), 'changed')
    const changed = await buildSkillManifest(skillPath)
    expect(changed.hash).not.toBe(first.hash)
  })

  it('SC-001 discovers Codex official, compatibility, config and protected origins', async () => {
    await writeSkill(path.join(homeDir, '.agents', 'skills'), 'official')
    await writeSkill(path.join(homeDir, '.codex', 'skills'), 'compat')
    await writeSkill(path.join(homeDir, '.codex', 'skills', '.system'), 'bundled')
    await fs.mkdir(path.join(homeDir, '.codex'), { recursive: true })
    await fs.writeFile(path.join(homeDir, '.codex', 'config.toml'), `[[skills.config]]
path = "${path.join(homeDir, '.agents', 'skills', 'official')}"
enabled = false
`)

    const discovered = await discoverCodexSkills({ homeDir }, { skipPluginDiscovery: true })
    expect(discovered.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'official', origin: 'user', mutable: true, configEnabled: false }),
      expect.objectContaining({ name: 'compat', origin: 'legacy', mutable: true }),
      expect.objectContaining({ name: 'bundled', origin: 'system', mutable: false }),
    ]))
  })

  it('SC-001 discovers Claude user, project, commands and override states from an allowlist only', async () => {
    await writeSkill(path.join(homeDir, '.claude', 'skills'), 'user-skill')
    await writeSkill(path.join(homeDir, '.claude', 'commands'), 'legacy-command')
    const allowedProject = path.join(sandbox, 'allowed-project')
    const ignoredProject = path.join(sandbox, 'ignored-project')
    await writeSkill(path.join(allowedProject, '.claude', 'skills'), 'project-skill')
    await writeSkill(path.join(ignoredProject, '.claude', 'skills'), 'ignored-skill')
    await fs.mkdir(path.join(homeDir, '.claude'), { recursive: true })
    await fs.writeFile(path.join(homeDir, '.claude', 'settings.json'), JSON.stringify({
      skillOverrides: { 'user-skill': false },
      unknownSetting: { keep: true },
    }))

    const discovered = await discoverClaudeSkills({ homeDir, projectRoots: [allowedProject] }, { skipPluginDiscovery: true })
    expect(discovered.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'user-skill', origin: 'user', mutable: true, overrideState: 'disabled' }),
      expect.objectContaining({ name: 'project-skill', origin: 'project', mutable: false }),
      expect.objectContaining({ name: 'legacy-command', origin: 'command', mutable: false }),
    ]))
    expect(discovered.sources.some((item) => item.name === 'ignored-skill')).toBe(false)
  })

  it('SC-001 reads Claude native four-state override strings', async () => {
    const nativeStates = {
      'always-on': 'on',
      'fully-off': 'off',
      'metadata-only': 'name-only',
      'manual-only': 'user-invocable-only',
    }
    for (const name of Object.keys(nativeStates)) {
      await writeSkill(path.join(homeDir, '.claude', 'skills'), name)
    }
    await fs.mkdir(path.join(homeDir, '.claude'), { recursive: true })
    await fs.writeFile(path.join(homeDir, '.claude', 'settings.json'), JSON.stringify({
      skillOverrides: nativeStates,
    }))

    const discovered = await discoverClaudeSkills({ homeDir }, { skipPluginDiscovery: true })
    const statesByName = Object.fromEntries(discovered.sources.map((source) => [source.name, source.overrideState]))

    expect(statesByName).toEqual({
      'always-on': 'enabled',
      'fully-off': 'disabled',
      'manual-only': 'user-invocable-only',
      'metadata-only': 'name-only',
    })
  })

  it('SC-002 and SC-004 write native strings while preserving neighbor settings', async () => {
    await writeSkill(repoPath, 'override-me')
    await fs.mkdir(path.join(homeDir, '.claude'), { recursive: true })
    await fs.writeFile(path.join(homeDir, '.claude', 'settings.json'), JSON.stringify({
      skillOverrides: { other: 'name-only' },
      unknownSetting: { keep: true },
    }))

    await applyClaudeCommand({ repoPath, homeDir, skillName: 'override-me', action: 'disable' })
    let settings = JSON.parse(await fs.readFile(path.join(homeDir, '.claude', 'settings.json'), 'utf8'))
    expect(settings).toEqual({
      skillOverrides: { other: 'name-only', 'override-me': 'off' },
      unknownSetting: { keep: true },
    })

    await applyClaudeCommand({ repoPath, homeDir, skillName: 'override-me', action: 'clear-override' })
    settings = JSON.parse(await fs.readFile(path.join(homeDir, '.claude', 'settings.json'), 'utf8'))
    expect(settings.skillOverrides).toEqual({ other: 'name-only' })

    await applyClaudeCommand({ repoPath, homeDir, skillName: 'override-me', action: 'enable' })
    settings = JSON.parse(await fs.readFile(path.join(homeDir, '.claude', 'settings.json'), 'utf8'))
    expect(settings).toEqual({
      skillOverrides: { other: 'name-only', 'override-me': 'on' },
      unknownSetting: { keep: true },
    })
  })

  it('SC-003 reads legacy booleans and upgrades explicit writes', async () => {
    await writeSkill(path.join(homeDir, '.claude', 'skills'), 'legacy-on')
    await writeSkill(path.join(homeDir, '.claude', 'skills'), 'legacy-off')
    await fs.mkdir(path.join(homeDir, '.claude'), { recursive: true })
    await fs.writeFile(path.join(homeDir, '.claude', 'settings.json'), JSON.stringify({
      skillOverrides: { 'legacy-on': true, 'legacy-off': false },
    }))

    const discovered = await discoverClaudeSkills({ homeDir }, { skipPluginDiscovery: true })
    expect(discovered.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'legacy-on', overrideState: 'enabled' }),
      expect.objectContaining({ name: 'legacy-off', overrideState: 'disabled' }),
    ]))

    await applyClaudeCommand({ repoPath, homeDir, skillName: 'legacy-on', action: 'disable' })
    const settings = JSON.parse(await fs.readFile(path.join(homeDir, '.claude', 'settings.json'), 'utf8'))
    expect(settings.skillOverrides).toEqual({ 'legacy-on': 'off', 'legacy-off': false })
  })

  it('SC-005 keeps a partial snapshot when one provider source is unavailable', async () => {
    await writeSkill(repoPath, 'central')
    const snapshot = await getSkillControlSnapshot(
      { repoPath, homeDir, projectRoots: [] },
      {
        codexAdapter: {
          discover: async () => ({ toolId: 'codex', sources: [], errors: [{ origin: 'legacy', code: 'PERMISSION_DENIED' }] }),
        },
        claudeAdapter: {
          discover: async () => ({ toolId: 'claude-code', sources: [], errors: [] }),
        },
      }
    )

    expect(snapshot.partial).toBe(true)
    expect(snapshot.errors).toEqual([
      expect.objectContaining({ toolId: 'codex', origin: 'legacy', code: 'PERMISSION_DENIED' }),
    ])
    expect(JSON.stringify(snapshot)).not.toContain(homeDir)
  })

  it('SC-006 refuses mutations for project, synced, plugin, system and bundled origins', async () => {
    for (const origin of ['project', 'synced', 'plugin', 'system', 'bundled', 'command']) {
      await expect(executeSkillCommand({
        repoPath,
        homeDir,
        toolId: origin === 'system' ? 'codex' : 'claude-code',
        skillName: 'protected',
        action: 'remove-tool',
        source: { origin, mutable: false },
      })).rejects.toMatchObject({ code: 'ORIGIN_READ_ONLY' })
    }
  })

  it('SC-008 Codex enable writes only the official user path and remove-tool clears both personal copies', async () => {
    await writeSkill(repoPath, 'portable')
    await writeSkill(path.join(homeDir, '.codex', 'skills'), 'portable', 'old')

    await applyCodexCommand({ repoPath, homeDir, skillName: 'portable', action: 'enable' })
    await expect(fs.access(path.join(homeDir, '.agents', 'skills', 'portable', 'SKILL.md'))).resolves.toBeUndefined()

    await applyCodexCommand({ repoPath, homeDir, skillName: 'portable', action: 'remove-tool' })
    await expect(fs.access(path.join(homeDir, '.agents', 'skills', 'portable'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.access(path.join(homeDir, '.codex', 'skills', 'portable'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.access(path.join(repoPath, 'portable', 'SKILL.md'))).resolves.toBeUndefined()
  })

  it('SC-008 Codex disable targets the authoritative legacy source and expands home config paths', async () => {
    const legacyPath = await writeSkill(path.join(homeDir, '.codex', 'skills'), 'legacy-only')
    await fs.mkdir(path.join(homeDir, '.codex'), { recursive: true })
    await fs.writeFile(path.join(homeDir, '.codex', 'config.toml'), `[[skills.config]]\npath = "~/.codex/skills/legacy-only"\nenabled = true\n`)

    const before = await discoverCodexSkills({ homeDir }, { skipPluginDiscovery: true })
    expect(before.sources).toContainEqual(expect.objectContaining({
      name: 'legacy-only',
      origin: 'legacy',
      configEnabled: true,
    }))

    await executeSkillCommand({
      repoPath,
      homeDir,
      toolId: 'codex',
      skillName: 'legacy-only',
      action: 'disable',
    }, { skipPluginDiscovery: true })

    const config = await fs.readFile(path.join(homeDir, '.codex', 'config.toml'), 'utf8')
    expect(config.match(/\[\[skills\.config\]\]/g)).toHaveLength(1)
    expect(config).toContain('path = "~/.codex/skills/legacy-only"')
    expect(config).toContain('enabled = false')
    const after = await discoverCodexSkills({ homeDir }, { skipPluginDiscovery: true })
    expect(after.sources).toContainEqual(expect.objectContaining({ name: 'legacy-only', configEnabled: false }))
  })

  it('SC-008 Claude writes and clears one skillOverrides key without losing unknown settings', async () => {
    await writeSkill(repoPath, 'override-me')
    await fs.mkdir(path.join(homeDir, '.claude'), { recursive: true })
    await fs.writeFile(path.join(homeDir, '.claude', 'settings.json'), JSON.stringify({
      skillOverrides: { other: true },
      unknownSetting: { keep: true },
    }))

    await applyClaudeCommand({ repoPath, homeDir, skillName: 'override-me', action: 'set-override', overrideState: 'disabled' })
    let settings = JSON.parse(await fs.readFile(path.join(homeDir, '.claude', 'settings.json'), 'utf8'))
    expect(settings.skillOverrides).toEqual({ other: true, 'override-me': 'off' })
    expect(settings.unknownSetting).toEqual({ keep: true })

    await applyClaudeCommand({ repoPath, homeDir, skillName: 'override-me', action: 'clear-override' })
    settings = JSON.parse(await fs.readFile(path.join(homeDir, '.claude', 'settings.json'), 'utf8'))
    expect(settings.skillOverrides).toEqual({ other: true })
    expect(settings.unknownSetting).toEqual({ keep: true })
  })

  it('SC-008 restores native enable flags after a disable → enable round trip', async () => {
    await writeSkill(repoPath, 'round-trip')

    await executeSkillCommand({ repoPath, homeDir, toolId: 'codex', skillName: 'round-trip', action: 'enable' }, { skipPluginDiscovery: true })
    await executeSkillCommand({ repoPath, homeDir, toolId: 'codex', skillName: 'round-trip', action: 'disable' }, { skipPluginDiscovery: true })
    await executeSkillCommand({ repoPath, homeDir, toolId: 'codex', skillName: 'round-trip', action: 'enable' }, { skipPluginDiscovery: true })
    const codex = await discoverCodexSkills({ homeDir }, { skipPluginDiscovery: true })
    expect(codex.sources).toContainEqual(expect.objectContaining({ name: 'round-trip', configEnabled: true }))

    await executeSkillCommand({ repoPath, homeDir, toolId: 'claude-code', skillName: 'round-trip', action: 'enable' }, { skipPluginDiscovery: true })
    await executeSkillCommand({ repoPath, homeDir, toolId: 'claude-code', skillName: 'round-trip', action: 'disable' }, { skipPluginDiscovery: true })
    await executeSkillCommand({ repoPath, homeDir, toolId: 'claude-code', skillName: 'round-trip', action: 'enable' }, { skipPluginDiscovery: true })
    const claude = await discoverClaudeSkills({ homeDir }, { skipPluginDiscovery: true })
    expect(claude.sources).toContainEqual(expect.objectContaining({ name: 'round-trip', overrideState: 'enabled' }))
  })

  it('SC-008 adopts a symlink by materializing content and never deletes its upstream directory', async () => {
    const upstreamRoot = path.join(sandbox, 'upstream')
    const upstreamSkill = await writeSkill(upstreamRoot, 'linked')
    const userRoot = path.join(homeDir, '.claude', 'skills')
    await fs.mkdir(userRoot, { recursive: true })
    await fs.symlink(upstreamSkill, path.join(userRoot, 'linked'), 'dir')

    const result = await executeSkillCommand({
      repoPath,
      homeDir,
      toolId: 'claude-code',
      skillName: 'linked',
      action: 'adopt',
      source: { origin: 'user', mutable: true },
    })

    expect(result.success).toBe(true)
    expect((await fs.lstat(path.join(repoPath, 'linked'))).isDirectory()).toBe(true)
    expect((await fs.lstat(path.join(repoPath, 'linked'))).isSymbolicLink()).toBe(false)
    await expect(fs.access(path.join(upstreamSkill, 'SKILL.md'))).resolves.toBeUndefined()
  })
})
