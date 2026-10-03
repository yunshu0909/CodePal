/**
 * Skills 要处理（specs/v2.1.11-Skills要处理-实现）：代码审核第 1 轮补的主进程行为
 *
 * 负责：
 * - TC-027：备份之后、移走之前原件又被改了：不删，停下并恢复原样，资产库用的是核对过的备份
 * - TC-028：「换成这一份」挪走的旧资产库备份缺文件或整份不见：撤回、继续恢复都什么都不动
 * - TC-029：连带别的工具的撤回整条计划先落盘，每个工具一步；中途强退能继续做完；Codex 里关掉的那一项一起清掉
 * - TC-030：资产库已删时的撤回只放回原件；撤到一半强退后继续恢复也只做这些
 * - TC-031：原项目整个不在了：撤回和继续恢复都不重建项目，原因「原位置不在了」
 * - TC-032：Codex 开启前全局位置被别的东西占着就不开（定稿 C13），不调接口、不动那一份
 * - TC-033：不同名字同时忽略 / 取消忽略，记录不互相覆盖
 * - TC-034：Skill 里有内部链接：资产库照原样放链接、摘要一致，收进到一半强退能继续恢复
 * - TC-035：只涉及 Claude 的「换成这一份」和删除，写完只重读 Claude，不调 Codex
 * 所有写入只在临时家目录。
 *
 * @module tests/skills/inbox/reviewFixes.test
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { codeOf, createFakeCodexApi, exists, isLinkTo, link, makeHome, readClaudeSettings, readTree, writeClaudeSettings, writeSkill } from './helpers.js'

const require = createRequire(import.meta.url)
const { getSkillControlSnapshot, executeSkillCommand } = require('../../../electron/services/skillControlService')
const { registerSkillControlHandlers } = require('../../../electron/handlers/registerSkillControlHandlers')
const { backupDir } = require('../../../electron/modules/skills/skillsDataDir')
const ignoreStore = require('../../../electron/modules/skills/ignoreStore')

let env
let deps
let p1

beforeEach(async () => {
  env = await makeHome('review-fixes')
  await fs.mkdir(path.join(env.homeDir, '.codex'), { recursive: true })
  p1 = path.join(env.homeDir, 'work', 'p1')
  await fs.mkdir(p1, { recursive: true })
  await fs.writeFile(path.join(env.homeDir, '.claude.json'), JSON.stringify({ projects: { [p1]: {} } }))
  await writeClaudeSettings(env.homeDir, { theme: 'dark' })
  deps = { codexSkillApi: createFakeCodexApi({ homeDir: env.homeDir }) }
})
afterEach(async () => { await env.cleanup() })

const run = (params, extra = {}) => executeSkillCommand({ repoPath: env.repoPath, homeDir: env.homeDir, ...params }, { ...deps, ...extra })
const snapshotOf = () => getSkillControlSnapshot({ repoPath: env.repoPath, homeDir: env.homeDir }, deps)
const claudeIn = (project) => path.join(project, '.claude', 'skills')
const crash = () => Object.assign(new Error('CRASH'), { code: 'CRASH', crash: true })
async function copyOf(name) {
  const snap = await snapshotOf()
  return snap.inbox.items.find((item) => item.name === name).copies[0]
}
async function stateOf(operationId) {
  return (await snapshotOf()).operations.find((op) => op.operationId === operationId)
}
/** 用户能看到的文件（不含 CodePal 数据目录） */
async function userTree() {
  const tree = await readTree(env.homeDir)
  return Object.fromEntries(Object.entries(tree).filter(([key]) => !key.startsWith('Library/')))
}
async function rejection(promise) {
  try { await promise } catch (error) { return error }
  return null
}

describe('原件与备份', () => {
  it('TC-027 SOURCE_CHANGED 备份之后原件又被改：不删、停下恢复原样；留资产库的那种也一样', async () => {
    for (const [name, libraryBody] of [['late-edit', null], ['late-keep', 'library v1']]) {
      if (libraryBody) await writeSkill(env.repoPath, name, libraryBody)
      const original = await writeSkill(claudeIn(p1), name, 'project v2')
      const copy = await copyOf(name)
      const libraryBefore = libraryBody ? await readTree(path.join(env.repoPath, name)) : null
      const error = await rejection(run({ action: 'collect', skillName: name, sourceId: copy.sourceId, keep: libraryBody ? 'library' : undefined }, {
        collectHook: async (stepId, phase) => {
          if (stepId === 'backup-source' && phase === 'apply-after') {
            await fs.writeFile(path.join(original, 'notes.md'), 'written after backup')
            await fs.appendFile(path.join(original, 'SKILL.md'), 'late line\n')
          }
        },
      }))
      expect(error?.code, `SOURCE_CHANGED ${name} 应停下`).toBe('SOURCE_CHANGED')
      expect(error?.outcome, `SOURCE_CHANGED ${name} 已恢复原样`).toBe('rolled-back')
      expect(await fs.readFile(path.join(original, 'notes.md'), 'utf8'), `SOURCE_CHANGED ${name} 新写的不能丢`).toBe('written after backup')
      expect(await fs.readFile(path.join(original, 'SKILL.md'), 'utf8')).toContain('late line')
      if (libraryBody) expect(await readTree(path.join(env.repoPath, name)), 'SOURCE_CHANGED 资产库不变').toEqual(libraryBefore)
      else expect(await exists(path.join(env.repoPath, name)), 'SOURCE_CHANGED 新放进的资产库撤掉').toBe(false)
      expect((await snapshotOf()).operations.filter((op) => op.name === name), 'SOURCE_CHANGED 不留可撤回的记录').toEqual([])
    }
  })

  it('TC-028 LIBRARY_BEFORE_BACKUP 换掉的旧资产库备份缺文件或整份不见：撤回什么都不动，原因「备份不完整」', async () => {
    for (const damage of ['missing-file', 'missing-all']) {
      const name = `swap-${damage}`
      await writeSkill(env.repoPath, name, 'library v1', { 'refs/a.md': 'a', 'refs/b.md': 'b' })
      await writeSkill(claudeIn(p1), name, 'project v2')
      const copy = await copyOf(name)
      const { operationId } = await run({ action: 'collect', skillName: name, sourceId: copy.sourceId, keep: 'source' })
      const saved = path.join(backupDir(env.homeDir, operationId), 'library-before')
      if (damage === 'missing-file') await fs.rm(path.join(saved, 'refs', 'b.md'))
      else await fs.rm(saved, { recursive: true, force: true })
      expect((await stateOf(operationId)).reason, `LIBRARY_BEFORE_BACKUP ${damage} 收进记录显示原因`).toBe('backup-incomplete')
      const before = await userTree()
      const error = await rejection(run({ action: 'undo', operationId }))
      expect(error?.code, `LIBRARY_BEFORE_BACKUP ${damage} 撤不了`).toBe('UNDO_BLOCKED')
      expect(error?.reason).toBe('backup-incomplete')
      expect(await userTree(), `LIBRARY_BEFORE_BACKUP ${damage} 什么都不动`).toEqual(before)
    }
  })

  it('TC-028 LIBRARY_BEFORE_BACKUP 撤到一半强退后旧资产库备份被改：继续恢复先核对，停下不再动', async () => {
    await writeSkill(env.repoPath, 'swap-resume', 'library v1', { 'refs/a.md': 'a' })
    await writeSkill(claudeIn(p1), 'swap-resume', 'project v2')
    const copy = await copyOf('swap-resume')
    const { operationId } = await run({ action: 'collect', skillName: 'swap-resume', sourceId: copy.sourceId, keep: 'source' })
    await rejection(run({ action: 'undo', operationId }, {
      collectHook: async (stepId, phase) => { if (stepId === 'enable' && phase === 'revert-after') throw crash() },
    }))
    expect((await stateOf(operationId)).state).toBe('partial')
    await fs.writeFile(path.join(backupDir(env.homeDir, operationId), 'library-before', 'refs', 'a.md'), 'tampered')
    const before = await userTree()
    const error = await rejection(run({ action: 'resume', operationId }))
    expect(error?.code, 'LIBRARY_BEFORE_BACKUP 继续恢复应停下').toBe('RESUME_BLOCKED')
    expect(error?.reason).toBe('backup-incomplete')
    expect(await userTree(), 'LIBRARY_BEFORE_BACKUP 继续恢复前核对，什么都不动').toEqual(before)
  })
})

describe('撤回计划落盘', () => {
  async function collectShared(name) {
    const original = await writeSkill(claudeIn(p1), name, 'shared body')
    const originalTree = await readTree(original)
    const copy = await copyOf(name)
    const { operationId } = await run({ action: 'collect', skillName: name, sourceId: copy.sourceId })
    await run({ action: 'enable', toolId: 'codex', skillName: name })
    await run({ action: 'disable', toolId: 'codex', skillName: name })
    const libraryMd = await fs.realpath(path.join(env.repoPath, name, 'SKILL.md'))
    expect(deps.codexSkillApi.disabled.has(libraryMd)).toBe(true)
    return { original, originalTree, operationId, libraryMd }
  }

  it('TC-029 DEPENDENT_PLAN 连带撤回：Codex 的链接与关掉的那一项一起清掉', async () => {
    const { original, originalTree, operationId, libraryMd } = await collectShared('shared-clean')
    const result = await run({ action: 'undo', operationId, confirmed: true })
    expect(result.outcome).toBe('done')
    expect(await exists(path.join(env.homeDir, '.agents', 'skills', 'shared-clean'))).toBe(false)
    expect(deps.codexSkillApi.disabled.has(libraryMd), 'DEPENDENT_PLAN Codex 里关掉的那一项一起清掉').toBe(false)
    expect(await readTree(original)).toEqual(originalTree)
  })

  it('TC-029 DEPENDENT_PLAN 连带撤回中途强退：计划已落盘，继续恢复把剩下的做完', async () => {
    for (const phase of ['apply-before', 'apply-after']) {
      const name = `shared-${phase}`
      const { original, originalTree, operationId, libraryMd } = await collectShared(name)
      const error = await rejection(run({ action: 'undo', operationId, confirmed: true }, {
        collectHook: async (stepId, hookPhase) => { if (stepId === 'dependent:codex' && hookPhase === phase) throw crash() },
      }))
      expect(error?.code, `DEPENDENT_PLAN ${phase} 应在连带那一步强退`).toBe('CRASH')
      expect((await stateOf(operationId)).state, `DEPENDENT_PLAN ${phase} 没做完`).toBe('partial')
      const result = await run({ action: 'resume', operationId })
      expect(result.outcome).toBe('done')
      expect(await exists(path.join(env.repoPath, name)), `DEPENDENT_PLAN ${phase} 资产库这份拿掉`).toBe(false)
      expect(await exists(path.join(env.homeDir, '.agents', 'skills', name)), `DEPENDENT_PLAN ${phase} Codex 链接拿掉`).toBe(false)
      expect(deps.codexSkillApi.disabled.has(libraryMd), `DEPENDENT_PLAN ${phase} Codex 那一项清掉`).toBe(false)
      expect(await readTree(original), `DEPENDENT_PLAN ${phase} 原件放回`).toEqual(originalTree)
    }
  })

  it('TC-030 UNDO_MODE_KEPT 资产库已删的撤回强退后继续恢复：只放回原件，不把旧资产库放回去', async () => {
    await writeSkill(env.repoPath, 'gone-lib', 'library v1')
    const original = await writeSkill(claudeIn(p1), 'gone-lib', 'project v2')
    const originalTree = await readTree(original)
    const copy = await copyOf('gone-lib')
    const { operationId } = await run({ action: 'collect', skillName: 'gone-lib', sourceId: copy.sourceId, keep: 'source' })
    await run({ action: 'delete', toolId: 'all', skillName: 'gone-lib' })
    expect((await stateOf(operationId)).state).toBe('library-deleted')
    const error = await rejection(run({ action: 'undo', operationId }, {
      collectHook: async (stepId, phase) => { if (stepId === 'remove-source' && phase === 'revert-before') throw crash() },
    }))
    expect(error?.code).toBe('CRASH')
    const result = await run({ action: 'resume', operationId })
    expect(result.outcome).toBe('done')
    expect(await exists(path.join(env.repoPath, 'gone-lib')), 'UNDO_MODE_KEPT 资产库已删的不放回').toBe(false)
    expect(await readTree(original), 'UNDO_MODE_KEPT 原件放回').toEqual(originalTree)
  })

  it('TC-031 PROJECT_GONE 原项目整个不在了：撤回不重建项目；撤到一半时继续恢复也不重建', async () => {
    const p2 = path.join(env.homeDir, 'work', 'p2')
    await fs.mkdir(p2, { recursive: true })
    await fs.writeFile(path.join(env.homeDir, '.claude.json'), JSON.stringify({ projects: { [p1]: {}, [p2]: {} } }))
    await writeSkill(claudeIn(p1), 'moved-away', 'body')
    const first = await run({ action: 'collect', skillName: 'moved-away', sourceId: (await copyOf('moved-away')).sourceId })
    await fs.rm(p1, { recursive: true, force: true })
    expect((await stateOf(first.operationId)).reason, 'PROJECT_GONE 收进记录显示原因').toBe('project-gone')
    const error = await rejection(run({ action: 'undo', operationId: first.operationId }))
    expect(error?.code).toBe('UNDO_BLOCKED')
    expect(error?.reason).toBe('project-gone')
    expect(await exists(p1), 'PROJECT_GONE 不重建项目').toBe(false)

    await writeSkill(claudeIn(p2), 'half-gone', 'body')
    const second = await run({ action: 'collect', skillName: 'half-gone', sourceId: (await copyOf('half-gone')).sourceId })
    await rejection(run({ action: 'undo', operationId: second.operationId }, {
      collectHook: async (stepId, phase) => { if (stepId === 'enable' && phase === 'revert-after') throw crash() },
    }))
    await fs.rm(p2, { recursive: true, force: true })
    const resumeError = await rejection(run({ action: 'resume', operationId: second.operationId }))
    expect(resumeError?.code).toBe('RESUME_BLOCKED')
    expect(resumeError?.reason).toBe('project-gone')
    expect(await exists(p2), 'PROJECT_GONE 继续恢复也不重建项目').toBe(false)
  })
})

describe('开关、忽略与内部链接', () => {
  it('TC-032 CODEX_SLOT_GUARD Codex 全局位置是自己的文件夹或指向别处的链接：开启被挡，不调接口、不动那一份', async () => {
    await writeSkill(env.repoPath, 'own-folder', 'library')
    const folder = await writeSkill(path.join(env.homeDir, '.agents', 'skills'), 'own-folder', 'mine')
    const folderTree = await readTree(folder)
    await writeSkill(env.repoPath, 'own-link', 'library')
    const elsewhere = await writeSkill(path.join(env.homeDir, 'elsewhere'), 'own-link', 'elsewhere')
    await link(elsewhere, path.join(env.homeDir, '.agents', 'skills', 'own-link'))
    for (const name of ['own-folder', 'own-link']) {
      deps.codexSkillApi.calls.length = 0
      expect(await codeOf(run({ action: 'enable', toolId: 'codex', skillName: name })), `CODEX_SLOT_GUARD ${name} 应被挡`).toBe('SLOT_OCCUPIED')
      expect(deps.codexSkillApi.calls.filter((call) => call.op === 'write'), `CODEX_SLOT_GUARD ${name} 不写 Codex`).toEqual([])
    }
    expect(await readTree(folder)).toEqual(folderTree)
    expect(await isLinkTo(path.join(env.homeDir, '.agents', 'skills', 'own-link'), elsewhere)).toBe(true)
  })

  it('TC-033 IGNORE_CONCURRENT 不同名字同时忽略、同时取消忽略：一条都不丢', async () => {
    const copies = Array.from({ length: 12 }, (_, index) => ({
      name: `n-${index}`, toolId: 'claude-code', scope: 'project', projectName: 'p1', projectPath: p1,
      absolutePath: path.join(claudeIn(p1), `n-${index}`), displayPath: `~/work/p1/.claude/skills/n-${index}`,
    }))
    const added = await Promise.all(copies.map((copy) => ignoreStore.addIgnore(env.homeDir, copy)))
    expect((await ignoreStore.readIgnores(env.homeDir)).length, 'IGNORE_CONCURRENT 同时忽略 12 份').toBe(12)
    const extra = copies.map((copy) => ({ ...copy, name: `${copy.name}-x`, absolutePath: `${copy.absolutePath}-x` }))
    await Promise.all([
      ...added.slice(0, 6).map((entry) => ignoreStore.removeIgnore(env.homeDir, entry.ignoreId)),
      ...extra.map((copy) => ignoreStore.addIgnore(env.homeDir, copy)),
    ])
    const names = (await ignoreStore.readIgnores(env.homeDir)).map((entry) => entry.name).sort()
    expect(names, 'IGNORE_CONCURRENT 同时取消与新增').toEqual([...copies.slice(6).map((copy) => copy.name), ...extra.map((copy) => copy.name)].sort())
  })

  it('TC-034 INTERNAL_LINK Skill 里有内部链接：资产库照原样放链接；收进到一半强退能继续恢复', async () => {
    const original = await writeSkill(claudeIn(p1), 'with-link', 'body', { 'notes/v1.md': 'v1' })
    await fs.symlink('notes/v1.md', path.join(original, 'latest.md'))
    const originalTree = await readTree(original)
    const copy = await copyOf('with-link')
    const done = await run({ action: 'collect', skillName: 'with-link', sourceId: copy.sourceId })
    const stat = await fs.lstat(path.join(env.repoPath, 'with-link', 'latest.md'))
    expect(stat.isSymbolicLink(), 'INTERNAL_LINK 资产库里仍是链接').toBe(true)
    expect(await fs.readlink(path.join(env.repoPath, 'with-link', 'latest.md'))).toBe('notes/v1.md')
    expect((await stateOf(done.operationId)).state, 'INTERNAL_LINK 收进后可撤回').toBe('undoable')
    await run({ action: 'undo', operationId: done.operationId })
    expect(await readTree(original)).toEqual(originalTree)

    const again = await copyOf('with-link')
    const error = await rejection(run({ action: 'collect', skillName: 'with-link', sourceId: again.sourceId }, {
      collectHook: async (stepId, phase) => { if (stepId === 'library' && phase === 'apply-unsaved') throw crash() },
    }))
    expect(error?.code).toBe('CRASH')
    const result = await run({ action: 'resume', operationId: error.operationId })
    expect(result.outcome, 'INTERNAL_LINK 继续恢复').toBe('done')
    expect(await exists(path.join(env.repoPath, 'with-link'))).toBe(false)
    expect(await readTree(original)).toEqual(originalTree)
  })

  it('TC-035 REFRESH_TOOLS 只涉及 Claude 的「换成这一份」和删除：不调 Codex', async () => {
    const handlers = {}
    const codexApi = createFakeCodexApi({ homeDir: env.homeDir })
    registerSkillControlHandlers({ ipcMain: { handle: (channel, fn) => { handlers[channel] = fn } }, homeDir: env.homeDir }, { codexSkillApi: codexApi })
    await writeSkill(env.repoPath, 'claude-only', 'library v1')
    await link(path.join(env.repoPath, 'claude-only'), path.join(env.homeDir, '.claude', 'skills', 'claude-only'))
    await writeSkill(claudeIn(p1), 'claude-only', 'project v2')
    await writeSkill(env.repoPath, 'to-delete', 'library')
    await link(path.join(env.repoPath, 'to-delete'), path.join(env.homeDir, '.claude', 'skills', 'to-delete'))
    const first = (await handlers['skill-control:get-snapshot']({}, {})).data
    const copy = first.inbox.items.find((item) => item.name === 'claude-only').copies[0]
    codexApi.calls.length = 0
    const collected = await handlers['skill-control:execute']({}, { action: 'collect', skillName: 'claude-only', sourceId: copy.sourceId, keep: 'source' })
    expect(collected.data.outcome).toBe('done')
    expect(codexApi.calls, 'REFRESH_TOOLS 只涉及 Claude 的换成这一份不调 Codex').toEqual([])
    const deleted = await handlers['skill-control:execute']({}, { action: 'delete', toolId: 'all', skillName: 'to-delete' })
    expect(deleted.success).toBe(true)
    expect(codexApi.calls, 'REFRESH_TOOLS 只在 Claude 里的删除不调 Codex').toEqual([])
    expect((await readClaudeSettings(env.homeDir)).theme).toBe('dark')
  })
})
