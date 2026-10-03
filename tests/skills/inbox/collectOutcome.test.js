/**
 * Skills 要处理（specs/v2.1.11-Skills要处理-实现）：收进的真实结果
 *
 * 负责：
 * - TC-006：每个写入步骤注入失败 → 全部恢复到收进前（rolled-back）；建链接只能复制 → rolled-back；
 *   恢复时也失败 → partial；写完了但随后读快照失败 → done-unverified（记录仍可撤回）；
 *   还没动用户文件就失败（原件被占用）→ not-run，不留收进记录
 * 失败注入经 deps.collectHook(stepId, phase)；所有写入只在临时家目录。
 *
 * @module tests/skills/inbox/collectOutcome.test
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { createFakeCodexApi, makeHome, readTree, writeClaudeSettings, writeSkill } from './helpers.js'

const require = createRequire(import.meta.url)
const { getSkillControlSnapshot, executeSkillCommand } = require('../../../electron/services/skillControlService')
const { registerSkillControlHandlers } = require('../../../electron/handlers/registerSkillControlHandlers')

const STEPS = ['library', 'remove-source', 'link', 'enable']

let env
let deps
let project

beforeEach(async () => {
  env = await makeHome('outcome')
  await fs.mkdir(path.join(env.homeDir, '.codex'), { recursive: true })
  project = path.join(env.homeDir, 'work', 'proj')
  await fs.mkdir(project, { recursive: true })
  await fs.writeFile(path.join(env.homeDir, '.claude.json'), JSON.stringify({ projects: { [project]: {} } }))
  await writeClaudeSettings(env.homeDir, { theme: 'dark' })
  deps = { codexSkillApi: createFakeCodexApi({ homeDir: env.homeDir }) }
})
afterEach(async () => { await env.cleanup() })

/**
 * 家目录里除 CodePal 数据目录以外的全部文件（备份、记录在数据目录里，不算用户文件）；
 * Claude 设置的写入代理每次写都会在 ~/.claude/backups 留一份备份，也不算；settings.json 按内容比
 */
async function userTree() {
  const tree = await readTree(env.homeDir)
  const kept = Object.fromEntries(Object.entries(tree).filter(([key]) => !key.startsWith('Library/') && !key.startsWith('.claude/backups/')))
  if (kept['.claude/settings.json']) kept['.claude/settings.json'] = JSON.parse(kept['.claude/settings.json'])
  return kept
}
const snapshotOf = (extra = {}) => getSkillControlSnapshot({ repoPath: env.repoPath, homeDir: env.homeDir }, { ...deps, ...extra })
async function projectCopy(name) {
  const snap = await snapshotOf()
  return snap.inbox.items.find((item) => item.name === name).copies[0]
}
async function attempt(params, extra = {}) {
  try {
    return { result: await executeSkillCommand({ repoPath: env.repoPath, homeDir: env.homeDir, action: 'collect', ...params }, { ...deps, ...extra }) }
  } catch (error) {
    return { error }
  }
}
const fail = (code) => Object.assign(new Error(code), { code })

describe('收进的真实结果', () => {
  it('TC-006 COLLECT_OUTCOME 每个写入步骤失败都整体恢复，outcome=rolled-back', async () => {
    for (const step of STEPS) {
      const name = `fail-${step}`
      await writeSkill(env.repoPath, `${name}`, 'library v1')
      await writeSkill(path.join(project, '.claude', 'skills'), name, 'project v2')
      const copy = await projectCopy(name)
      const before = await userTree()
      const { error } = await attempt({ skillName: name, sourceId: copy.sourceId, keep: 'source' }, {
        collectHook: async (stepId, phase) => { if (stepId === step && phase === 'apply-after') throw fail('INJECTED') },
      })
      expect(error?.outcome, `COLLECT_OUTCOME ${step} 失败后应 rolled-back`).toBe('rolled-back')
      expect(await userTree(), `COLLECT_OUTCOME ${step} 失败后用户文件应逐字恢复`).toEqual(before)
    }
  })

  it('TC-006 COLLECT_OUTCOME 这一项原来是只手动调用、打开工具之后失败：恢复后仍是只手动调用', async () => {
    await writeClaudeSettings(env.homeDir, { theme: 'dark', skillOverrides: { manual: 'user-invocable-only' } })
    await writeSkill(path.join(project, '.claude', 'skills'), 'manual', 'project only')
    const copy = await projectCopy('manual')
    const before = await userTree()
    const { error } = await attempt({ skillName: 'manual', sourceId: copy.sourceId }, {
      collectHook: async (stepId, phase) => { if (stepId === 'enable' && phase === 'apply-after') throw fail('INJECTED') },
    })
    expect(error?.outcome).toBe('rolled-back')
    expect(await userTree(), 'COLLECT_OUTCOME 只手动调用应原样恢复').toEqual(before)
  })

  it('TC-006 COLLECT_OUTCOME 建链接只能复制时按失败恢复', async () => {
    await writeSkill(path.join(project, '.claude', 'skills'), 'no-link', 'project only')
    const copy = await projectCopy('no-link')
    const before = await userTree()
    const { error } = await attempt({ skillName: 'no-link', sourceId: copy.sourceId }, {
      symlinkFn: async () => { throw fail('EPERM') },
    })
    expect(error?.code, 'COLLECT_OUTCOME 建不成链接').toBe('LINK_UNAVAILABLE')
    expect(error?.outcome).toBe('rolled-back')
    expect(await userTree()).toEqual(before)
  })

  it('TC-006 COLLECT_OUTCOME 恢复时也失败 → partial，记录 state=partial', async () => {
    await writeSkill(path.join(project, '.claude', 'skills'), 'half', 'project only')
    const copy = await projectCopy('half')
    const { error } = await attempt({ skillName: 'half', sourceId: copy.sourceId }, {
      collectHook: async (stepId, phase) => {
        if (stepId === 'enable' && phase === 'apply-after') throw fail('INJECTED')
        if (stepId === 'remove-source' && phase === 'revert-before') throw fail('RESTORE_BROKE')
      },
    })
    expect(error?.outcome, 'COLLECT_OUTCOME 恢复也失败应 partial').toBe('partial')
    const snap = await snapshotOf()
    expect(snap.operations.find((op) => op.operationId === error.operationId)?.state).toBe('partial')
  })

  it('TC-006 COLLECT_OUTCOME 原件被占用这类还没动手的失败 → not-run，不留记录', async () => {
    await writeSkill(path.join(project, '.claude', 'skills'), 'busy', 'project only')
    const copy = await projectCopy('busy')
    const before = await userTree()
    const { error } = await attempt({ skillName: 'busy', sourceId: copy.sourceId }, {
      collectHook: async (stepId, phase) => { if (stepId === 'backup-source' && phase === 'apply-before') throw fail('EBUSY') },
    })
    expect(error?.outcome, 'COLLECT_OUTCOME 没动手的失败应 not-run').toBe('not-run')
    expect(await userTree()).toEqual(before)
    expect((await snapshotOf()).operations).toEqual([])
  })

  it('TC-006 COLLECT_OUTCOME 写完了但随后读快照失败 → done-unverified，记录仍可撤回', async () => {
    await writeSkill(path.join(project, '.claude', 'skills'), 'unread', 'project only')
    const copy = await projectCopy('unread')
    const handlers = {}
    const ipcMain = { handle: (channel, fn) => { handlers[channel] = fn } }
    registerSkillControlHandlers({ ipcMain, homeDir: env.homeDir }, {
      ...deps,
      resolveSkillRepoPathFn: async () => `${env.repoPath}/`,
      getSkillControlSnapshotFn: async () => { throw fail('SCAN_BROKE') },
    })
    const response = await handlers['skill-control:execute']({}, { action: 'collect', skillName: 'unread', sourceId: copy.sourceId })
    expect(response.success).toBe(true)
    expect(response.data.outcome, 'COLLECT_OUTCOME 读快照失败应 done-unverified').toBe('done-unverified')
    const snap = await snapshotOf()
    expect(snap.operations.find((op) => op.operationId === response.data.operationId)?.state).toBe('undoable')
  })
})
