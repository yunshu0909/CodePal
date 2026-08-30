/**
 * Skill 调用记录编排服务 — aggregate/detail 集成测试
 *
 * 覆盖：scanner → v2 ledger → aggregate、rejected diagnostics、四类显式信号、
 * 幂等重扫，以及 detail 只读 ledger + availability。
 *
 * @module 自动化测试/skill-usage/tests/backend/skillRunSampleService.test
 */

import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const require = createRequire(import.meta.url)
const {
  scanSkillRunSamples,
  listSkillInvocationRecords,
  loadSkillRunLedger,
} = require('../../../../electron/services/skillRunSampleService')

const DAY = 86400000
const SKILLS = ['goal-setter', 'git-push']

async function writeJsonl(file, records) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n')
}

describe('skillRunSampleService v2 orchestration', () => {
  let home
  let now
  let nowFn
  let ts

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-run-samples-v2-'))
    now = new Date('2026-07-26T14:17:34.000Z')
    nowFn = () => now
    ts = new Date(now.getTime() - DAY).toISOString()
  })

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true })
  })

  it('Codex 双写 2 raw → 1 logical → 1 invocation，重复扫描 ledger 幂等', async () => {
    const id = '81000000-0000-4000-8000-000000000001'
    const file = path.join(home, '.codex', 'sessions', '2026', '07', '25', `rollout-${id}.jsonl`)
    const text = '用 $goal-setter 帮我整理成可执行 goal'
    await writeJsonl(file, [
      { type: 'session_meta', timestamp: ts, payload: { id } },
      { type: 'response_item', timestamp: ts, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } },
      { type: 'event_msg', timestamp: new Date(Date.parse(ts) + 1).toISOString(), payload: { type: 'user_message', message: text } },
    ])

    const first = await scanSkillRunSamples(
      { homeDir: home, nowFn },
      { windowDays: 30, skillNames: SKILLS }
    )
    expect(first.diagnostics).toMatchObject({
      rawEventCount: 2,
      logicalRecordCount: 1,
    })
    expect(first.totals).toEqual({ total: 1, claude: 0, codex: 1 })
    expect(first.invocations).toHaveLength(1)
    expect(Object.keys(first.invocations[0])).toHaveLength(9)

    const firstLedger = await loadSkillRunLedger({ homeDir: home })
    await scanSkillRunSamples(
      { homeDir: home, nowFn },
      { windowDays: 30, skillNames: SKILLS }
    )
    await scanSkillRunSamples(
      { homeDir: home, nowFn },
      { windowDays: 30, skillNames: SKILLS }
    )
    const secondLedger = await loadSkillRunLedger({ homeDir: home })
    expect(secondLedger).toEqual(firstLedger)
  })

  it('Codex goal continuation 和 embedded plan 只进 diagnostics，不写 ledger', async () => {
    const file = path.join(home, '.codex', 'sessions', '2026', '07', '25', 'rejected.jsonl')
    await writeJsonl(file, [
      {
        type: 'response_item',
        timestamp: ts,
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '<codex_internal_context source="goal"><objective>[$goal-setter](path) 做目标</objective></codex_internal_context>' }],
        },
      },
      {
        type: 'event_msg',
        timestamp: new Date(Date.parse(ts) + 1000).toISOString(),
        payload: {
          type: 'user_message',
          message: 'PLEASE IMPLEMENT THIS PLAN: default_prompt="Use $goal-setter now."',
        },
      },
    ])

    const result = await scanSkillRunSamples(
      { homeDir: home, nowFn },
      { windowDays: 30, skillNames: SKILLS }
    )

    expect(result.totals.total).toBe(0)
    expect(result.diagnostics).toMatchObject({
      rawEventCount: 2,
      logicalRecordCount: 2,
      rejectedRecordCount: 2,
    })
    expect(await loadSkillRunLedger({ homeDir: home })).toEqual([])
  })

  it('/goal + $skill 保留为 goal_directive invocation', async () => {
    const file = path.join(home, '.codex', 'sessions', '2026', '07', '25', 'goal.jsonl')
    await writeJsonl(file, [{
      type: 'event_msg',
      timestamp: ts,
      payload: { type: 'user_message', message: '/goal [$goal-setter](path) 调研语音接入' },
    }])

    const result = await scanSkillRunSamples(
      { homeDir: home, nowFn },
      { windowDays: 30, skillNames: SKILLS }
    )
    expect(result.invocations[0]).toMatchObject({
      skillName: 'goal-setter',
      triggerType: 'goal_directive',
      tool: 'codex',
    })
  })

  it('Claude tool_use、Claude slash、Codex $skill 三类统一进入 ledger 聚合', async () => {
    const claudeFile = path.join(home, '.claude', 'projects', 'proj', 'claude-session.jsonl')
    const codexFile = path.join(home, '.codex', 'sessions', '2026', '07', '25', 'codex-session.jsonl')
    await writeJsonl(claudeFile, [
      {
        type: 'assistant',
        timestamp: ts,
        sessionId: 'claude-session',
        message: { content: [{ id: 'toolu_1', type: 'tool_use', name: 'Skill', input: { skill: 'git-push' } }] },
      },
      {
        type: 'user',
        timestamp: new Date(Date.parse(ts) + 1000).toISOString(),
        sessionId: 'claude-session',
        message: { content: '<command-name>/goal-setter</command-name> 帮我收敛目标' },
      },
    ])
    await writeJsonl(codexFile, [{
      type: 'event_msg',
      timestamp: new Date(Date.parse(ts) + 2000).toISOString(),
      payload: { type: 'user_message', message: '请用 $git-push 发版' },
    }])

    const result = await scanSkillRunSamples(
      { homeDir: home, nowFn },
      { windowDays: 30, skillNames: SKILLS }
    )
    const byName = Object.fromEntries(result.skills.map((skill) => [skill.name, skill]))

    expect(result.totals).toEqual({ total: 3, claude: 2, codex: 1 })
    expect(byName['git-push']).toMatchObject({ claude: 1, codex: 1, total: 2 })
    expect(byName['goal-setter']).toMatchObject({ claude: 1, codex: 0, total: 1 })
  })

  it('detail 只读 ledger 并对每条记录执行一次 access', async () => {
    const file = path.join(home, '.claude', 'projects', 'proj', 'claude-session.jsonl')
    await writeJsonl(file, [{
      type: 'user',
      timestamp: ts,
      sessionId: 'claude-session',
      message: { content: '<command-name>/goal-setter</command-name> 收敛' },
    }])
    await scanSkillRunSamples(
      { homeDir: home, nowFn },
      { windowDays: 30, skillNames: SKILLS }
    )
    const accessFn = vi.fn().mockResolvedValue(undefined)

    const detail = await listSkillInvocationRecords(
      { homeDir: home, nowFn, accessFn },
      { skillName: 'goal-setter', windowDays: 30 }
    )

    expect(detail.records).toHaveLength(1)
    expect(detail.records[0]).toMatchObject({
      skillName: 'goal-setter',
      sourceAvailable: 'available',
    })
    expect(accessFn).toHaveBeenCalledTimes(1)
  })

  it('relative path 失效时 aggregate 用唯一 session ID 修复路径', async () => {
    const id = '83000000-0000-4000-8000-000000000001'
    const original = path.join(home, '.codex', 'sessions', 'old', `rollout-${id}.jsonl`)
    const moved = path.join(home, '.codex', 'sessions', 'archive', `rollout-${id}.jsonl`)
    await writeJsonl(original, [
      { type: 'session_meta', timestamp: ts, payload: { id } },
      { type: 'event_msg', timestamp: ts, payload: { type: 'user_message', message: '用 $goal-setter 收敛' } },
    ])
    await scanSkillRunSamples(
      { homeDir: home, nowFn },
      { windowDays: 30, skillNames: SKILLS }
    )

    await fs.mkdir(path.dirname(moved), { recursive: true })
    await fs.rename(original, moved)
    const oldMtime = new Date(now.getTime() - 60 * DAY)
    await fs.utimes(moved, oldMtime, oldMtime)

    const result = await scanSkillRunSamples(
      { homeDir: home, nowFn },
      { windowDays: 30, skillNames: SKILLS }
    )
    const ledger = await loadSkillRunLedger({ homeDir: home })

    expect(result.diagnostics.repairedRelativePathCount).toBe(1)
    expect(ledger[0].session.relativePath).toBe(`archive/rollout-${id}.jsonl`)
  })

  it('日志 append 后仍 available；删除后数字保留但 detail 显示 missing', async () => {
    const file = path.join(home, '.claude', 'projects', 'proj', 'retained-session.jsonl')
    await writeJsonl(file, [{
      type: 'user',
      timestamp: ts,
      sessionId: 'retained-session',
      message: { content: '<command-name>/goal-setter</command-name> 收敛' },
    }])
    await scanSkillRunSamples(
      { homeDir: home, nowFn },
      { windowDays: 30, skillNames: SKILLS }
    )
    await fs.appendFile(file, `${JSON.stringify({ type: 'progress', timestamp: now.toISOString() })}\n`)

    const available = await listSkillInvocationRecords(
      { homeDir: home, nowFn },
      { skillName: 'goal-setter', windowDays: 30 }
    )
    expect(available.records[0].sourceAvailable).toBe('available')

    await fs.rm(file)
    const aggregate = await scanSkillRunSamples(
      { homeDir: home, nowFn },
      { windowDays: 30, skillNames: SKILLS }
    )
    const missing = await listSkillInvocationRecords(
      { homeDir: home, nowFn },
      { skillName: 'goal-setter', windowDays: 30 }
    )

    expect(aggregate.totals.total).toBe(1)
    expect(missing.records).toHaveLength(1)
    expect(missing.records[0].sourceAvailable).toBe('missing')
  })

  it('fork parent 后到时会删除此前 unresolved child replay 幽灵并保留 parent 真实记录', async () => {
    const parentId = '84000000-0000-4000-8000-000000000001'
    const childId = '84000000-0000-4000-8000-000000000002'
    const root = path.join(home, '.codex', 'sessions', '2026', '07', '25')
    const parentFile = path.join(root, `rollout-${parentId}.jsonl`)
    const childFile = path.join(root, `rollout-${childId}.jsonl`)
    const call = {
      type: 'event_msg',
      timestamp: ts,
      payload: { type: 'user_message', message: '历史 $goal-setter' },
    }
    await writeJsonl(childFile, [
      { type: 'session_meta', timestamp: ts, payload: { id: childId, forked_from_id: parentId } },
      call,
    ])

    const unresolved = await scanSkillRunSamples(
      { homeDir: home, nowFn },
      { windowDays: 30, skillNames: SKILLS }
    )
    expect(unresolved.totals.total).toBe(1)
    expect(unresolved.invocations[0].session.id).toBe(childId)

    await writeJsonl(parentFile, [
      { type: 'session_meta', timestamp: ts, payload: { id: parentId } },
      call,
    ])
    const resolved = await scanSkillRunSamples(
      { homeDir: home, nowFn },
      { windowDays: 30, skillNames: SKILLS }
    )

    expect(resolved.totals.total).toBe(1)
    expect(resolved.invocations[0].session.id).toBe(parentId)
    expect(resolved.diagnostics.reconciledReplayCount).toBe(1)
  })
})
