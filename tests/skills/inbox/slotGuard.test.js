/**
 * Skills 要处理（specs/v2.1.11-Skills要处理-实现）：占位保护
 *
 * 负责：
 * - TC-003：资产库已有的名字，某个工具的全局位置不是已核实的资产库链接就算占着：
 *   还没处理（pending）/ 已忽略（ignored）/ 一样的独立文件夹（same，带 sourceId）/ 指向别处的链接（external）；
 *   指向资产库的链接不算；Codex 两个全局目录一样判断；占着时启用这个工具报 SLOT_OCCUPIED、什么都没动；
 *   从项目收进到被占的工具报 SLOT_OCCUPIED、outcome=not-run、什么都没动
 * 所有写入只在临时家目录。
 *
 * @module tests/skills/inbox/slotGuard.test
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { createFakeCodexApi, link, makeHome, readClaudeSettings, readTree, writeSkill } from './helpers.js'

const require = createRequire(import.meta.url)
const { getSkillControlSnapshot, executeSkillCommand } = require('../../../electron/services/skillControlService')

let env
let deps

beforeEach(async () => {
  env = await makeHome('slot')
  await fs.mkdir(path.join(env.homeDir, '.codex'), { recursive: true })
  deps = { codexSkillApi: createFakeCodexApi({ homeDir: env.homeDir }) }
})
afterEach(async () => { await env.cleanup() })

const snapshotOf = () => getSkillControlSnapshot({ repoPath: env.repoPath, homeDir: env.homeDir }, deps)
const skillOf = (snap, name) => snap.skills.find((skill) => skill.name === name)

describe('占位保护', () => {
  it('TC-003 SLOT_GUARD 四种占位原因，指向资产库的链接不算，Codex 两个全局目录都看', async () => {
    const { homeDir, repoPath } = env
    const claude = path.join(homeDir, '.claude', 'skills')
    for (const name of ['pend', 'ign', 'twin', 'ext', 'ok', 'cx-legacy']) await writeSkill(repoPath, name, `${name} lib`)
    await writeSkill(claude, 'pend', 'pend changed')
    await writeSkill(claude, 'ign', 'ign changed')
    await writeSkill(claude, 'twin', 'twin lib')
    const elsewhere = await writeSkill(path.join(homeDir, 'elsewhere'), 'ext', 'ext lib')
    await link(elsewhere, path.join(claude, 'ext'))
    await link(path.join(repoPath, 'ok'), path.join(claude, 'ok'))
    await writeSkill(path.join(homeDir, '.codex', 'skills'), 'cx-legacy', 'legacy changed')

    // 忽略 ign 的全局那份
    let snap = await snapshotOf()
    const ignCopy = snap.inbox.items.find((item) => item.name === 'ign').copies[0]
    await executeSkillCommand({ repoPath, homeDir, action: 'ignore', skillName: 'ign', sourceId: ignCopy.sourceId }, deps)

    snap = await snapshotOf()
    expect(skillOf(snap, 'pend').gate?.['claude-code']?.why, 'SLOT_GUARD 还没处理的全局那份').toBe('pending')
    expect(skillOf(snap, 'ign').gate?.['claude-code']?.why, 'SLOT_GUARD 已忽略的全局那份').toBe('ignored')
    expect(skillOf(snap, 'twin').gate?.['claude-code']?.why, 'SLOT_GUARD 一样的独立文件夹').toBe('same')
    expect(skillOf(snap, 'twin').gate['claude-code'].sourceId).toMatch(/^src_/)
    expect(skillOf(snap, 'ext').gate?.['claude-code']?.why, 'SLOT_GUARD 指向别处的链接').toBe('external')
    expect(skillOf(snap, 'ext').gate['claude-code'].sourceId).toMatch(/^src_/)
    expect(skillOf(snap, 'ok').gate?.['claude-code'] ?? null, 'SLOT_GUARD 指向资产库的链接不算占着').toBeNull()
    expect(skillOf(snap, 'cx-legacy').gate?.codex?.why, 'SLOT_GUARD Codex 旧目录也要看').toBe('pending')
    // 一样的全局份不进要处理（范围），不会因为有 gate 就出现在清单里
    expect(snap.inbox.items.map((item) => item.name)).not.toContain('twin')
  })

  it('TC-003 SLOT_GUARD 占着时启用报 SLOT_OCCUPIED，从项目收进到被占的工具报 SLOT_OCCUPIED，什么都没动', async () => {
    const { homeDir, repoPath } = env
    const claude = path.join(homeDir, '.claude', 'skills')
    await writeSkill(repoPath, 'pend', 'pend lib')
    await writeSkill(claude, 'pend', 'pend changed')
    const beforeClaude = await readTree(path.join(homeDir, '.claude'))
    let error = null
    try {
      await executeSkillCommand({ repoPath, homeDir, toolId: 'claude-code', skillName: 'pend', action: 'enable' }, deps)
    } catch (caught) { error = caught }
    expect(error?.code, 'SLOT_GUARD 占着时启用应拒绝').toBe('SLOT_OCCUPIED')
    expect(await readTree(path.join(homeDir, '.claude'))).toEqual(beforeClaude)
    expect((await readClaudeSettings(homeDir)).skillOverrides ?? null).toBeNull()

    // 资产库没有这个名字，但 Claude 全局有自己的一份；项目里同名的一份要收进到 Claude → 收不了
    const project = path.join(homeDir, 'work', 'proj')
    await writeSkill(claude, 'solo', 'global solo')
    await writeSkill(path.join(project, '.claude', 'skills'), 'solo', 'project solo')
    await fs.writeFile(path.join(homeDir, '.claude.json'), JSON.stringify({ projects: { [project]: {} } }))
    const snap = await snapshotOf()
    const projectCopy = snap.inbox.items.find((item) => item.name === 'solo').copies.find((copy) => copy.scope === 'project')
    const beforeAll = await readTree(homeDir)
    error = null
    try {
      await executeSkillCommand({ repoPath, homeDir, action: 'collect', skillName: 'solo', sourceId: projectCopy.sourceId }, deps)
    } catch (caught) { error = caught }
    expect(error?.code, 'SLOT_GUARD 从项目收进到被占的工具应拒绝').toBe('SLOT_OCCUPIED')
    expect(error?.outcome).toBe('not-run')
    const afterAll = await readTree(homeDir)
    expect(afterAll).toEqual(beforeAll)
  })
})
