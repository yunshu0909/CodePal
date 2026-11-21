/**
 * #97 题 1 选 A（2026-11-21 Fable 5.2 与 Astra 替用户定）：以后格式认不出的调用不算进次数，
 * 只在这个技能的调用明细里提示「另有 N 次调用没认出来」。这里管后端怎么数：
 * - 两头都数、去重：「调用了、没找到正文」和「看到正文、配不上调用」是同一次的两头，只算一次；
 * - 报错 / 取消的调用、子代理、程序自动跑的会话、窗口外、旁边已经确认读过的，都不数；
 * - 有路径的只认资产库那一份，开发仓库里的同名技能不串过来。
 * 另：升级规则版本后，原日志已删的已确认次数照旧保留（v2.1.19 CASE-020）。
 * 记录全是编的假数据；日志与存储都在隔离目录，通过生产统计入口断言。
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { scanSkillRunSamples, listSkillInvocationRecords } = require('../../../electron/services/skillRunSampleService')
const NOW = new Date('2026-11-21T08:00:00.000Z')
const DAY = 24 * 60
const stamp = (minutes = 1) => new Date(NOW.getTime() - minutes * 60_000).toISOString()
const BODY = '---\nname: alpha\n---\n# Instructions\nApply these instructions to the current task.\n'
let sandbox
let homeDir
let env
let storeDir

const deps = () => ({ homeDir, env, storeDir, nowFn: () => NOW })
const ledgerPath = () => path.join(sandbox, 'legacy', 'skill-runs.jsonl')
const scan = (names = ['alpha']) => scanSkillRunSamples(deps(), { windowDays: 30, skillNames: names, ledgerPath: ledgerPath() })
const detail = (name = 'alpha') => listSkillInvocationRecords(deps(), { skillName: name, windowDays: 30, ledgerPath: ledgerPath() })
const claudeLog = (name) => path.join(env.CLAUDE_CONFIG_DIR, 'projects', '-demo', name + '.jsonl')

async function writeRows(file, rows) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
}
async function install(name = 'alpha', root = path.join(homeDir, 'Documents', 'SkillManager')) {
  const target = path.join(root, name, 'SKILL.md')
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, BODY.replace('name: alpha', 'name: ' + name))
  return target
}
const meta = (sessionId = 'root', extra = {}) => ({ type: 'user', uuid: 'initial-' + sessionId, sessionId, timestamp: stamp(200),
  entrypoint: 'cli', version: '2.9.0', isSidechain: false, userType: 'external',
  cwd: path.join(sandbox, 'project'), message: { role: 'user', content: 'Perform the task.' }, ...extra })
// 以后某个版本：Skill 工具调用成功了，但正文换了一种 CodePal 不认识的写法
function futureCall(id, name, at = stamp(), { sessionId = 'root', failed = false, extra = {} } = {}) {
  return [
    { type: 'assistant', uuid: 'use-' + id, timestamp: at, sessionId, ...extra,
      message: { content: [{ type: 'tool_use', id, name: 'Skill', input: { skill: name } }] } },
    { type: 'user', uuid: 'result-' + id, timestamp: at, sessionId, ...extra,
      message: { content: [{ type: 'tool_result', tool_use_id: id, ...(failed ? { is_error: true, content: 'Unknown skill: ' + name } : { content: 'Launching skill: ' + name }) }] } },
    ...(failed ? [] : [{ type: 'user', uuid: 'body-' + id, timestamp: at, sessionId, isMeta: true, ...extra,
      message: { content: [{ type: 'text', text: '<skill-body name="' + name + '">' + BODY + '</skill-body>' }] } }]),
  ]
}
// 看到正文（旧写法），但配不上任何一次调用
const strayBody = (id, target, at = stamp(), source = 'toolu_nowhere') => ({ type: 'user', uuid: 'stray-' + id, timestamp: at, sessionId: 'root',
  isMeta: true, sourceToolUseID: source, message: { content: [{ type: 'text', text: 'Base directory for this skill: ' + path.dirname(target) + '\n\n' + BODY }] } })
const read = (id, target, at = stamp()) => [
  { type: 'assistant', uuid: 'call-' + id, timestamp: at, sessionId: 'root',
    message: { content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: target } }] } },
  { type: 'user', uuid: 'read-result-' + id, timestamp: at, sessionId: 'root',
    message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: false, content: BODY }] } },
]

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'codepal-unrecognized-'))
  homeDir = path.join(sandbox, 'home')
  env = { CLAUDE_CONFIG_DIR: path.join(homeDir, '.claude'), CODEX_HOME: path.join(homeDir, '.codex') }
  storeDir = path.join(sandbox, 'derived')
  await fs.mkdir(homeDir, { recursive: true })
})
afterEach(async () => { await fs.rm(sandbox, { recursive: true, force: true }) })

describe('#97 认不出的调用：只提示，不算数', () => {
  it('以后格式变了：调用了 2 次、正文认不出 → 次数 0，明细给出「没认出来 2 次」', async () => {
    await install()
    await writeRows(claudeLog('root'), [meta(), ...futureCall('a', 'alpha', stamp(90)), ...futureCall('b', 'alpha', stamp(10))])
    const data = await scan()
    const alpha = data.skills.find((skill) => skill.name === 'alpha')
    expect(alpha.total).toBe(0)
    expect(alpha.unrecognized, 'UNRECOGNIZED_NOT_REPORTED').toBe(2)
    const listed = await detail()
    expect(listed.records).toHaveLength(0)
    expect(listed.unrecognized, 'UNRECOGNIZED_NOT_REPORTED').toBe(2)
  })

  it('两头去重：调用配不上正文、正文配不上调用，是同一次，只数 1；只有正文没有调用也数 1', async () => {
    const target = await install()
    await writeRows(claudeLog('root'), [meta(), ...futureCall('a', 'alpha', stamp(90)).slice(0, 2), strayBody('a', target, stamp(90)),
      strayBody('lone', target, stamp(10))])
    expect((await detail()).unrecognized, 'UNRECOGNIZED_NOT_DEDUPED').toBe(2)
  })

  it('不数的：报错的调用、窗口外、旁边已经确认读过的', async () => {
    const target = await install()
    // 各放一个会话：同一会话里后来的读取会把前面没配上的调用一并了结，混在一起测不出各自的规则
    await writeRows(claudeLog('bad'), [meta('bad'), ...futureCall('bad', 'alpha', stamp(300), { sessionId: 'bad', failed: true })])
    await writeRows(claudeLog('old'), [meta('old'), ...futureCall('old', 'alpha', stamp(40 * DAY), { sessionId: 'old' })])
    await writeRows(claudeLog('root'), [meta(), ...futureCall('near', 'alpha', stamp(20)), ...read('near-read', target, stamp(15))])
    const listed = await detail()
    expect(listed.records).toHaveLength(1)
    expect(listed.unrecognized).toBe(0)
  })

  it('不数的：子代理、程序自动跑的会话', async () => {
    await install()
    await writeRows(claudeLog('root'), [meta()])
    await writeRows(path.join(env.CLAUDE_CONFIG_DIR, 'projects', '-demo', 'root', 'subagents', 'agent-x.jsonl'),
      [meta('root', { agentId: 'agent-x', isSidechain: true }), ...futureCall('sub', 'alpha', stamp(30), { extra: { agentId: 'agent-x', isSidechain: true } })])
    await writeRows(claudeLog('sdk'), [meta('sdk', { entrypoint: 'sdk-cli' }), ...futureCall('auto', 'alpha', stamp(30), { sessionId: 'sdk' })])
    expect((await detail()).unrecognized).toBe(0)
  })

  it('有路径的只认资产库那一份：开发仓库里同名技能的正文不串到资产库的 alpha', async () => {
    await install()
    const dev = await install('alpha', path.join(sandbox, 'project', 'skills'))
    await writeRows(claudeLog('root'), [meta(), strayBody('dev', dev, stamp(10))])
    expect((await detail()).unrecognized).toBe(0)
  })

  it('认得了就消失：日志换成认得的写法重读后，提示没了、次数照算', async () => {
    const target = await install()
    await writeRows(claudeLog('root'), [meta(), ...futureCall('a', 'alpha', stamp(10)).slice(0, 2), strayBody('a', target, stamp(10), 'toolu_other')])
    expect((await detail()).unrecognized).toBe(1)
    await writeRows(claudeLog('root'), [meta(), ...futureCall('a', 'alpha', stamp(10)).slice(0, 2), strayBody('a', target, stamp(10), 'a')])
    const listed = await detail()
    expect(listed.records).toHaveLength(1)
    expect(listed.unrecognized).toBe(0)
  })
})

describe('#97 升级规则版本不丢已确认的次数（v2.1.19 CASE-020）', () => {
  it('上一版确认过 1 次、之后原日志被删：升到新规则版本后这 1 次还在', async () => {
    const target = await install()
    await writeRows(claudeLog('gone'), [meta('gone'), ...read('kept', target, stamp(3 * DAY))])
    await writeRows(claudeLog('root'), [meta(), ...read('live', target, stamp(10))])
    expect((await scan()).skills.find((skill) => skill.name === 'alpha').total).toBe(2)
    await fs.rm(claudeLog('gone'))
    // 模拟上一版留下的派生存储：索引和历史的规则版本都是上一版
    for (const name of ['index.json', 'history.json']) {
      const file = path.join(storeDir, name)
      const value = JSON.parse(await fs.readFile(file, 'utf8'))
      value.version = 'body-evidence-3.6'
      if (name === 'index.json')
        for (const entry of Object.values(value.entries))
          entry.proofDigest = crypto.createHash('sha256').update(JSON.stringify(entry.proof)).digest('hex')
      await fs.writeFile(file, JSON.stringify(value) + '\n')
    }
    const data = await scan()
    expect(data.skills.find((skill) => skill.name === 'alpha').total, 'CONFIRMED_HISTORY_LOST_ON_RULE_CHANGE').toBe(2)
    expect(data.scanMeta.bodyOpens, '现存日志按新规则重读').toBe(1)
  })
})
