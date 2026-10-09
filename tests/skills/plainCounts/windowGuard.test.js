/**
 * v2.1.21 TC-008：近 30 天窗口不变——只算窗口内的确认加载，窗口外不算，正好 30 天的边界算；
 * 第二次读取复用已建好的索引，结果一样。窗口规则在 usageEngine.aggregate 的 inWindow，本任务不改。
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { scanSkillRunSamples } = require('../../../electron/services/skillRunSampleService')
const NOW = new Date('2026-10-07T08:00:00.000Z')
const DAY = 86_400_000
const at = (ms) => new Date(NOW.getTime() - ms).toISOString()
const BODY = '---\nname: alpha\n---\n# Instructions\nApply these instructions to the current task.\n'
let sandbox
let homeDir
let env

const scan = () => scanSkillRunSamples({ homeDir, env, storeDir: path.join(sandbox, 'derived'), nowFn: () => NOW },
  { windowDays: 30, skillNames: ['alpha'], ledgerPath: path.join(sandbox, 'legacy', 'skill-runs.jsonl') })
// 每次加载放在单独的会话文件里，避免相邻读取被合并成一次加载过程
async function session(id, when, target) {
  const file = path.join(env.CLAUDE_CONFIG_DIR, 'projects', '-demo', id + '.jsonl')
  const rows = [
    { type: 'user', uuid: 'initial-' + id, sessionId: id, timestamp: at(40 * DAY), entrypoint: 'cli', version: '2.1.292', isSidechain: false,
      userType: 'external', cwd: path.join(sandbox, 'project'), message: { role: 'user', content: 'Perform the task.' } },
    { type: 'assistant', uuid: 'call-' + id, timestamp: when, sessionId: id,
      message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'read-' + id, name: 'Read', input: { file_path: target } }] } },
    { type: 'user', uuid: 'result-' + id, timestamp: when, sessionId: id,
      message: { content: [{ type: 'tool_result', tool_use_id: 'read-' + id, is_error: false, content: BODY }] } },
  ]
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
}

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'codepal-window-'))
  homeDir = path.join(sandbox, 'home')
  env = { CLAUDE_CONFIG_DIR: path.join(homeDir, '.claude'), CODEX_HOME: path.join(homeDir, '.codex') }
  const target = path.join(homeDir, 'Documents', 'SkillManager', 'alpha', 'SKILL.md')
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, BODY)
  await session('inside', at(2 * DAY), target)
  await session('boundary', at(30 * DAY), target)
  await session('outside', at(31 * DAY), target)
})
afterEach(async () => { await fs.rm(sandbox, { recursive: true, force: true }) })

describe('v2.1.21 TC-008 近 30 天窗口', () => {
  it('TC-008 只算窗口内与边界上的加载，窗口外不算；复用索引后结果相同', async () => {
    const first = await scan()
    const alpha = first.skills.find((entry) => entry.name === 'alpha')
    expect(alpha.total).toBe(2)
    expect(alpha.confirmedTotal).toBe(2)
    expect(first.totals.total).toBe(2)
    expect(first.records.map((record) => record.session.relativePath).sort()).toEqual(['-demo/boundary.jsonl', '-demo/inside.jsonl'])
    const second = await scan()
    expect(second.skills.find((entry) => entry.name === 'alpha').total).toBe(2)
    expect(second.records).toHaveLength(2)
  })
})
