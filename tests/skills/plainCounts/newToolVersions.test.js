/**
 * #97：新版本 Claude Code 的 Skill 工具、斜杠命令调起照常算进近 30 天次数。
 * 记录全是照本机核对到的新格式编的假数据（2026-11-21 只读核对，结构见任务材料「核对结果」）：
 * - Skill 工具：isMeta 注入行带 sourceToolUseID 指回 Skill 工具调用，正文以 Base directory 开头（2.1.293 起格式没变）；
 * - 斜杠命令：用户行带 <command-message>/<command-name>，紧跟 isMeta 注入行，没有 sourceToolUseID，靠 parentUuid 指回。
 * 所有日志与存储都在隔离目录，通过生产统计入口断言。
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { scanSkillRunSamples } = require('../../../electron/services/skillRunSampleService')
const NOW = new Date('2026-11-21T08:00:00.000Z')
const stamp = (minutes = 1) => new Date(NOW.getTime() - minutes * 60_000).toISOString()
const BODY = '---\nname: alpha\n---\n# Instructions\nApply these instructions to the current task.\n'
let sandbox
let homeDir
let env
let storeDir

const scan = (names = ['alpha']) => scanSkillRunSamples({ homeDir, env, storeDir, nowFn: () => NOW },
  { windowDays: 30, skillNames: names, ledgerPath: path.join(sandbox, 'legacy', 'skill-runs.jsonl') })
const totalOf = async (name = 'alpha') => (await scan([name])).skills.find((entry) => entry.name === name)?.total
const claudeLog = (name) => path.join(env.CLAUDE_CONFIG_DIR, 'projects', '-demo', name + '.jsonl')

async function writeRows(file, rows) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
}
async function install(name = 'alpha') {
  const target = path.join(homeDir, 'Documents', 'SkillManager', name, 'SKILL.md')
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, BODY.replace('name: alpha', 'name: ' + name))
  return target
}
const meta = (version, sessionId = 'root') => ({ type: 'user', uuid: 'initial-' + sessionId, sessionId, timestamp: stamp(200),
  entrypoint: 'cli', version, isSidechain: false, userType: 'external',
  cwd: path.join(sandbox, 'project'), message: { role: 'user', content: 'Perform the task.' } })
// Skill 工具调起：工具调用 + 带 sourceToolUseID 的 isMeta 注入行
function skillTool(version, id, name, target, at = stamp()) {
  return [
    { type: 'assistant', uuid: 'use-' + id, timestamp: at, sessionId: 'root', version,
      message: { content: [{ type: 'tool_use', id, name: 'Skill', input: { skill: name, args: 'do it' } }] } },
    { type: 'user', uuid: 'inject-' + id, parentUuid: 'use-' + id, timestamp: at, sessionId: 'root', version,
      isMeta: true, sourceToolUseID: id, promptId: 'p-' + id,
      message: { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill: ' + path.dirname(target) + '\n\n' + BODY }] } },
  ]
}
// 斜杠命令调起：用户行（字符串正文，两个 command 标签）+ 没有 sourceToolUseID、parentUuid 指回的 isMeta 注入行
function slash(version, id, name, target, { at = stamp(), parent = 'slash-' + id, isMeta = true, body = BODY, before = '' } = {}) {
  return [
    { type: 'user', uuid: 'slash-' + id, timestamp: at, sessionId: 'root', version, promptId: 'p-' + id,
      message: { role: 'user', content: '<command-message>' + name + '</command-message>\n<command-name>/' + name + '</command-name>' } },
    { type: 'user', uuid: 'inject-' + id, parentUuid: parent, timestamp: at, sessionId: 'root', version, promptId: 'p-' + id,
      ...(isMeta ? { isMeta: true } : {}),
      message: { role: 'user', content: [{ type: 'text', text: before + 'Base directory for this skill: ' + path.dirname(target) + '\n\n' + body }] } },
  ]
}
const read = (id, target, at = stamp()) => [
  { type: 'assistant', uuid: 'call-' + id, timestamp: at, sessionId: 'root',
    message: { content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: target } }] } },
  { type: 'user', uuid: 'result-' + id, timestamp: at, sessionId: 'root',
    message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: false, content: BODY }] } },
]

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'codepal-new-versions-'))
  homeDir = path.join(sandbox, 'home')
  env = { CLAUDE_CONFIG_DIR: path.join(homeDir, '.claude'), CODEX_HOME: path.join(homeDir, '.codex') }
  storeDir = path.join(sandbox, 'derived')
  await fs.mkdir(homeDir, { recursive: true })
})
afterEach(async () => { await fs.rm(sandbox, { recursive: true, force: true }) })

describe('#97 新版本 Claude Code 调起照常算进次数', () => {
  it('2.1.312 用 Skill 工具调起：格式和 2.1.292 一样，算 1 次', async () => {
    const target = await install()
    await writeRows(claudeLog('root'), [meta('2.1.312'), ...skillTool('2.1.312', 'toolu_1', 'alpha', target)])
    expect(await totalOf(), 'NEW_VERSION_SKILL_TOOL_NOT_COUNTED').toBe(1)
  })

  it('2.1.325 打斜杠命令调起：注入行没有 sourceToolUseID，靠 parentUuid 配上斜杠那一行，算 1 次', async () => {
    const target = await install()
    await writeRows(claudeLog('root'), [meta('2.1.325'), ...slash('2.1.325', 's1', 'alpha', target)])
    expect(await totalOf(), 'SLASH_INJECTION_NOT_COUNTED').toBe(1)
  })

  it('2.1.292 的斜杠命令同一条路也算（以前任何版本都没配上）', async () => {
    const target = await install()
    await writeRows(claudeLog('root'), [meta('2.1.292'), ...slash('2.1.292', 's1', 'alpha', target)])
    expect(await totalOf(), 'SLASH_INJECTION_NOT_COUNTED').toBe(1)
  })

  it('以后的版本结构没变也照算，不再等写死的版本号放行', async () => {
    const target = await install()
    await writeRows(claudeLog('root'), [meta('2.2.0'), ...skillTool('2.2.0', 'toolu_1', 'alpha', target, stamp(90)),
      ...slash('2.2.0', 's1', 'alpha', target, { at: stamp(10) })])
    expect(await totalOf(), 'FUTURE_VERSION_NOT_COUNTED').toBe(2)
  })

  it('斜杠调起后 30 分钟内又读了一遍文件：合成 1 次，不重复算', async () => {
    const target = await install()
    await writeRows(claudeLog('root'), [meta('2.1.325'), ...slash('2.1.325', 's1', 'alpha', target, { at: stamp(20) }),
      ...read('again', target, stamp(5))])
    expect(await totalOf()).toBe(1)
  })

  it('配不上对的照旧不算：parentUuid 指向别处、名字对不上、不是系统注入行、2.0 版本', async () => {
    const target = await install()
    await install('beta')
    await writeRows(claudeLog('elsewhere'), [meta('2.1.325', 'elsewhere'), ...slash('2.1.325', 'a', 'alpha', target, { parent: 'some-other-row' })])
    await writeRows(claudeLog('mismatch'), [meta('2.1.325', 'mismatch'), ...slash('2.1.325', 'b', 'beta', target)])
    await writeRows(claudeLog('pasted'), [meta('2.1.325', 'pasted'), ...slash('2.1.325', 'c', 'alpha', target, { isMeta: false })])
    await writeRows(claudeLog('old'), [meta('2.0.77', 'old'), ...skillTool('2.0.77', 'toolu_old', 'alpha', target)])
    expect(await totalOf()).toBe(0)
    expect(await totalOf('beta')).toBe(0)
  })

  it('审核意见 4：正文开头写着「找不到就问用户」这类话照算；Base directory 不在开头的不算', async () => {
    const target = await install()
    await writeRows(claudeLog('root'), [meta('2.1.325'), ...slash('2.1.325', 's1', 'alpha', target,
      { body: 'If the record is not found, ask the user.\n' + BODY })])
    expect(await totalOf(), 'BODY_WORDING_REJECTED').toBe(1)
    await writeRows(claudeLog('root'), [meta('2.1.325'), ...slash('2.1.325', 's1', 'alpha', target, { before: 'Some unrelated preface.\n' })])
    expect(await totalOf(), 'HEADER_NOT_AT_START_ACCEPTED').toBe(0)
  })

  it('升级前已经读过、记成没核实的旧日志：升级后按新规则重读，补算进来', async () => {
    const target = await install()
    await writeRows(claudeLog('root'), [meta('2.1.312'), ...skillTool('2.1.312', 'toolu_1', 'alpha', target)])
    await scan()
    // 模拟上一版留下的索引：同一份日志、规则版本 3.6、那次注入记成「没核实」；历史记录也是上一版的
    const indexPath = path.join(storeDir, 'index.json')
    const index = JSON.parse(await fs.readFile(indexPath, 'utf8'))
    index.version = 'body-evidence-3.6'
    for (const entry of Object.values(index.entries)) {
      entry.proof.candidates = entry.proof.candidates.map((candidate) => candidate.kind === 'injection'
        ? { ...candidate, kind: 'pending', bodyHash: null, reason: 'INJECTION_NOT_VERIFIED' } : candidate)
      entry.proofDigest = crypto.createHash('sha256').update(JSON.stringify(entry.proof)).digest('hex')
    }
    await fs.writeFile(indexPath, JSON.stringify(index) + '\n')
    await fs.rm(path.join(storeDir, 'history.json'), { force: true })
    expect(await totalOf(), 'OLD_INDEX_NOT_REPARSED').toBe(1)
  })
})
