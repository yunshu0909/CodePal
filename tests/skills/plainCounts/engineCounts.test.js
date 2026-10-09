/**
 * v2.1.21 TC-001：近 30 天次数直接用确认到的加载次数。
 * 读不懂的日志行、只有请求没有正文证据的调用、同名独立副本，都不再把数字变成待核（total 为空）。
 * 所有日志与存储都在隔离目录，通过生产统计入口断言。
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { scanSkillRunSamples } = require('../../../electron/services/skillRunSampleService')
const NOW = new Date('2026-10-07T08:00:00.000Z')
const stamp = (minutes = 1) => new Date(NOW.getTime() - minutes * 60_000).toISOString()
const BODY = '---\nname: alpha\n---\n# Instructions\nApply these instructions to the current task.\n'
let sandbox
let homeDir
let env

const scan = (names) => scanSkillRunSamples({ homeDir, env, storeDir: path.join(sandbox, 'derived'), nowFn: () => NOW },
  { windowDays: 30, skillNames: names, ledgerPath: path.join(sandbox, 'legacy', 'skill-runs.jsonl') })
const skillOf = (data, name) => data.skills.find((entry) => entry.name === name)
const claudeLog = (name) => path.join(env.CLAUDE_CONFIG_DIR, 'projects', '-demo', name + '.jsonl')

async function writeLines(file, lines) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, lines.join('\n') + '\n')
}
async function install(name, root = path.join(homeDir, 'Documents', 'SkillManager')) {
  const target = path.join(root, name, 'SKILL.md')
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, BODY.replace('name: alpha', 'name: ' + name))
  return target
}
const meta = (sessionId) => JSON.stringify({ type: 'user', uuid: 'initial-' + sessionId, sessionId, timestamp: stamp(200),
  entrypoint: 'cli', version: '2.1.292', isSidechain: false, userType: 'external',
  cwd: path.join(sandbox, 'project'), message: { role: 'user', content: 'Perform the task.' } })
const read = (sessionId, id, target) => [
  JSON.stringify({ type: 'assistant', uuid: 'call-' + id, timestamp: stamp(), sessionId,
    message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: target } }] } }),
  JSON.stringify({ type: 'user', uuid: 'result-' + id, timestamp: stamp(), sessionId,
    message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: false, content: BODY }] } }),
]
// 只有 Skill 工具请求、没有返回正文：2.1.19 起这类调用不算加载
const requestOnly = (sessionId, id, name) => JSON.stringify({ type: 'assistant', uuid: 'use-' + id, timestamp: stamp(), sessionId,
  message: { content: [{ type: 'tool_use', id, name: 'Skill', input: { skill: name } }] } })

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'codepal-plain-counts-'))
  homeDir = path.join(sandbox, 'home')
  env = { CLAUDE_CONFIG_DIR: path.join(homeDir, '.claude'), CODEX_HOME: path.join(homeDir, '.codex') }
  await fs.mkdir(homeDir, { recursive: true })
})
afterEach(async () => { await fs.rm(sandbox, { recursive: true, force: true }) })

describe('v2.1.21 TC-001 近 30 天次数直接用确认次数', () => {
  it('TC-001 日志里有读不懂的行：同文件其余有效行照算，其他 Skill 是 0，不再整体待核', async () => {
    const alpha = await install('alpha')
    await install('beta')
    await writeLines(claudeLog('broken'), [meta('broken'), '{this line is not json', ...read('broken', 'one', alpha)])
    await writeLines(claudeLog('good'), [meta('good'), ...read('good', 'two', alpha)])
    const data = await scan(['alpha', 'beta'])
    expect(skillOf(data, 'alpha')?.total, 'PLAIN_COUNT_HIDDEN alpha').toBe(2)
    expect(skillOf(data, 'beta')?.total, 'PLAIN_COUNT_HIDDEN beta').toBe(0)
    expect(data.totals.total, 'PLAIN_COUNT_HIDDEN totals').toBe(2)
  })

  it('TC-001 只有请求没有加载证据的调用不计数，也不把数字变成待核', async () => {
    const alpha = await install('alpha')
    await install('beta')
    await writeLines(claudeLog('root'), [meta('root'), ...read('root', 'one', alpha), requestOnly('root', 'ask', 'beta')])
    const data = await scan(['alpha', 'beta'])
    expect(skillOf(data, 'alpha')?.total, 'PLAIN_COUNT_HIDDEN alpha').toBe(1)
    expect(skillOf(data, 'beta')?.total, 'PLAIN_COUNT_HIDDEN beta').toBe(0)
    expect(skillOf(data, 'beta')?.confirmedTotal).toBe(0)
  })

  it('TC-001 资产库外两份同名独立副本：按名字显示首选那份的确认次数，不合并相加', async () => {
    const claudeCopy = await install('gamma', path.join(homeDir, '.claude', 'skills'))
    const agentsCopy = await install('gamma', path.join(homeDir, '.agents', 'skills'))
    await writeLines(claudeLog('root'), [meta('root'), ...read('root', 'one', claudeCopy)])
    await writeLines(claudeLog('later'), [meta('later'), ...read('later', 'two', claudeCopy)])
    await writeLines(claudeLog('other'), [meta('other'), ...read('other', 'three', agentsCopy)])
    const data = await scan(['gamma'])
    const copies = data.assets.filter((entry) => entry.name === 'gamma')
    expect(copies.map((entry) => entry.total).sort()).toEqual([1, 2])
    const gamma = skillOf(data, 'gamma')
    const preferred = copies.find((entry) => entry.assetId === gamma?.assetId)
    expect(gamma?.total, 'PLAIN_COUNT_HIDDEN gamma').toBe(preferred?.total)
    expect(gamma.total).not.toBe(3)
  })
})
