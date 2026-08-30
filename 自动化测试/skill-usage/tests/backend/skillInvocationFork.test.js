/**
 * Skill invocation scanner — Codex fork replay 去重测试
 *
 * 覆盖冻结合同：链式 fork、窗口外 parent、child suffix、parent 缺失与
 * parent_thread_id fallback。
 *
 * @module 自动化测试/skill-usage/tests/backend/skillInvocationFork.test
 */

import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'

const require = createRequire(import.meta.url)
const { scanSkillInvocations } = require('../../../../electron/services/skillInvocationScannerService')

const DAY = 86400000
const SKILLS = ['goal-setter', 'git-push']

async function writeJsonl(file, records) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n')
}

function meta(id, parentId, field = 'forked_from_id') {
  return {
    type: 'session_meta',
    timestamp: '2026-07-01T00:00:00.000Z',
    payload: { id, ...(parentId ? { [field]: parentId } : {}) },
  }
}

function calls(baseMs, texts) {
  return texts.map((text, index) => ({
    type: 'event_msg',
    timestamp: new Date(baseMs + index * 10000).toISOString(),
    payload: { type: 'user_message', message: text },
  }))
}

describe('Codex fork replay suppression', () => {
  let home
  let now
  let root

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-invocation-fork-'))
    now = new Date('2026-07-26T12:00:00.000Z')
    root = path.join(home, '.codex', 'sessions', '2026', '07', '25')
  })

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true })
  })

  it('根 → fork1 → fork2×3 的三次历史调用最终只保留根的 3 次', async () => {
    const ids = {
      root: '30000000-0000-4000-8000-000000000001',
      fork1: '30000000-0000-4000-8000-000000000002',
      fork2a: '30000000-0000-4000-8000-000000000003',
      fork2b: '30000000-0000-4000-8000-000000000004',
      fork2c: '30000000-0000-4000-8000-000000000005',
    }
    const texts = [
      '第一次 $goal-setter',
      '第二次 $goal-setter',
      '第三次 $git-push',
    ]
    const base = now.getTime() - DAY
    await writeJsonl(path.join(root, `rollout-${ids.root}.jsonl`), [meta(ids.root), ...calls(base, texts)])
    await writeJsonl(path.join(root, `rollout-${ids.fork1}.jsonl`), [meta(ids.fork1, ids.root), ...calls(base + 1000, texts)])
    for (const id of [ids.fork2a, ids.fork2b, ids.fork2c]) {
      await writeJsonl(path.join(root, `rollout-${id}.jsonl`), [meta(id, ids.fork1), ...calls(base + 2000, texts)])
    }

    const result = await scanSkillInvocations(
      { homeDir: home, nowFn: () => now },
      { windowDays: 30, skillNames: SKILLS }
    )

    expect(result.invocations).toHaveLength(3)
    expect(result.invocations.every((item) => item.session.id === ids.root)).toBe(true)
    expect(result.diagnostics.forkReplaySuppressedCount).toBe(12)
  })

  it('parent 文件 mtime 和调用时间都在窗口外，child 的新时间 replay 仍被消解，suffix 保留', async () => {
    const parentId = '40000000-0000-4000-8000-000000000001'
    const childId = '40000000-0000-4000-8000-000000000002'
    const parentFile = path.join(root, `rollout-${parentId}.jsonl`)
    const childFile = path.join(root, `rollout-${childId}.jsonl`)
    const oldBase = now.getTime() - 60 * DAY
    const recentBase = now.getTime() - DAY
    const replay = ['历史 $goal-setter', '历史 $git-push']

    await writeJsonl(parentFile, [meta(parentId), ...calls(oldBase, replay)])
    await fs.utimes(parentFile, new Date(oldBase), new Date(oldBase))
    await writeJsonl(childFile, [
      meta(childId, parentId, 'parent_thread_id'),
      ...calls(recentBase, [...replay, 'fork 后新增 $goal-setter']),
    ])

    const result = await scanSkillInvocations(
      { homeDir: home, nowFn: () => now },
      { windowDays: 30, skillNames: SKILLS }
    )

    expect(result.invocations).toHaveLength(1)
    expect(result.invocations[0]).toMatchObject({
      skillName: 'goal-setter',
      session: { id: childId },
    })
    expect(result.diagnostics.forkReplaySuppressedCount).toBe(2)
  })

  it('parent 不可定位时保留 child 并增加 unresolvedForkCount', async () => {
    const childId = '50000000-0000-4000-8000-000000000002'
    const missingId = '50000000-0000-4000-8000-000000000001'
    await writeJsonl(path.join(root, `rollout-${childId}.jsonl`), [
      meta(childId, missingId),
      ...calls(now.getTime() - DAY, ['保留 $goal-setter']),
    ])

    const result = await scanSkillInvocations(
      { homeDir: home, nowFn: () => now },
      { windowDays: 30, skillNames: SKILLS }
    )

    expect(result.invocations).toHaveLength(1)
    expect(result.invocations[0].session.id).toBe(childId)
    expect(result.diagnostics.unresolvedForkCount).toBe(1)
  })

  it('child 后文回放 parent session_meta 时仍以首条 child meta 为 canonical', async () => {
    const parentId = '60000000-0000-4000-8000-000000000001'
    const childId = '60000000-0000-4000-8000-000000000002'
    const replay = ['历史 $goal-setter']
    const base = now.getTime() - DAY
    await writeJsonl(path.join(root, `rollout-${parentId}.jsonl`), [
      meta(parentId),
      ...calls(base, replay),
    ])
    await writeJsonl(path.join(root, `rollout-${childId}.jsonl`), [
      meta(childId, parentId),
      ...calls(base + 1000, replay),
      meta(parentId),
      ...calls(base + 2000, ['child 新增 $git-push']),
    ])

    const result = await scanSkillInvocations(
      { homeDir: home, nowFn: () => now },
      { windowDays: 30, skillNames: SKILLS }
    )

    expect(result.diagnostics.unresolvedForkCount).toBe(0)
    expect(result.invocations).toHaveLength(2)
    expect(result.invocations.find((item) => item.skillName === 'git-push').session.id).toBe(childId)
  })

  it('parent transcript 后续 append 新调用时，旧 invocation ID 不变且只新增 parent 记录', async () => {
    const parentId = '70000000-0000-4000-8000-000000000001'
    const childId = '70000000-0000-4000-8000-000000000002'
    const parentFile = path.join(root, `rollout-${parentId}.jsonl`)
    const base = now.getTime() - DAY
    const replay = ['历史一 $goal-setter', '历史二 $git-push']
    await writeJsonl(parentFile, [meta(parentId), ...calls(base, replay)])
    await writeJsonl(path.join(root, `rollout-${childId}.jsonl`), [
      meta(childId, parentId),
      ...calls(base + 1000, replay),
    ])

    const first = await scanSkillInvocations(
      { homeDir: home, nowFn: () => now },
      { windowDays: 30, skillNames: SKILLS }
    )
    const firstIds = first.invocations.map((item) => item.invocationId)
    await fs.appendFile(parentFile, `${JSON.stringify(calls(base + 30000, ['parent 新增 $goal-setter'])[0])}\n`)

    const second = await scanSkillInvocations(
      { homeDir: home, nowFn: () => now },
      { windowDays: 30, skillNames: SKILLS }
    )

    expect(second.invocations).toHaveLength(3)
    expect(second.invocations.slice(0, 2).map((item) => item.invocationId)).toEqual(firstIds)
    expect(second.invocations.every((item) => item.session.id === parentId)).toBe(true)
    expect(second.diagnostics.forkReplaySuppressedCount).toBe(2)
  })
})
