/**
 * Skill invocation scanner — 稳定 ID 与 logical 去重测试
 *
 * 覆盖冻结合同：Codex 双写、真实重复、窗口/行号稳定性、Claude canonical session、
 * tool_use item.id 以及禁止有限截尾。
 *
 * @module 自动化测试/skill-usage/tests/backend/skillInvocationScanner.test
 */

import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { scanSkillInvocations } = require('../../../../electron/services/skillInvocationScannerService')

const DAY = 86400000
const SKILLS = ['goal-setter', 'git-push']

async function writeJsonl(file, records) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n')
}

function codexMeta(id, extra = {}) {
  return {
    type: 'session_meta',
    timestamp: '2026-07-01T00:00:00.000Z',
    payload: { id, ...extra },
  }
}

function codexUser(timestamp, text, raw = 'event') {
  if (raw === 'response') {
    return {
      type: 'response_item',
      timestamp,
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    }
  }
  return { type: 'event_msg', timestamp, payload: { type: 'user_message', message: text } }
}

describe('skillInvocationScannerService', () => {
  let home
  let now
  let nowFn

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-invocation-scanner-'))
    now = new Date('2026-07-26T12:00:00.000Z')
    nowFn = () => now
  })

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true })
  })

  it('Codex 仅合并不同 rawType 的 2 秒内双写；同 rawType 与长间隔都保留', async () => {
    const id = '11111111-1111-4111-8111-111111111111'
    const file = path.join(home, '.codex', 'sessions', '2026', '07', '25', `rollout-${id}.jsonl`)
    const base = now.getTime() - DAY
    const text = '请用 $goal-setter 收敛目标'
    await writeJsonl(file, [
      codexMeta(id),
      codexUser(new Date(base).toISOString(), text, 'response'),
      codexUser(new Date(base + 1).toISOString(), text, 'event'),
      codexUser(new Date(base + 5000).toISOString(), text, 'event'),
      codexUser(new Date(base + 600000).toISOString(), text, 'response'),
    ])

    const result = await scanSkillInvocations(
      { homeDir: home, nowFn },
      { windowDays: 30, skillNames: SKILLS }
    )

    expect(result.diagnostics.rawEventCount).toBe(4)
    expect(result.diagnostics.logicalRecordCount).toBe(3)
    expect(result.invocations).toHaveLength(3)
    expect(new Set(result.invocations.map((item) => item.invocationId)).size).toBe(3)
  })

  it('Codex 单条消息同时触发两个 skill 时，A B A B 双写各只记一次', async () => {
    const id = '11111111-1111-4111-8111-111111111112'
    const file = path.join(home, '.codex', 'sessions', '2026', '07', '25', `rollout-${id}.jsonl`)
    const base = now.getTime() - DAY
    const text = '先用 $goal-setter 整理，再用 $git-push 推送'
    await writeJsonl(file, [
      codexMeta(id),
      codexUser(new Date(base).toISOString(), text, 'response'),
      codexUser(new Date(base + 1).toISOString(), text, 'event'),
    ])

    const result = await scanSkillInvocations(
      { homeDir: home, nowFn },
      { windowDays: 30, skillNames: SKILLS }
    )

    expect(result.diagnostics.rawEventCount).toBe(4)
    expect(result.diagnostics.logicalRecordCount).toBe(2)
    expect(result.invocations.map((item) => item.skillName).sort()).toEqual(SKILLS.toSorted())
  })

  it('同 session 同文本真实调用两次得到稳定的两个 ID，行号偏移和窗口滑动不改 ID', async () => {
    const id = '22222222-2222-4222-8222-222222222222'
    const file = path.join(home, '.codex', 'sessions', '2026', '07', '25', `rollout-${id}.jsonl`)
    const firstAt = new Date(now.getTime() - 5 * DAY).toISOString()
    const secondAt = new Date(now.getTime() - 4 * DAY).toISOString()
    const text = '用 $git-push 推送'
    const records = [
      codexMeta(id),
      codexUser(firstAt, text),
      codexUser(secondAt, text),
    ]
    await writeJsonl(file, records)

    const first = await scanSkillInvocations(
      { homeDir: home, nowFn },
      { windowDays: 30, skillNames: SKILLS }
    )
    const firstIds = first.invocations.map((item) => item.invocationId)

    await writeJsonl(file, [
      { type: 'event_msg', timestamp: '2026-01-01T00:00:00.000Z', payload: { type: 'agent_message', message: 'padding' } },
      ...records,
      { type: 'event_msg', timestamp: now.toISOString(), payload: { type: 'agent_message', message: 'append' } },
    ])
    const shifted = await scanSkillInvocations(
      { homeDir: home, nowFn: () => new Date(now.getTime() + DAY) },
      { windowDays: 29, skillNames: SKILLS }
    )

    expect(firstIds).toHaveLength(2)
    expect(shifted.invocations.map((item) => item.invocationId)).toEqual(firstIds)
    expect(shifted.invocations.map((item) => item.sourceLine)).toEqual([3, 4])
  })

  it('Claude 主 transcript 用 sessionId，agent transcript 用 agentId，tool_use 用 item.id 稳定生成 ID', async () => {
    const root = path.join(home, '.claude', 'projects', 'project-a')
    const mainFile = path.join(root, 'main.jsonl')
    const agentFile = path.join(root, 'agent-child.jsonl')
    const timestamp = new Date(now.getTime() - DAY).toISOString()
    await writeJsonl(mainFile, [{
      type: 'assistant',
      timestamp,
      sessionId: 'claude-main-session',
      agentId: 'replayed-agent-id-must-not-win',
      message: {
        content: [{
          id: 'toolu_stable_1',
          type: 'tool_use',
          name: 'Skill',
          input: { skill: 'git-push' },
        }],
      },
    }])
    await writeJsonl(agentFile, [{
      type: 'user',
      timestamp,
      sessionId: 'claude-main-session',
      agentId: 'claude-agent-child',
      message: { content: '<command-name>/goal-setter</command-name> 收敛' },
    }])

    const first = await scanSkillInvocations(
      { homeDir: home, nowFn },
      { windowDays: 30, skillNames: SKILLS }
    )
    const bySkill = Object.fromEntries(first.invocations.map((item) => [item.skillName, item]))

    expect(bySkill['git-push'].session.id).toBe('claude-main-session')
    expect(bySkill['goal-setter'].session.id).toBe('claude-agent-child')

    const originalId = bySkill['git-push'].invocationId
    await writeJsonl(mainFile, [
      { type: 'progress', timestamp: '2026-01-01T00:00:00.000Z' },
      {
        type: 'assistant',
        timestamp: new Date(Date.parse(timestamp) + 5000).toISOString(),
        sessionId: 'claude-main-session',
        message: {
          content: [{
            id: 'toolu_stable_1',
            type: 'tool_use',
            name: 'Skill',
            input: { skill: 'git-push' },
          }],
        },
      },
    ])
    const second = await scanSkillInvocations(
      { homeDir: home, nowFn },
      { windowDays: 30, skillNames: SKILLS }
    )
    expect(second.invocations.find((item) => item.skillName === 'git-push').invocationId).toBe(originalId)
  })

  it('有限 maxLinesPerFile 必须显式失败', async () => {
    await expect(scanSkillInvocations(
      { homeDir: home, nowFn },
      { windowDays: 30, skillNames: SKILLS, maxLinesPerFile: 1000 }
    )).rejects.toThrow('SKILL_INVOCATION_REQUIRES_FULL_TRANSCRIPT')
  })

  it('来源文件超限时保留明确的 source error code', async () => {
    const root = path.join(home, '.codex', 'sessions')
    await writeJsonl(path.join(root, 'one.jsonl'), [codexMeta('93000000-0000-4000-8000-000000000001')])
    await writeJsonl(path.join(root, 'two.jsonl'), [codexMeta('93000000-0000-4000-8000-000000000002')])

    const result = await scanSkillInvocations(
      { homeDir: home, nowFn },
      { windowDays: 30, skillNames: SKILLS, maxFilesPerSource: 1 }
    )

    expect(result.sources.codex).toBe('error')
    expect(result.diagnostics.sourceErrors.codex).toBe('SKILL_INVOCATION_MAX_FILES_EXCEEDED')
  })

  it('Claude slash 与 tool_use 分别计数，并报告同 session 60 秒 overlap', async () => {
    const file = path.join(home, '.claude', 'projects', 'project-overlap', 'session.jsonl')
    const base = now.getTime() - DAY
    await writeJsonl(file, [
      {
        type: 'user',
        timestamp: new Date(base).toISOString(),
        sessionId: 'claude-overlap',
        message: { content: '<command-name>/goal-setter</command-name> 收敛' },
      },
      {
        type: 'assistant',
        timestamp: new Date(base + 30000).toISOString(),
        sessionId: 'claude-overlap',
        message: {
          content: [{
            id: 'toolu_overlap',
            type: 'tool_use',
            name: 'Skill',
            input: { skill: 'goal-setter' },
          }],
        },
      },
    ])

    const result = await scanSkillInvocations(
      { homeDir: home, nowFn },
      { windowDays: 30, skillNames: SKILLS }
    )

    expect(result.invocations).toHaveLength(2)
    expect(result.diagnostics.claudeSlashToolUseOverlapCount).toBe(1)
  })

  it('自定义 CODEX_HOME 能发现 invocation', async () => {
    const id = '91000000-0000-4000-8000-000000000001'
    const codexHome = path.join(home, 'custom-codex')
    const file = path.join(codexHome, 'sessions', '2026', '07', `rollout-${id}.jsonl`)
    await writeJsonl(file, [
      codexMeta(id),
      codexUser(new Date(now.getTime() - DAY).toISOString(), '用 $git-push 推送'),
    ])

    const result = await scanSkillInvocations(
      { homeDir: home, env: { CODEX_HOME: codexHome }, nowFn },
      { windowDays: 30, skillNames: SKILLS }
    )

    expect(result.sources).toEqual({ claude: 'missing', codex: 'ok' })
    expect(result.invocations[0]).toMatchObject({
      skillName: 'git-push',
      session: { id },
    })
  })

  it('≥100MB rollout 使用流式路径完成扫描并读到末尾 invocation', async () => {
    const id = '92000000-0000-4000-8000-000000000001'
    const file = path.join(home, '.codex', 'sessions', '2026', '07', `rollout-${id}.jsonl`)
    await fs.mkdir(path.dirname(file), { recursive: true })
    const handle = await fs.open(file, 'w')
    try {
      await handle.writeFile(`${JSON.stringify(codexMeta(id))}\n`)
      const payload = 'x'.repeat(1024 * 1024)
      for (let index = 0; index < 100; index += 1) {
        await handle.writeFile(`${JSON.stringify({
          type: 'event_msg',
          timestamp: new Date(now.getTime() - DAY).toISOString(),
          payload: { type: 'agent_message', message: payload },
        })}\n`)
      }
      await handle.writeFile(`${JSON.stringify(
        codexUser(new Date(now.getTime() - DAY).toISOString(), '末尾调用 $goal-setter')
      )}\n`)
    } finally {
      await handle.close()
    }

    const stat = await fs.stat(file)
    expect(stat.size).toBeGreaterThanOrEqual(100 * 1024 * 1024)
    const result = await scanSkillInvocations(
      { homeDir: home, nowFn },
      { windowDays: 30, skillNames: SKILLS }
    )
    const readFileSpy = vi.spyOn(fs, 'readFile')
    const streamedResult = await scanSkillInvocations(
      { homeDir: home, nowFn },
      { windowDays: 30, skillNames: SKILLS }
    )
    expect(result.invocations).toHaveLength(1)
    expect(result.invocations[0].sourceLine).toBe(102)
    expect(streamedResult.invocations).toHaveLength(1)
    expect(readFileSpy).not.toHaveBeenCalled()
    readFileSpy.mockRestore()
  }, 30000)
})
