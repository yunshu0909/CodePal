/**
 * Skills 只留一套引擎（specs/v2.1.9-Skills只留一套引擎）：按来源身份操作
 *
 * 负责：
 * - TC-005：快照里每份来源带不含路径的 sourceId，两次读取一致；带 sourceId 收进只取那一份；找不到报 SOURCE_NOT_FOUND
 * - TC-005 另含：带 sourceId 停用只写那一份；指向只读来源报 ORIGIN_READ_ONLY；启用、删除带 sourceId 报 SOURCE_ACTION_UNSUPPORTED
 * - TC-006（守卫）：不带 sourceId 时仍按原规则取第一份可写来源（~/.agents/skills）
 * - TC-012（守卫）：只读来源（Codex 系统自带）不带 sourceId 停用照旧报 ORIGIN_READ_ONLY，文件和配置不变
 * - TC-013（守卫）：不带 sourceId 的 Codex 停用→启用、Claude 启用→停用、从资产库删除，结果与现在一致
 * - TC-015（守卫）：不带 sourceId 从 Codex 删除：资产库那份、~/.agents/skills 里指向它的链接删掉；~/.codex/skills 里内容不同的同名那份和无关 Skill 不动
 * - TC-014（守卫）：同名两份内容不同的 Codex 来源、不带 sourceId 停用再启用：照旧只写 ~/.agents/skills 那份，旧目录那份不动
 * - 所有写入只发生在 mkdtemp 建的临时家目录
 *
 * @module tests/skills/skillSourceId.test
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { getSkillControlSnapshot, executeSkillCommand } = require('../../electron/services/skillControlService')

// Codex 官方接口替身：列表按写入记录给开关状态，写入只记在内存（不碰 config.toml）。各测试文件各带一份。
function createFakeCodexApi({ homeDir }) {
  const fsSync = require('node:fs')
  const listRoot = (root, scope) => {
    let entries = []
    try { entries = fsSync.readdirSync(root, { withFileTypes: true }) } catch { return [] }
    return entries
      .filter((entry) => !entry.name.startsWith('.'))
      .map((entry) => path.join(root, entry.name, 'SKILL.md'))
      .filter((skillMd) => fsSync.existsSync(skillMd))
      .map((skillMd) => fsSync.realpathSync(skillMd))
      .map((real) => ({ name: path.basename(path.dirname(real)), path: real, scope, pluginId: null, enabled: !disabled.has(real) }))
  }
  const calls = []
  const disabled = new Set()
  return {
    calls,
    async list() {
      return [...listRoot(path.join(homeDir, '.agents', 'skills'), 'user'), ...listRoot(path.join(homeDir, '.codex', 'skills'), 'user')]
    },
    async write({ skillMdPath, enabled }) {
      const real = fsSync.realpathSync(skillMdPath)
      calls.push({ path: real, enabled })
      if (enabled) disabled.delete(real)
      else disabled.add(real)
      return { effectiveEnabled: enabled }
    },
  }
}

let sandbox
let homeDir
let repoPath
let deps

async function writeSkill(root, name, body) {
  const dir = path.join(root, name)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${body}\n---\n\n${body}\n`)
  return dir
}

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'codepal-source-id-'))
  homeDir = path.join(sandbox, 'home')
  repoPath = path.join(homeDir, 'Documents', 'SkillManager')
  await fs.mkdir(repoPath, { recursive: true })
  await writeSkill(path.join(homeDir, '.agents', 'skills'), 'twin', 'agents copy')
  await writeSkill(path.join(homeDir, '.codex', 'skills'), 'twin', 'legacy copy')
  await writeSkill(path.join(homeDir, '.codex', 'skills', '.system'), 'imagegen', 'system skill')
  deps = { skipPluginDiscovery: true, codexSkillApi: createFakeCodexApi({ homeDir }) }
})

afterEach(async () => {
  await fs.rm(sandbox, { recursive: true, force: true })
})

const readCentral = () => fs.readFile(path.join(repoPath, 'twin', 'SKILL.md'), 'utf8')

async function originsOf(name) {
  const snap = await getSkillControlSnapshot({ repoPath, homeDir, projectRoots: [] }, deps)
  return snap.skills.find((skill) => skill.name === name).origins.filter((origin) => origin.toolId === 'codex')
}
const twinOrigins = () => originsOf('twin')
const codeOf = async (promise) => promise.then(() => null, (error) => error?.code || 'UNKNOWN')

describe('按来源身份操作', () => {
  it('TC-005 SOURCE_ID 每份来源有 sourceId、不含路径、两次一致；带 sourceId 收进只取那一份；找不到报 SOURCE_NOT_FOUND', async () => {
    const first = await twinOrigins()
    expect(first.length).toBe(2)
    expect(first.every((origin) => typeof origin.sourceId === 'string' && origin.sourceId.length > 0), 'SOURCE_ID 快照来源缺少 sourceId').toBe(true)
    expect(new Set(first.map((origin) => origin.sourceId)).size, 'SOURCE_ID 两份来源的 sourceId 应不同').toBe(2)
    for (const origin of first) {
      expect(origin.sourceId, 'SOURCE_ID sourceId 不能含路径').not.toMatch(/[/\\]|skills|\.agents|\.codex/)
    }
    const again = await twinOrigins()
    expect(again.map((origin) => origin.sourceId)).toEqual(first.map((origin) => origin.sourceId))

    const legacy = first.find((origin) => origin.origin === 'legacy')
    expect(legacy, 'SOURCE_ID 旧目录那份应是 legacy 来源').toBeTruthy()

    let missing = null
    try {
      await executeSkillCommand({ repoPath, homeDir, toolId: 'codex', skillName: 'twin', action: 'adopt', sourceId: 'no-such-source' }, deps)
    } catch (error) {
      missing = error
    }
    expect(missing?.code, 'SOURCE_ID 找不到的 sourceId 应报 SOURCE_NOT_FOUND').toBe('SOURCE_NOT_FOUND')
    await expect(fs.access(path.join(repoPath, 'twin'))).rejects.toThrow()

    const result = await executeSkillCommand({ repoPath, homeDir, toolId: 'codex', skillName: 'twin', action: 'adopt', sourceId: legacy.sourceId }, deps)
    expect(result.success).toBe(true)
    expect(await readCentral(), 'SOURCE_ID 收进的应是旧目录那份').toContain('legacy copy')
    // 原件不动
    expect(await fs.readFile(path.join(homeDir, '.codex', 'skills', 'twin', 'SKILL.md'), 'utf8')).toContain('legacy copy')
    expect(await fs.readFile(path.join(homeDir, '.agents', 'skills', 'twin', 'SKILL.md'), 'utf8')).toContain('agents copy')

    // 带 sourceId 停用：只写旧目录那一份
    deps.codexSkillApi.calls.length = 0
    await executeSkillCommand({ repoPath, homeDir, toolId: 'codex', skillName: 'twin', action: 'disable', sourceId: legacy.sourceId }, deps)
    const legacyMd = await fs.realpath(path.join(homeDir, '.codex', 'skills', 'twin', 'SKILL.md'))
    expect(deps.codexSkillApi.calls, 'SOURCE_ID 带 sourceId 停用应只写那一份').toEqual([{ path: legacyMd, enabled: false }])

    // 反过来指定新目录那份：只写新目录那份，旧目录那份保持刚才的状态
    const agents = first.find((origin) => origin.origin === 'user')
    const agentsMd = await fs.realpath(path.join(homeDir, '.agents', 'skills', 'twin', 'SKILL.md'))
    deps.codexSkillApi.calls.length = 0
    await executeSkillCommand({ repoPath, homeDir, toolId: 'codex', skillName: 'twin', action: 'disable', sourceId: agents.sourceId }, deps)
    expect(deps.codexSkillApi.calls, 'SOURCE_ID 指定新目录那份停用应只写那一份').toEqual([{ path: agentsMd, enabled: false }])

    // 指向只读来源：拒绝，什么都不写
    const system = (await originsOf('imagegen'))[0]
    deps.codexSkillApi.calls.length = 0
    expect(await codeOf(executeSkillCommand({ repoPath, homeDir, toolId: 'codex', skillName: 'imagegen', action: 'disable', sourceId: system.sourceId }, deps)),
      'SOURCE_ID 只读来源应报 ORIGIN_READ_ONLY').toBe('ORIGIN_READ_ONLY')
    expect(deps.codexSkillApi.calls).toEqual([])

    // 启用、删除这次不支持按来源：带 sourceId 直接拒绝，什么都不写
    for (const action of ['enable', 'delete']) {
      expect(await codeOf(executeSkillCommand({ repoPath, homeDir, toolId: 'codex', skillName: 'twin', action, sourceId: legacy.sourceId }, deps)),
        `SOURCE_ID ${action} 带 sourceId 应报 SOURCE_ACTION_UNSUPPORTED`).toBe('SOURCE_ACTION_UNSUPPORTED')
    }
    expect(deps.codexSkillApi.calls).toEqual([])
    expect(await readCentral()).toContain('legacy copy')
    expect(await fs.readFile(path.join(homeDir, '.codex', 'skills', 'twin', 'SKILL.md'), 'utf8')).toContain('legacy copy')
  })

  it('TC-006 不带 sourceId 时保持现状：取第一份可写来源（~/.agents/skills）', async () => {
    const result = await executeSkillCommand({ repoPath, homeDir, toolId: 'codex', skillName: 'twin', action: 'adopt', source: { origin: 'user', mutable: true } }, deps)
    expect(result.success).toBe(true)
    expect(await readCentral()).toContain('agents copy')
  })

  it('TC-012 只读来源不带 sourceId 停用照旧报 ORIGIN_READ_ONLY，文件和配置都不变', async () => {
    const before = await fs.readFile(path.join(homeDir, '.codex', 'skills', '.system', 'imagegen', 'SKILL.md'), 'utf8')
    expect(await codeOf(executeSkillCommand({ repoPath, homeDir, toolId: 'codex', skillName: 'imagegen', action: 'disable' }, deps))).toBe('ORIGIN_READ_ONLY')
    expect(deps.codexSkillApi.calls).toEqual([])
    expect(await fs.readFile(path.join(homeDir, '.codex', 'skills', '.system', 'imagegen', 'SKILL.md'), 'utf8')).toBe(before)
    await expect(fs.access(path.join(homeDir, '.codex', 'config.toml'))).rejects.toThrow()
  })

  it('TC-013 不带 sourceId 的 Codex 停用→启用、Claude 启用→停用、从资产库删除，结果与现在一致', async () => {
    await writeSkill(path.join(homeDir, '.agents', 'skills'), 'solo', 'solo copy')
    const soloMd = await fs.realpath(path.join(homeDir, '.agents', 'skills', 'solo', 'SKILL.md'))
    await executeSkillCommand({ repoPath, homeDir, toolId: 'codex', skillName: 'solo', action: 'disable' }, deps)
    await executeSkillCommand({ repoPath, homeDir, toolId: 'codex', skillName: 'solo', action: 'enable' }, deps)
    expect(deps.codexSkillApi.calls).toEqual([{ path: soloMd, enabled: false }, { path: soloMd, enabled: true }])

    await writeSkill(repoPath, 'shared', 'central copy')
    const claudeDeps = { skipPluginDiscovery: true }
    await executeSkillCommand({ repoPath, homeDir, toolId: 'claude-code', skillName: 'shared', action: 'enable' }, claudeDeps)
    expect((await fs.lstat(path.join(homeDir, '.claude', 'skills', 'shared'))).isSymbolicLink() || (await fs.lstat(path.join(homeDir, '.claude', 'skills', 'shared'))).isDirectory()).toBe(true)
    await executeSkillCommand({ repoPath, homeDir, toolId: 'claude-code', skillName: 'shared', action: 'disable' }, claudeDeps)
    const settings = JSON.parse(await fs.readFile(path.join(homeDir, '.claude', 'settings.json'), 'utf8'))
    expect(settings.skillOverrides.shared === false || settings.skillOverrides.shared === 'off').toBe(true)

    await executeSkillCommand({ repoPath, homeDir, toolId: 'claude-code', skillName: 'shared', action: 'delete' }, claudeDeps)
    await expect(fs.access(path.join(repoPath, 'shared'))).rejects.toThrow()
    await expect(fs.lstat(path.join(homeDir, '.claude', 'skills', 'shared'))).rejects.toThrow()
  })

  it('TC-014 同名两份不带 sourceId 停用再启用：照旧只写 ~/.agents/skills 那份', async () => {
    const agentsMd = await fs.realpath(path.join(homeDir, '.agents', 'skills', 'twin', 'SKILL.md'))
    const legacyMd = await fs.realpath(path.join(homeDir, '.codex', 'skills', 'twin', 'SKILL.md'))
    await executeSkillCommand({ repoPath, homeDir, toolId: 'codex', skillName: 'twin', action: 'disable' }, deps)
    expect(deps.codexSkillApi.calls).toEqual([{ path: agentsMd, enabled: false }])
    const listed = await deps.codexSkillApi.list()
    expect(listed.find((item) => item.path === legacyMd).enabled).toBe(true)
    await executeSkillCommand({ repoPath, homeDir, toolId: 'codex', skillName: 'twin', action: 'enable' }, deps)
    expect(deps.codexSkillApi.calls).toEqual([{ path: agentsMd, enabled: false }, { path: agentsMd, enabled: true }])
    expect(await fs.readFile(legacyMd, 'utf8')).toContain('legacy copy')
    await expect(fs.access(path.join(repoPath, 'twin'))).rejects.toThrow()
  })

  it('TC-015 不带 sourceId 从 Codex 删除：只删资产库和指向它的那份，内容不同的同名副本和无关 Skill 不动', async () => {
    await fs.rm(path.join(homeDir, '.agents', 'skills', 'twin'), { recursive: true })
    await writeSkill(repoPath, 'twin', 'central copy')
    await fs.symlink(path.join(repoPath, 'twin'), path.join(homeDir, '.agents', 'skills', 'twin'))
    await writeSkill(repoPath, 'keep', 'keep copy')
    await writeSkill(path.join(homeDir, '.agents', 'skills'), 'keep', 'keep copy')
    const result = await executeSkillCommand({ repoPath, homeDir, toolId: 'codex', skillName: 'twin', action: 'delete' }, deps)
    expect(result.success).toBe(true)
    await expect(fs.access(path.join(repoPath, 'twin'))).rejects.toThrow()
    await expect(fs.lstat(path.join(homeDir, '.agents', 'skills', 'twin'))).rejects.toThrow()
    expect(await fs.readFile(path.join(homeDir, '.codex', 'skills', 'twin', 'SKILL.md'), 'utf8')).toContain('legacy copy')
    expect(await fs.readFile(path.join(repoPath, 'keep', 'SKILL.md'), 'utf8')).toContain('keep copy')
    expect(await fs.readFile(path.join(homeDir, '.agents', 'skills', 'keep', 'SKILL.md'), 'utf8')).toContain('keep copy')
    expect(deps.codexSkillApi.calls).toEqual([])
    await expect(fs.access(path.join(homeDir, '.codex', 'config.toml'))).rejects.toThrow()
  })
})
