/**
 * #81 子代理不算进「近 30 天 N 次」，明细里合成一行（2026-11-20 用户选 B）。
 * 主数字和调用记录只数主会话（用户自己）的加载；同一主会话、同一工具、时间挨着（相邻不超过 10 分钟）的子代理加载合成一行，
 * 数的是不同子代理的个数。日志与存储都在隔离目录，通过生产统计入口断言。
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { scanSkillRunSamples, listSkillInvocationRecords } = require('../../electron/services/skillRunSampleService')
const NOW = new Date('2026-10-07T12:00:00.000Z')
const MINUTE = 60_000
const at = (minutesAgo) => new Date(NOW.getTime() - minutesAgo * MINUTE).toISOString()
const BODY = '---\nname: alpha\n---\n# Instructions\nApply these instructions to the current task.\n'
let sandbox
let homeDir
let env

const deps = () => ({ homeDir, env, storeDir: path.join(sandbox, 'derived'), nowFn: () => NOW })
const ledgerPath = () => path.join(sandbox, 'legacy', 'skill-runs.jsonl')
const scan = (names = ['alpha']) => scanSkillRunSamples(deps(), { windowDays: 30, skillNames: names, ledgerPath: ledgerPath() })
const skillOf = (data, name = 'alpha') => data.skills.find((entry) => entry.name === name)
const runsOf = (data, name = 'alpha') => (data.subagentRuns || []).filter((run) => run.skillName === name)
  .sort((a, b) => a.triggeredAt.localeCompare(b.triggeredAt))

async function jsonl(file, rows) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
}
async function install(name = 'alpha') {
  const target = path.join(homeDir, 'Documents', 'SkillManager', name, 'SKILL.md')
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, BODY.replace('name: alpha', 'name: ' + name))
  return target
}

// Claude：主会话一个文件；子代理在 <会话>/subagents/agent-<id>.jsonl，sessionId 同主会话，带 agentId 和 isSidechain
const claudeMain = (sessionId) => path.join(env.CLAUDE_CONFIG_DIR, 'projects', '-demo', sessionId + '.jsonl')
const claudeAgent = (sessionId, agentId) => path.join(env.CLAUDE_CONFIG_DIR, 'projects', '-demo', sessionId, 'subagents', 'agent-' + agentId + '.jsonl')
function claudeStart(sessionId, extra = {}) {
  return { type: 'user', uuid: 'initial-' + sessionId + (extra.agentId || ''), sessionId, timestamp: at(600),
    entrypoint: 'cli', version: '2.1.292', isSidechain: false, userType: 'external',
    cwd: path.join(sandbox, 'project'), message: { role: 'user', content: 'Perform the task.' }, ...extra }
}
function claudeRead(sessionId, id, target, when, extra = {}) {
  return [
    { type: 'assistant', uuid: 'call-' + id, timestamp: when, sessionId, ...extra,
      message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: target } }] } },
    { type: 'user', uuid: 'result-' + id, timestamp: when, sessionId, ...extra,
      message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: false, content: BODY }] } },
  ]
}
async function claudeSession(sessionId, target, readsAt) {
  await jsonl(claudeMain(sessionId), [claudeStart(sessionId),
    ...readsAt.flatMap((when, index) => claudeRead(sessionId, sessionId + '-read-' + index, target, when))])
}
async function claudeSubagent(sessionId, agentId, target, readsAt) {
  const extra = { agentId, isSidechain: true }
  await jsonl(claudeAgent(sessionId, agentId), [claudeStart(sessionId, extra),
    ...readsAt.flatMap((when, index) => claudeRead(sessionId, agentId + '-read-' + index, target, when, extra))])
}

// Codex：每个线程一个文件；子线程的 session_meta 带父线程号
const codexFile = (id) => path.join(env.CODEX_HOME, 'sessions', '2026', '10', id + '.jsonl')
function codexStart(id, extra = {}) {
  return { type: 'session_meta', timestamp: at(600),
    payload: { id, originator: 'Codex Desktop', source: 'vscode', cli_version: '0.159.0', cwd: path.join(sandbox, 'project'), ...extra } }
}
function codexRead(id, target, when) {
  return [
    { type: 'response_item', timestamp: when, payload: { type: 'function_call', call_id: id, name: 'exec_command',
      arguments: JSON.stringify({ cmd: "cat '" + target + "'" }) } },
    { type: 'response_item', timestamp: when, payload: { type: 'function_call_output', call_id: id,
      output: 'Process exited with code 0\nFinal output:\n' + BODY } },
  ]
}
async function codexThread(id, target, readsAt, parent = null) {
  const extra = parent ? { source: { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1 } } } } : {}
  await jsonl(codexFile(id), [codexStart(id, extra), ...readsAt.flatMap((when, index) => codexRead(id + '-read-' + index, target, when))])
}

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'codepal-subagent-counts-'))
  homeDir = path.join(sandbox, 'home')
  env = { CLAUDE_CONFIG_DIR: path.join(homeDir, '.claude'), CODEX_HOME: path.join(homeDir, '.codex') }
  await fs.mkdir(homeDir, { recursive: true })
})
afterEach(async () => { await fs.rm(sandbox, { recursive: true, force: true }) })

describe('#81 子代理不进主数字', () => {
  it('Claude：主会话读 1 次，同一会话 2 分钟内派出 11 个子代理各读一次 → 主数字 1，子代理合成一行写 11 个', async () => {
    const target = await install()
    await claudeSession('main', target, [at(240)])
    for (let index = 0; index < 11; index += 1)
      await claudeSubagent('main', 'agent' + index, target, [new Date(Date.parse(at(220)) + index * 10_000).toISOString()])
    const data = await scan()
    expect(skillOf(data)).toMatchObject({ total: 1, confirmedTotal: 1, claude: 1, codex: 0 })
    expect(data.records).toHaveLength(1)
    expect(data.totals).toMatchObject({ total: 1, claude: 1, codex: 0 })
    const runs = runsOf(data)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ tool: 'claude', agentCount: 11, triggeredAt: at(220) })
  })

  it('Codex：父线程读 1 次，3 个子线程各读一次 → 主数字 1，子代理合成一行写 3 个', async () => {
    const target = await install()
    await codexThread('parent', target, [at(300)])
    await codexThread('child-a', target, [at(290)], 'parent')
    await codexThread('child-b', target, [at(289)], 'parent')
    await codexThread('child-c', target, [at(287)], 'parent')
    const data = await scan()
    expect(skillOf(data)).toMatchObject({ total: 1, claude: 0, codex: 1 })
    expect(data.records).toHaveLength(1)
    const runs = runsOf(data)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ tool: 'codex', agentCount: 3, triggeredAt: at(290) })
  })

  it('topic-to-point 那种组合：主会话 Claude 1 + Codex 2，子代理 11 + 3 → 主数字 3，子代理两行', async () => {
    const target = await install()
    await claudeSession('claude-main', target, [at(250)])
    for (let index = 0; index < 11; index += 1)
      await claudeSubagent('claude-main', 'eval' + index, target, [new Date(Date.parse(at(240)) + index * 10_000).toISOString()])
    await codexThread('codex-long', target, [at(200), at(30)])
    await codexThread('review-parent', target, [])
    for (const id of ['review-1', 'review-2', 'review-3']) await codexThread(id, target, [at(260)], 'review-parent')
    const data = await scan()
    expect(skillOf(data)).toMatchObject({ total: 3, claude: 1, codex: 2 })
    expect(data.totals.total).toBe(3)
    expect(runsOf(data).map((run) => [run.tool, run.agentCount])).toEqual([['codex', 3], ['claude', 11]])
  })

  it('同一主会话两波派出隔了 10 分钟以上 → 两行；不同主会话各派各的 → 各一行', async () => {
    const target = await install()
    await claudeSession('one', target, [])
    await claudeSubagent('one', 'w1a', target, [at(300)])
    await claudeSubagent('one', 'w1b', target, [at(295)])
    await claudeSubagent('one', 'w2a', target, [at(284)])
    await claudeSession('two', target, [])
    await claudeSubagent('two', 'x1', target, [at(294)])
    const data = await scan()
    expect(skillOf(data)?.total).toBe(0)
    expect(runsOf(data).map((run) => [run.triggeredAt, run.agentCount])).toEqual([[at(300), 2], [at(294), 1], [at(284), 1]])
  })

  it('相邻子代理正好隔 10 分钟仍算同一次，多 1 毫秒就分开', async () => {
    const target = await install()
    await claudeSession('edge', target, [])
    await claudeSubagent('edge', 'e1', target, [at(300)])
    await claudeSubagent('edge', 'e2', target, [at(290)])
    await claudeSubagent('edge', 'e3', target, [new Date(Date.parse(at(280)) + 1).toISOString()])
    const data = await scan()
    expect(runsOf(data).map((run) => run.agentCount)).toEqual([2, 1])
  })

  it('同一个子代理读了两次只算 1 个子代理', async () => {
    const target = await install()
    await claudeSession('main', target, [])
    await claudeSubagent('main', 'twice', target, [at(300), at(299)])
    await claudeSubagent('main', 'other', target, [at(298)])
    const data = await scan()
    expect(runsOf(data)).toHaveLength(1)
    expect(runsOf(data)[0].agentCount).toBe(2)
  })

  it('只被子代理读过的 skill 主数字是 0，其它 skill 不受影响', async () => {
    const alpha = await install('alpha')
    const beta = await install('beta')
    await claudeSession('main', beta, [at(400), at(100)])
    await claudeSubagent('main', 'only', alpha, [at(300)])
    const data = await scan(['alpha', 'beta'])
    expect(skillOf(data, 'alpha')).toMatchObject({ total: 0, lastUsed: null })
    expect(skillOf(data, 'beta')).toMatchObject({ total: 2 })
    expect(runsOf(data, 'alpha')).toHaveLength(1)
    expect(runsOf(data, 'beta')).toHaveLength(0)
  })

  it('单个 skill 的明细带同一批的子代理行，只回这个 skill 的', async () => {
    const alpha = await install('alpha')
    const beta = await install('beta')
    await claudeSession('main', alpha, [at(400)])
    for (const id of ['a1', 'a2']) await claudeSubagent('main', id, alpha, [at(300)])
    await claudeSubagent('main', 'b1', beta, [at(300)])
    const data = await scan(['alpha', 'beta'])
    const assetId = skillOf(data, 'alpha').assetId
    const detail = await listSkillInvocationRecords(deps(), { assetId, batchId: data.batchId, windowDays: 30, ledgerPath: ledgerPath() })
    expect(detail.records).toHaveLength(1)
    expect(detail.subagentRuns).toHaveLength(1)
    expect(detail.subagentRuns[0]).toMatchObject({ assetId, agentCount: 2, tool: 'claude' })
  })
})
