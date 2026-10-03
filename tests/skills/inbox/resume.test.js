/**
 * Skills 要处理（specs/v2.1.11-Skills要处理-实现）：没做完与继续恢复
 *
 * 负责：
 * - TC-009：收进或撤回的每一步之后模拟强退（collectHook 抛 crash 错误，不走恢复，记录停在进行中）：
 *   之后读到的记录 state=partial；恢复好之前同名的开关、收进、忽略、删除都报 OPERATION_PARTIAL；
 *   resume 一步步核对后恢复到收进前（state=undone，用户文件逐字一致）；恢复途中原位置被放了新文件夹 →
 *   停在这一步、写明原因、不覆盖它，清掉后再 resume 成功；重复 resume 不再改任何东西
 * 所有写入只在临时家目录。
 *
 * @module tests/skills/inbox/resume.test
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { codeOf, createFakeCodexApi, makeHome, readTree, writeClaudeSettings, writeSkill } from './helpers.js'

const require = createRequire(import.meta.url)
const { getSkillControlSnapshot, executeSkillCommand } = require('../../../electron/services/skillControlService')

const COLLECT_STEPS = ['library', 'remove-source', 'link', 'enable']

let env
let deps
let project

beforeEach(async () => {
  env = await makeHome('resume')
  await fs.mkdir(path.join(env.homeDir, '.codex'), { recursive: true })
  project = path.join(env.homeDir, 'work', 'proj')
  await fs.mkdir(project, { recursive: true })
  await fs.writeFile(path.join(env.homeDir, '.claude.json'), JSON.stringify({ projects: { [project]: {} } }))
  await writeClaudeSettings(env.homeDir, { theme: 'dark' })
  deps = { codexSkillApi: createFakeCodexApi({ homeDir: env.homeDir }) }
})
afterEach(async () => { await env.cleanup() })

async function userTree() {
  const tree = await readTree(env.homeDir)
  const kept = Object.fromEntries(Object.entries(tree).filter(([key]) => !key.startsWith('Library/') && !key.startsWith('.claude/backups/')))
  if (kept['.claude/settings.json']) kept['.claude/settings.json'] = JSON.parse(kept['.claude/settings.json'])
  return kept
}
const run = (params, extra = {}) => executeSkillCommand({ repoPath: env.repoPath, homeDir: env.homeDir, ...params }, { ...deps, ...extra })
const snapshotOf = () => getSkillControlSnapshot({ repoPath: env.repoPath, homeDir: env.homeDir }, deps)
const crash = () => Object.assign(new Error('CRASH'), { code: 'CRASH', crash: true })
async function stateOf(operationId) {
  return (await snapshotOf()).operations.find((op) => op.operationId === operationId)
}
async function crashCollect(name, step) {
  const snap = await snapshotOf()
  const copy = snap.inbox.items.find((item) => item.name === name).copies[0]
  try {
    await run({ action: 'collect', skillName: name, sourceId: copy.sourceId, keep: copy.relation === 'diff' ? 'source' : undefined }, {
      collectHook: async (stepId, phase) => { if (stepId === step && phase === 'apply-after') throw crash() },
    })
  } catch (error) {
    return error.operationId
  }
  throw new Error('crash did not happen')
}

describe('没做完与继续恢复', () => {
  it('TC-009 RESUME_PARTIAL 收进每一步之后强退：partial、同名写操作被挡、resume 恢复到收进前', async () => {
    for (const step of COLLECT_STEPS) {
      const name = `crash-${step}`
      await writeSkill(env.repoPath, name, 'library v1')
      await writeSkill(path.join(project, '.claude', 'skills'), name, 'project v2')
      const before = await userTree()
      const operationId = await crashCollect(name, step)
      expect((await stateOf(operationId))?.state, `RESUME_PARTIAL ${step} 之后强退应是 partial`).toBe('partial')
      for (const params of [
        { action: 'enable', toolId: 'claude-code', skillName: name },
        { action: 'disable', toolId: 'claude-code', skillName: name },
        { action: 'delete', toolId: 'all', skillName: name },
      ]) {
        expect(await codeOf(run(params)), `RESUME_PARTIAL ${step} ${params.action} 应被挡`).toBe('OPERATION_PARTIAL')
      }
      const result = await run({ action: 'resume', operationId })
      expect(result.outcome, `RESUME_PARTIAL ${step} resume 应成功`).toBe('done')
      expect((await stateOf(operationId)).state).toBe('undone')
      expect(await userTree(), `RESUME_PARTIAL ${step} 恢复到收进前`).toEqual(before)
    }
  })

  it('TC-009 RESUME_PARTIAL 改完文件或配置、进度还没落盘就强退：全新服务实例认得出没做完并恢复；现场被改就停下', async () => {
    for (const step of COLLECT_STEPS) {
      const name = `unsaved-${step}`
      await writeSkill(env.repoPath, name, 'library v1')
      await writeSkill(path.join(project, '.claude', 'skills'), name, 'project v2')
      const before = await userTree()
      const snap = await snapshotOf()
      const copy = snap.inbox.items.find((item) => item.name === name).copies[0]
      let operationId = null
      try {
        await run({ action: 'collect', skillName: name, sourceId: copy.sourceId, keep: 'source' }, {
          collectHook: async (stepId, phase) => { if (stepId === step && phase === 'apply-unsaved') throw crash() },
        })
      } catch (error) { operationId = error.operationId }
      expect(operationId).toBeTruthy()
      // 全新的服务实例：进程里的状态全清掉，只靠磁盘上的记录
      for (const key of Object.keys(require.cache)) {
        if (key.includes(`${path.sep}electron${path.sep}`)) delete require.cache[key]
      }
      const fresh = require('../../../electron/services/skillControlService')
      const freshSnap = await fresh.getSkillControlSnapshot({ repoPath: env.repoPath, homeDir: env.homeDir }, deps)
      expect(freshSnap.operations.find((op) => op.operationId === operationId)?.state, `RESUME_PARTIAL ${step} 改完未记进度应是 partial`).toBe('partial')
      const result = await fresh.executeSkillCommand({ repoPath: env.repoPath, homeDir: env.homeDir, action: 'resume', operationId }, deps)
      expect(result.outcome, `RESUME_PARTIAL ${step} 改完未记进度也能恢复`).toBe('done')
      expect(await userTree(), `RESUME_PARTIAL ${step} 恢复到收进前`).toEqual(before)
    }

    // 资产库换成新版、还没记进度就强退，之后资产库又被人改了：恢复停在这一步，不覆盖
    await writeSkill(env.repoPath, 'unsaved-touched', 'library v1')
    await writeSkill(path.join(project, '.claude', 'skills'), 'unsaved-touched', 'project v2')
    const snap = await snapshotOf()
    const copy = snap.inbox.items.find((item) => item.name === 'unsaved-touched').copies[0]
    let operationId = null
    try {
      await run({ action: 'collect', skillName: 'unsaved-touched', sourceId: copy.sourceId, keep: 'source' }, {
        collectHook: async (stepId, phase) => { if (stepId === 'library' && phase === 'apply-unsaved') throw crash() },
      })
    } catch (error) { operationId = error.operationId }
    await fs.writeFile(path.join(env.repoPath, 'unsaved-touched', 'SKILL.md'), 'edited by someone')
    let error = null
    try { await run({ action: 'resume', operationId }) } catch (caught) { error = caught }
    expect(error?.code, 'RESUME_PARTIAL 现场被改应停下').toBe('RESUME_BLOCKED')
    expect(error?.reason).toBe('library-changed')
    expect(await fs.readFile(path.join(env.repoPath, 'unsaved-touched', 'SKILL.md'), 'utf8'), 'RESUME_PARTIAL 不覆盖别人的改动').toBe('edited by someone')
  })

  it('TC-009 RESUME_PARTIAL 撤回到一半强退：resume 继续撤完', async () => {
    const original = await writeSkill(path.join(project, '.claude', 'skills'), 'half-undo', 'body')
    const before = await userTree()
    const snap = await snapshotOf()
    const copy = snap.inbox.items.find((item) => item.name === 'half-undo').copies[0]
    const { operationId } = await run({ action: 'collect', skillName: 'half-undo', sourceId: copy.sourceId })
    let error = null
    try {
      await run({ action: 'undo', operationId }, {
        collectHook: async (stepId, phase) => { if (stepId === 'link' && phase === 'revert-after') throw crash() },
      })
    } catch (caught) { error = caught }
    expect(error?.code).toBe('CRASH')
    expect((await stateOf(operationId)).state, 'RESUME_PARTIAL 撤回到一半应 partial').toBe('partial')
    expect(await codeOf(run({ action: 'ignore', skillName: 'half-undo', sourceId: copy.sourceId })), 'RESUME_PARTIAL 忽略也被挡').toBe('OPERATION_PARTIAL')
    const result = await run({ action: 'resume', operationId })
    expect(result.outcome).toBe('done')
    expect(await userTree()).toEqual(before)
    expect(await readTree(original)).toBeTruthy()
  })

  it('TC-009 RESUME_PARTIAL 恢复时原位置被放了新文件夹：停下不覆盖，清掉后再 resume；重复 resume 不再改东西', async () => {
    await writeSkill(path.join(project, '.claude', 'skills'), 'stuck', 'original body')
    const before = await userTree()
    const operationId = await crashCollect('stuck', 'remove-source')
    const intruder = await writeSkill(path.join(project, '.claude', 'skills'), 'stuck', 'someone else')
    const intruderTree = await readTree(intruder)
    let error = null
    try { await run({ action: 'resume', operationId }) } catch (caught) { error = caught }
    expect(error?.code, 'RESUME_PARTIAL 现场对不上应停下').toBe('RESUME_BLOCKED')
    expect(error?.reason).toBe('source-occupied')
    expect(await readTree(intruder), 'RESUME_PARTIAL 不覆盖后来放的文件夹').toEqual(intruderTree)
    expect((await stateOf(operationId)).state).toBe('partial')

    await fs.rm(intruder, { recursive: true, force: true })
    const result = await run({ action: 'resume', operationId })
    expect(result.outcome).toBe('done')
    expect(await userTree()).toEqual(before)
    const again = await run({ action: 'resume', operationId })
    expect(again.outcome).toBe('done')
    expect(await userTree(), 'RESUME_PARTIAL 重复 resume 不再改东西').toEqual(before)
  })
})
