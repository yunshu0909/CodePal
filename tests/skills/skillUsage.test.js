/**
 * #74 正文加载、来源身份、历史与索引契约。
 * 所有源/账本使用隔离目录；通过既有生产服务入口断言，不靠缺模块制造RED。
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { scanSkillRunSamples, listSkillInvocationRecords } = require('../../electron/services/skillRunSampleService')
const { registerSkillUsageHandlers } = require('../../electron/handlers/registerSkillUsageHandlers')
const NOW = new Date('2026-10-07T08:00:00.000Z')
const MINUTE = 60_000
const stamp = (minutes = 1) => new Date(NOW.getTime() - minutes * MINUTE).toISOString()
const BODY = '---\nname: alpha\n---\n# Instructions\nApply these instructions to the current task.\n'
let sandbox
let homeDir
let env
let ledgerPath
let storeDir

const deps = (extra = {}) => ({ homeDir, env, storeDir, nowFn: () => NOW, ...extra })
const scan = (names = ['alpha'], options = {}, extra = {}) => scanSkillRunSamples(deps(extra), { windowDays: 30, skillNames: names, ledgerPath, ...options })
const skillOf = (data, name = 'alpha') => data.skills.find((entry) => entry.name === name)
const recordList = (name = 'alpha') => listSkillInvocationRecords(deps(), { skillName: name, windowDays: 30, ledgerPath })
const logPath = (tool, name = 'root') => tool === 'claude'
  ? path.join(env.CLAUDE_CONFIG_DIR, 'projects', '-demo', name + '.jsonl')
  : path.join(env.CODEX_HOME, 'sessions', '2026', '10', name + '.jsonl')

async function jsonl(file, records) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, records.map((item) => JSON.stringify(item)).join('\n') + '\n')
}
async function install(name = 'alpha', scope = 'central') {
  const root = scope === 'central' ? path.join(homeDir, 'Documents', 'SkillManager')
    : scope === 'claude' ? path.join(homeDir, '.claude', 'skills')
      : scope === 'codex' ? path.join(homeDir, '.agents', 'skills')
        : scope === 'plugin' ? path.join(homeDir, '.codex', 'plugins', 'cache', 'demo', 'skills')
          : scope === 'system' ? path.join(homeDir, '.codex', 'skills', '.system')
            : path.join(sandbox, 'project', '.claude', 'skills')
  const target = path.join(root, name, 'SKILL.md')
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, BODY.replace('name: alpha', 'name: ' + name))
  return target
}
function claudeMeta(id = 'claude-root', extra = {}) {
  return { type: 'user', uuid: 'initial-' + id, sessionId: id, timestamp: stamp(200),
    entrypoint: 'cli', version: '2.1.292', isSidechain: false, userType: 'external',
    cwd: path.join(sandbox, 'project'), message: { role: 'user', content: 'Perform the task.' }, ...extra }
}
function codexMeta(id = 'codex-root', extra = {}) {
  return { type: 'session_meta', timestamp: stamp(200),
    payload: { id, originator: 'Codex Desktop', source: 'vscode', cli_version: '0.159.0', cwd: path.join(sandbox, 'project'), ...extra } }
}
function claudeRead(id, target, at = stamp(), { output = BODY, failed = false, model = 'claude-opus-5-5' } = {}) {
  return [
    { type: 'assistant', uuid: 'call-' + id, timestamp: at, sessionId: 'claude-root',
      message: { model, content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: target } }] } },
    { type: 'user', uuid: 'result-' + id, timestamp: at, sessionId: 'claude-root',
      message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: failed, content: output }] } },
  ]
}
function claudeSkill(id, name, at = stamp(), result = null) {
  const rows = [{ type: 'assistant', uuid: 'use-' + id, timestamp: at, sessionId: 'claude-root',
    message: { content: [{ type: 'tool_use', id, name: 'Skill', input: { skill: name } }] } }]
  if (result) rows.push({ type: 'user', uuid: 'skill-result-' + id, timestamp: at, sessionId: 'claude-root',
    message: { content: [{ type: 'tool_result', tool_use_id: id, ...result }] } })
  return rows
}
function codexUser(message, at = stamp()) {
  return { type: 'event_msg', timestamp: at, payload: { type: 'user_message', message } }
}
function codexRead(id, target, at = stamp(), { output = BODY, exitCode = 0, command = null } = {}) {
  return [
    { type: 'response_item', timestamp: at, payload: { type: 'function_call', call_id: id, name: 'exec_command',
      arguments: JSON.stringify({ cmd: command || "cat '" + target + "'" }) } },
    { type: 'response_item', timestamp: at, payload: { type: 'function_call_output', call_id: id,
      output: 'Process exited with code ' + exitCode + '\nFinal output:\n' + output } },
  ]
}
function legacy(id, name = 'alpha', at = stamp(), tool = 'claude') {
  return { schemaVersion: 2, invocationId: id, skillName: name, tool, triggerType: tool === 'claude' ? 'claude_tool_use' : 'codex_dollar',
    triggeredAt: at, session: { id: tool + '-root', relativePath: tool === 'claude' ? '-demo/root.jsonl' : '2026/10/root.jsonl' },
    sourceLine: 2, classifierVersion: 'invocations-legacy' }
}
beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'codepal-evidence-'))
  homeDir = path.join(sandbox, 'home')
  env = { CLAUDE_CONFIG_DIR: path.join(homeDir, '.claude'), CODEX_HOME: path.join(homeDir, '.codex') }
  ledgerPath = path.join(sandbox, 'legacy', 'skill-runs.jsonl')
  storeDir = path.join(sandbox, 'derived')
  await fs.mkdir(homeDir, { recursive: true })
})
afterEach(async () => { await fs.rm(sandbox, { recursive: true, force: true }) })

describe('#74 TC-001 verified body and sources', () => {
  it('CASE-001/009 Claude Read returns body, third-party model stays Claude, detail and totals agree', async () => {
    const target = await install()
    await jsonl(logPath('claude'), [claudeMeta(), ...claudeRead('one', target, stamp(), { model: 'deepseek-test-model' })])
    const result = await scan()
    expect(skillOf(result)).toMatchObject({ total: 1, claude: 1, codex: 0, completeness: 'complete' })
    const listed = await recordList()
    expect(listed.records).toHaveLength(1)
    expect(listed.records[0]).toMatchObject({ tool: 'claude', skillName: 'alpha', triggeredAt: stamp() })
    expect(listed.records[0]).not.toHaveProperty('model')
  })
  it.each(['cat', 'sed -n 1,12p', 'head -n 12', 'tail -n 12'])('CASE-002/004 Codex %s has matched successful partial text', async (command) => {
    const target = await install()
    await jsonl(logPath('codex'), [codexMeta(), ...codexRead('one', target, stamp(), { command: command + " '" + target + "'", output: '# Partial instructions\nApply to current task.' })])
    expect(skillOf(await scan())).toMatchObject({ total: 1, codex: 1, claude: 0, completeness: 'complete' })
  })
  it('CASE-002 completed structured CommandExecution requires nonempty output', async () => {
    const target = await install()
    const item = { type: 'CommandExecution', id: 'native', command: "cat '" + target + "'", parsed_cmd: [{ type: 'read', path: target }], status: 'completed', exit_code: 0, aggregated_output: BODY }
    await jsonl(logPath('codex'), [codexMeta(), { type: 'item_completed', timestamp: stamp(), item }])
    expect(skillOf(await scan())?.total).toBe(1)
  })
  it('CASE-003/legacy TC-038 only Skill, slash and dollar requests stay pending, outside-window requests do not inflate known reads', async () => {
    await install()
    await jsonl(logPath('claude'), [claudeMeta(), ...claudeSkill('bare', 'alpha'), { ...claudeMeta(), timestamp: stamp(), message: { content: '<command-name>/alpha</command-name>' } }])
    await jsonl(logPath('codex'), [codexMeta(), codexUser('$alpha please run')])
    expect(skillOf(await scan())).toMatchObject({ total: null, confirmedTotal: 0, completeness: 'pending' })
  })
  it('CASE-003 a proven tool error does not load or create uncertainty', async () => {
    await install()
    await jsonl(logPath('claude'), [claudeMeta(), ...claudeSkill('bad', 'alpha', stamp(), { is_error: true, content: 'Unknown skill: alpha' })])
    expect(skillOf(await scan())).toMatchObject({ total: 0, completeness: 'complete' })
  })
  it('CASE-005 request plus verified Claude metadata injection counts once', async () => {
    const target = await install()
    const inject = { type: 'user', timestamp: stamp(), sessionId: 'claude-root', isMeta: true, version: '2.1.292', sourceToolUseID: 'skill-one',
      message: { content: 'Base directory for this skill: ' + path.dirname(target) + '\n\n' + BODY } }
    await jsonl(logPath('claude'), [claudeMeta(), ...claudeSkill('skill-one', 'alpha'), inject])
    expect(skillOf(await scan())).toMatchObject({ total: 1, completeness: 'complete' })
  })
  it('CASE-005/006 Codex producer, version, actual user event and body all participate in injection proof', async () => {
    const target = await install()
    const text = '<skill><name>alpha</name><path>' + target + '</path>' + BODY + '</skill>'
    const injection = { type: 'response_item', timestamp: stamp(), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }
    await jsonl(logPath('codex'), [codexMeta(), codexUser('$alpha perform task'), injection])
    expect(skillOf(await scan())).toMatchObject({ total: 1, completeness: 'complete' })
    await jsonl(logPath('codex', 'unpaired'), [codexMeta('unpaired'), injection])
    expect(skillOf(await scan())?.completeness).toBe('pending')
  })
  it('CASE-006 pasted tags, name/path catalog and unsupported producer do not become loads', async () => {
    const target = await install()
    const text = '<skill><name>alpha</name><path>' + target + '</path>' + BODY + '</skill>'
    const injection = { type: 'response_item', timestamp: stamp(), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }
    await jsonl(logPath('codex'), [codexMeta(), codexUser(text), injection, codexUser('Catalog: alpha (' + target + ')')])
    expect(skillOf(await scan())).toMatchObject({ total: 0, completeness: 'complete' })
    await jsonl(logPath('codex', 'unknown'), [codexMeta('unknown', { originator: 'unverified-producer', cli_version: '999.0.0' }), codexUser('$alpha perform'), injection])
    expect(skillOf(await scan())).toMatchObject({ total: null, confirmedTotal: 0, completeness: 'pending' })
  })
  it('CASE-007 listing/hash/search/edit/dev sources and explicit research/test samples are not loads', async () => {
    const target = await install()
    const dev = await install('alpha', 'project')
    await jsonl(logPath('codex'), [codexMeta(), codexUser('将 ' + target + ' 作为研究样本读取'),
      ...codexRead('sample', target), ...codexRead('dev', dev),
      ...codexRead('hash', target, stamp(), { command: "shasum '" + target + "'", output: '123456 digest' }),
      ...codexRead('search', target, stamp(), { command: "rg Instructions '" + target + "'", output: '# Instructions' })])
    await jsonl(logPath('claude'), [claudeMeta(), { ...claudeMeta(), timestamp: stamp(2), message: { content: '将 ' + target + ' 作为测试材料读取' } }, ...claudeRead('test', target)])
    expect(skillOf(await scan())).toMatchObject({ total: 0, completeness: 'complete' })
  })
  it('CASE-008 composite per-target outputs confirm separately even when whole command fails; ambiguous output stays pending', async () => {
    const alpha = await install()
    const beta = await install('beta')
    const command = "cat '" + alpha + "' '" + beta + "'"
    await jsonl(logPath('codex'), [codexMeta(), ...codexRead('pair', alpha, stamp(), { command, exitCode: 1,
      output: '==> ' + alpha + ' <==\n' + BODY + '\n==> ' + beta + ' <==\nPermission denied' })])
    let data = await scan(['alpha', 'beta'])
    expect(skillOf(data)).toMatchObject({ total: 1, completeness: 'complete' })
    expect(skillOf(data, 'beta')).toMatchObject({ total: 0, completeness: 'complete' })
    await jsonl(logPath('codex', 'ambiguous'), [codexMeta('ambiguous'), ...codexRead('mixed', alpha, stamp(), { command, output: BODY })])
    data = await scan(['alpha', 'beta'])
    expect(skillOf(data)?.completeness).toBe('pending')
    expect(skillOf(data, 'beta')?.completeness).toBe('pending')
  })
  it('CASE-009/legacy TC-049 personal/plugin/system/project names never merge into the ordinary asset', async () => {
    const paths = await Promise.all(['central', 'plugin', 'system', 'project'].map((scope) => install('alpha', scope)))
    await jsonl(logPath('claude'), [claudeMeta(), ...paths.flatMap((target, i) => claudeRead('source-' + i, target, stamp(10 - i)))])
    const data = await scan()
    expect(skillOf(data)).toMatchObject({ total: 1, claude: 1, codex: 0 })
    expect(data.records).toHaveLength(1)
  })
})

describe('#74 TC-001 identity, execution context and load processes', () => {
  it('CASE-010 verified realpath aliases merge fragments; independent same-name global copies remain distinct', async () => {
    const central = await install()
    const slot = path.join(homeDir, '.claude', 'skills', 'alpha')
    await fs.mkdir(path.dirname(slot), { recursive: true })
    await fs.symlink(path.dirname(central), slot)
    await jsonl(logPath('claude'), [claudeMeta(), ...claudeRead('central', central, stamp(10)), ...claudeRead('alias', path.join(slot, 'SKILL.md'), stamp(5))])
    expect(skillOf(await scan())?.total).toBe(1)
    await fs.unlink(slot)
    const independent = await install('alpha', 'claude')
    await jsonl(logPath('claude'), [claudeMeta(), ...claudeRead('central', central, stamp(10)), ...claudeRead('copy', independent, stamp(5))])
    const data = await scan()
    expect(skillOf(data)?.total).toBe(1)
    expect(data.assets.filter((asset) => asset.name === 'alpha')).toHaveLength(2)
    expect(new Set(data.assets.map((asset) => asset.assetId)).size).toBe(2)
    expect(data.assets.reduce((sum, asset) => sum + asset.confirmedTotal, 0)).toBe(2)
  })
  it('CASE-010 a mutable global personal asset counts before collection', async () => {
    const target = await install('alpha', 'claude')
    await jsonl(logPath('claude'), [claudeMeta(), ...claudeRead('global', target)])
    expect(skillOf(await scan())).toMatchObject({ total: 1, claude: 1, completeness: 'complete' })
  })
  it('CASE-012 continuous fragments merge by last read, first load and last read stay separate', async () => {
    const target = await install()
    await jsonl(logPath('claude'), [claudeMeta(), ...[40, 20, 1].flatMap((minutes, i) => claudeRead('fragment-' + i, target, stamp(minutes)))])
    const data = await scan()
    expect(skillOf(data)).toMatchObject({ total: 1, lastUsed: stamp(40), lastRead: stamp(1) })
    expect(data.records[0]).toMatchObject({ triggeredAt: stamp(40), lastReadAt: stamp(1) })
  })
  it('CASE-013 explicit reinvocation opens a process; exactly 30 minutes merges and one millisecond more splits', async () => {
    const target = await install()
    await jsonl(logPath('claude'), [claudeMeta(), ...claudeRead('first', target, stamp(100)),
      ...claudeRead('boundary', target, stamp(70)), ...claudeRead('past', target, new Date(NOW.getTime() - 40 * MINUTE + 1).toISOString()),
      ...claudeSkill('again', 'alpha', stamp(39)), ...claudeRead('new-invocation', target, stamp(38))])
    expect(skillOf(await scan())).toMatchObject({ total: 3, completeness: 'complete' })
  })
  it('CASE-014/015 actual parent edges include delegated children; independent exec is separate; parent receipts do not load', async () => {
    const target = await install()
    await jsonl(logPath('codex'), [codexMeta('parent'), codexUser('Delegate two tasks')])
    for (const id of ['child-a', 'child-b']) {
      await jsonl(logPath('codex', id), [codexMeta(id, { source: { subagent: { thread_spawn: { parent_thread_id: 'parent', depth: 1 } } } }), ...codexRead('shared-call-id', target)])
    }
    await jsonl(logPath('codex', 'independent'), [codexMeta('independent', { originator: 'codex_exec', source: 'exec' }), ...codexRead('auto', target)])
    const data = await scan()
    expect(skillOf(data)).toMatchObject({ total: 2, codex: 2, completeness: 'complete' })
    expect(data.independentRecords).toHaveLength(1)
    expect(data.records).toHaveLength(2)
  })
  it('CASE-014 unknown or missing parent classification stays pending', async () => {
    const target = await install()
    await jsonl(logPath('codex'), [codexMeta('orphan', { source: { subagent: { thread_spawn: { parent_thread_id: 'missing-parent' } } } }), ...codexRead('orphan-load', target)])
    expect(skillOf(await scan())).toMatchObject({ total: null, completeness: 'pending', confirmedTotal: 0 })
  })
  it('CASE-014 Claude metadata can appear after progress; SDK roots remain independent', async () => {
    const target = await install()
    await jsonl(logPath('claude'), [{ type: 'progress', timestamp: stamp(201), sessionId: 'claude-root' }, claudeMeta(), ...claudeRead('cli', target)])
    const sdkRead = claudeRead('sdk', target).map((record) => ({ ...record, sessionId: 'sdk-root' }))
    await jsonl(logPath('claude', 'sdk'), [claudeMeta('sdk-root', { entrypoint: 'sdk-cli' }), ...sdkRead])
    const data = await scan()
    expect(skillOf(data)?.total).toBe(1)
    expect(data.independentRecords).toHaveLength(1)
  })
  it('CASE-016 proven fork copied prefix is deduplicated but unrelated same call ID and new child reads survive', async () => {
    const target = await install()
    const prefix = codexRead('same-id', target, stamp(10))
    await jsonl(logPath('codex'), [codexMeta('parent'), ...prefix])
    await jsonl(logPath('codex', 'fork'), [codexMeta('fork', { forked_from_id: 'parent' }), ...prefix, ...codexRead('new-fork', target, stamp(1))])
    await jsonl(logPath('codex', 'unrelated'), [codexMeta('unrelated'), ...prefix])
    const data = await scan()
    expect(skillOf(data)?.total).toBe(3)
    expect(data.records).toHaveLength(3)
  })
  it('CASE-017 compaction markers alone add zero, restored body and explicit new read open separate processes', async () => {
    const target = await install()
    await jsonl(logPath('codex'), [codexMeta(), ...codexRead('before', target, stamp(6)),
      { type: 'compacted', timestamp: stamp(5), payload: { message: 'Context compacted' } },
      ...codexRead('after', target, stamp(4)), { type: 'compacted', timestamp: stamp(3), payload: { message: 'Context compacted' } }])
    expect(skillOf(await scan())?.total).toBe(2)
  })
  it('CASE-018 merge before inclusive event window; old filesystem mtime cannot hide current events', async () => {
    const target = await install()
    const oldest = 30 * 24 * 60
    await jsonl(logPath('claude'), [claudeMeta(), ...claudeRead('outside-first', target, stamp(oldest + 1)), ...claudeRead('inside-fragment', target, stamp(oldest - 1)), ...claudeRead('recent', target)])
    await fs.utimes(logPath('claude'), new Date('2020-01-01'), new Date('2020-01-01'))
    expect(skillOf(await scan())?.total).toBe(1)
    await jsonl(logPath('codex'), [codexMeta(), ...codexRead('inclusive', target, stamp(oldest)), ...codexRead('now', target, NOW.toISOString())])
    expect(skillOf(await scan())?.total).toBe(3)
  })
})

describe('#74 TC-001 legacy reconciliation and persistent evidence', () => {
  it('CASE-019/020 legacy request bytes stay unchanged; proven history survives source and derived index deletion', async () => {
    const target = await install()
    await jsonl(ledgerPath, [legacy('legacy-one')])
    const before = await fs.readFile(ledgerPath)
    await jsonl(logPath('claude'), [claudeMeta(), ...claudeRead('one', target)])
    expect(skillOf(await scan())?.total).toBe(1)
    expect(await fs.readFile(ledgerPath)).toEqual(before)
    await fs.rm(logPath('claude'))
    await fs.rm(path.join(storeDir, 'index.json'), { force: true })
    expect(skillOf(await scan())).toMatchObject({ total: 1, completeness: 'complete' })
    expect(await fs.readFile(ledgerPath)).toEqual(before)
  })
  it('CASE-021 whole content reconciliation sees downgrade records with equal maximum timestamp; reorder is a semantic no-op', async () => {
    await install()
    await install('beta')
    await jsonl(ledgerPath, [legacy('a')])
    expect(skillOf(await scan(['alpha', 'beta']))?.completeness).toBe('pending')
    await jsonl(ledgerPath, [legacy('b', 'beta'), legacy('a')])
    let result = await scan(['alpha', 'beta'])
    expect(skillOf(result, 'beta')).toMatchObject({ total: null, completeness: 'pending' })
    const history = await fs.readFile(path.join(storeDir, 'history.json'))
    await jsonl(ledgerPath, [legacy('a'), legacy('b', 'beta')])
    result = await scan(['alpha', 'beta'])
    expect(result.scanMeta.historyWrites).toBe(0)
    expect(await fs.readFile(path.join(storeDir, 'history.json'))).toEqual(history)
  })
  it('CASE-030 index and durable history contain metadata only, private modes; originals stay byte-identical', async () => {
    const target = await install()
    const secret = 'sk-FAKE-TEST-VALUE-ONLY'
    await jsonl(logPath('claude'), [claudeMeta(), ...claudeRead('one', target, stamp(), { output: BODY + secret })])
    const original = await fs.readFile(logPath('claude'))
    await scan()
    const derived = (await fs.readFile(path.join(storeDir, 'index.json'), 'utf8')) + (await fs.readFile(path.join(storeDir, 'history.json'), 'utf8'))
    expect(derived).not.toContain(secret)
    expect(derived).not.toContain('Apply these instructions')
    expect((await fs.stat(storeDir)).mode & 0o777).toBe(0o700)
    for (const file of ['index.json', 'history.json']) expect((await fs.stat(path.join(storeDir, file))).mode & 0o777).toBe(0o600)
    expect(await fs.readFile(logPath('claude'))).toEqual(original)
  })
})

describe('#74 TC-001 persistent index and full-scan equivalence', () => {
  const publicProjection = (data) => ({ skills: data.skills.map(({ batchId: _batch, ...entry }) => entry), records: data.records, independentRecords: data.independentRecords, diagnostics: data.diagnostics })
  it('CASE-023 stable queries and fresh process reopen zero transcript bodies; output equals full scan', async () => {
    const target = await install()
    await jsonl(logPath('claude'), [claudeMeta(), ...claudeRead('one', target)])
    const first = await scan()
    expect(first.scanMeta.bodyOpens).toBe(1)
    const second = await scan()
    expect(second.scanMeta.bodyOpens).toBe(0)
    expect(second.scanMeta.historyWrites).toBe(0)
    const full = await scan(['alpha'], { indexDisabled: true })
    expect(publicProjection(second)).toEqual(publicProjection(full))
    const script = "const s=require('./electron/services/skillRunSampleService');s.scanSkillRunSamples(" + JSON.stringify(deps()) + ',' + JSON.stringify({ skillNames: ['alpha'], ledgerPath, windowDays: 30, now: NOW.toISOString() }) + ").then(r=>process.stdout.write(JSON.stringify({opens:r.scanMeta.bodyOpens,total:r.skills[0].total})))"
    const restarted = JSON.parse(execFileSync(process.execPath, ['-e', script], { cwd: process.cwd(), encoding: 'utf8' }))
    expect(restarted).toEqual({ opens: 0, total: 1 })
  })
  it('CASE-024 same-length rewrite with restored mtime, atomic replacement and truncation invalidate only changed file', async () => {
    const target = await install()
    await jsonl(logPath('codex'), [codexMeta(), ...codexRead('one', target)])
    await jsonl(logPath('claude'), [claudeMeta(), ...claudeRead('two', target)])
    await scan()
    const file = logPath('codex')
    const before = await fs.stat(file)
    const original = await fs.readFile(file, 'utf8')
    await fs.writeFile(file, original.replace('with code 0', 'with code 1'))
    await fs.utimes(file, before.atime, before.mtime)
    expect((await scan()).scanMeta.bodyOpens).toBe(1)
    await jsonl(file + '.new', [codexMeta(), ...codexRead('changed', target)])
    await fs.rename(file + '.new', file)
    expect((await scan()).scanMeta.bodyOpens).toBe(1)
    await fs.writeFile(file, JSON.stringify(codexMeta()) + '\n')
    expect((await scan()).scanMeta.bodyOpens).toBe(1)
  })
  it('CASE-025 corrupted index and parser rule change rebuild rather than trusting stale success', async () => {
    const target = await install()
    await jsonl(logPath('claude'), [claudeMeta(), ...claudeRead('one', target)])
    await scan()
    await fs.writeFile(path.join(storeDir, 'index.json'), '{broken')
    expect((await scan()).scanMeta.bodyOpens).toBe(1)
    expect((await scan(['alpha'], { parserVersion: 'test-next-rule' })).scanMeta.bodyOpens).toBe(1)
  })
  it('CASE-026 candidate budget evicts storage, never current confirmed loads or completeness', async () => {
    const target = await install()
    await jsonl(logPath('claude'), [claudeMeta(), ...Array.from({ length: 4 }, (_, i) => claudeRead('load-' + i, target, stamp(1 + i * 40))).flat()])
    const data = await scan(['alpha'], { maxCandidatesPerFile: 1, maxCandidatesTotal: 1 })
    expect(skillOf(data)).toMatchObject({ total: 4, completeness: 'complete' })
    expect(data.scanMeta.unpersistedFiles).toBe(1)
    expect((await scan(['alpha'], { maxCandidatesPerFile: 1, maxCandidatesTotal: 1 })).scanMeta.bodyOpens).toBe(1)
  })
  it('CASE-027 active append is bounded and never persisted as stable coverage', async () => {
    const target = await install()
    const file = logPath('claude')
    await jsonl(file, [claudeMeta(), ...claudeRead('first', target)])
    let appended = false
    const data = await scan(['alpha'], {}, { afterFileRead: async (readFile) => {
      if (readFile !== file || appended) return
      appended = true
      await fs.appendFile(file, claudeRead('later', target, stamp(0)).map((entry) => JSON.stringify(entry)).join('\n') + '\n')
    } })
    expect(data.scanMeta.unstableFiles).toBe(1)
    expect(data.scanMeta.unpersistedFiles).toBe(1)
    expect(data.scanMeta.bodyOpens).toBe(1)
    expect((await scan()).scanMeta.bodyOpens).toBe(1)
  })
})

describe('#74 coverage states', () => {
  it('TC-002 CASE-011 missing proof is localized, other credible counts are retained', async () => {
    const alpha = await install()
    await install('beta')
    await jsonl(logPath('claude'), [claudeMeta(), ...claudeRead('known', alpha), ...claudeSkill('unproven', 'beta')])
    const data = await scan(['alpha', 'beta'])
    expect(skillOf(data)).toMatchObject({ total: 1, completeness: 'complete' })
    expect(skillOf(data, 'beta')).toMatchObject({ total: null, completeness: 'pending', uncertaintyScope: 'asset' })
  })
  it('TC-003 CASE-011 corrupt source with unknown coverage cannot publish exact zero', async () => {
    await install()
    await install('beta')
    await fs.mkdir(path.dirname(logPath('claude')), { recursive: true })
    await fs.writeFile(logPath('claude'), '{corrupt source coverage\n')
    const data = await scan(['alpha', 'beta'])
    expect(data.skills.every((entry) => entry.total === null && entry.completeness === 'pending' && entry.uncertaintyScope === 'all')).toBe(true)
  })
  it('TC-004 CASE-025 revoked permissions are checked before index hit, no stale exact success', async () => {
    const target = await install()
    await jsonl(logPath('claude'), [claudeMeta(), ...claudeRead('one', target)])
    await scan()
    await fs.chmod(logPath('claude'), 0)
    try {
      expect(skillOf(await scan())).toMatchObject({ total: null, availability: 'error' })
    } finally { await fs.chmod(logPath('claude'), 0o600) }
  })
  it('TC-006 only a complete scan can establish a trusted zero', async () => {
    await install()
    expect(skillOf(await scan())).toMatchObject({ total: 0, confirmedTotal: 0, completeness: 'complete', availability: 'available' })
  })
  it('TC-008 CASE-022/028 serialized concurrent calls share file parsing, preserve independent windows and atomic history', async () => {
    const target = await install()
    await jsonl(logPath('claude'), [claudeMeta(), ...claudeRead('old', target, stamp(3 * 24 * 60)), ...claudeRead('new', target)])
    const [wide, narrow] = await Promise.all([scan(), scan(['alpha'], { windowDays: 1 })])
    expect(skillOf(wide)?.total).toBe(2)
    expect(skillOf(narrow)?.total).toBe(1)
    expect(wide.scanMeta.bodyOpens + narrow.scanMeta.bodyOpens).toBe(1)
    expect(wide.batchId).not.toBe(narrow.batchId)
    const before = await fs.readFile(path.join(storeDir, 'history.json'))
    const history = path.join(storeDir, 'history.json')
    await fs.rename(history, history + '.safe')
    await fs.mkdir(history)
    await jsonl(logPath('claude'), [claudeMeta(), ...claudeRead('old', target, stamp(3 * 24 * 60)), ...claudeRead('new', target), ...claudeRead('next', target, stamp(60))])
    const failed = await scan()
    expect(failed.diagnostics.some((entry) => entry.code === 'HISTORY_WRITE_FAILED')).toBe(true)
    expect(await fs.readFile(history + '.safe')).toEqual(before)
    await fs.rm(history, { recursive: true })
    await fs.rename(history + '.safe', history)
    expect(skillOf(await scan())?.total).toBe(3)
  })
})

describe('#74 TC-001 domain IPC shares the same core', () => {
  it('CASE-033 domain and legacy adapters agree; detail binds the batch and rejects arbitrary paths', async () => {
    const target = await install()
    await jsonl(logPath('claude'), [claudeMeta(), ...claudeRead('one', target)])
    const handlers = new Map()
    registerSkillUsageHandlers({ ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) },
      homeDir, env, storeDir, nowFn: () => NOW, pathExists: async (file) => fs.access(file).then(() => true, () => false) })
    expect(handlers.has('skill-usage:aggregate')).toBe(true)
    const modern = await handlers.get('skill-usage:aggregate')({}, { skillNames: ['alpha'], windowDays: 30 })
    const older = await handlers.get('aggregate-skill-usage')({}, { skillNames: ['alpha'], windowDays: 30 })
    expect(modern.success).toBe(true)
    expect(older.data.skills[0].total).toBe(modern.data.skills[0].total)
    const records = await handlers.get('skill-usage:records')({}, { assetId: modern.data.skills[0].assetId, batchId: modern.data.batchId, windowDays: 30 })
    expect(records).toMatchObject({ success: true, data: { batchId: modern.data.batchId } })
    expect(records.data.records).toHaveLength(1)
    expect((await handlers.get('skill-usage:aggregate')({}, { assetIds: ['/tmp/arbitrary-path'] })).success).toBe(false)
  })
})

describe('#74 TC-001 actual Codex custom tool producer', () => {
  it('CASE-002 real custom_tool_call and executor receipt pair; event time is returned body, not request time', async () => {
    const target = await install()
    const input = 'const r = await tools.exec_command({cmd:' + JSON.stringify("cat '" + target + "'") + '}); text(r)'
    await jsonl(logPath('codex'), [codexMeta(),
      { type: 'response_item', timestamp: stamp(5), payload: { type: 'custom_tool_call', call_id: 'actual-read', name: 'exec', input } },
      { type: 'response_item', timestamp: stamp(1), payload: { type: 'custom_tool_call_output', call_id: 'actual-read', output: [
        { type: 'input_text', text: 'Script completed\nWall time: 0.1 seconds\n' },
        { type: 'input_text', text: JSON.stringify({ chunk_id: 'fixture-only', wall_time_seconds: 0.1, exit_code: 0, output: BODY }) },
      ] } },
    ])
    expect(skillOf(await scan())).toMatchObject({ total: 1, codex: 1, lastUsed: stamp(1), completeness: 'complete' })
  })
  it('CASE-008 multiple custom executor receipts without target attribution remain pending, despite all success', async () => {
    const target = await install()
    const input = 'const a=await tools.exec_command({cmd:' + JSON.stringify("cat '" + target + "'") + '});const b=await tools.exec_command({cmd:"cat /tmp/other.md"});text(a);text(b)'
    const output = [BODY, 'Other document'].map((body, i) => ({ type: 'input_text', text: JSON.stringify({ chunk_id: 'fixture-' + i, wall_time_seconds: 0.1, exit_code: 0, output: body }) }))
    await jsonl(logPath('codex'), [codexMeta(), { type: 'response_item', timestamp: stamp(), payload: { type: 'custom_tool_call', call_id: 'mixed', name: 'exec', input } },
      { type: 'response_item', timestamp: stamp(), payload: { type: 'custom_tool_call_output', call_id: 'mixed', output } }])
    expect(skillOf(await scan())).toMatchObject({ total: null, confirmedTotal: 0, completeness: 'pending' })
  })
})
