/**
 * 对话回顾服务层测试
 *
 * 负责：
 * - 按 specs/v2.4-对话回顾重做 AC-01..AC-10 断言 listRecent / readSessionPage / searchSessions
 * - 用临时目录里的构造 jsonl，不读真实 ~/.claude
 * - 用读取器的字节计数确认大文件不整份读
 *
 * @module tests/sessions/sessionBrowserService.test
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import { createRequire } from 'node:module'
import { L, stamp, makeProjectsDir, filler } from './fixtures'

const require = createRequire(import.meta.url)
const service = require('../../electron/services/sessionBrowserService.js')
const reader = require('../../electron/services/sessionFileReader.js')

const HOME = os.homedir()
const A = `${HOME}/Documents/trae_projects/skills`
const B = `${HOME}/Documents/projects/agent-demo`
const day = (d, h = 10) => new Date(2026, 8, d, h, 0, 0)

let p
beforeEach(() => { p = makeProjectsDir() })
afterEach(() => p.cleanup())

const list = () => service.listRecent({ projectsDir: p.dir })

describe('listRecent', () => {
  it('TC-01 跨项目按修改时间倒序，字段齐；sdk-cli 为自动，缺 entrypoint 当手动', async () => {
    p.write('-a', 'aaaa-1', stamp([L.user('第一句'), L.answer('好'), L.aiTitle('标题 A1')], { cwd: A }), day(17))
    p.write('-a', 'aaaa-2', stamp([L.user('另一个'), L.aiTitle('标题 A2')], { cwd: A, entrypoint: 'sdk-cli' }), day(19))
    p.write('-b', 'bbbb-1', stamp([L.user('问题'), L.aiTitle('标题 B1')], { cwd: B, entrypoint: null }), day(18))

    const { projectsDirExists, sessions } = await list()
    expect(projectsDirExists).toBe(true)
    expect(sessions.map((s) => s.sessionId)).toEqual(['aaaa-2', 'bbbb-1', 'aaaa-1'])
    expect(sessions[0]).toMatchObject({ projectId: '-a', title: '标题 A2', auto: true, projectName: 'skills' })
    expect(sessions[1].auto).toBe(false)
    expect(sessions[2].auto).toBe(false)
    expect(typeof sessions[0].modifiedAt).toBe('string')
    expect(Object.keys(sessions[0]).sort()).toEqual(['auto', 'branch', 'modifiedAt', 'parentDir', 'preview', 'projectId', 'projectName', 'projectPath', 'sessionId', 'title'].sort())
  })

  it('TC-02 标题：多条 ai-title 取最后一条；没有则第一句真实提问；都没有为 null', async () => {
    p.write('-a', 's1', stamp([L.user('问'), L.aiTitle('旧标题'), L.answer('答'), L.aiTitle('新标题')], { cwd: A }))
    p.write('-a', 's2', stamp([
      L.meta('<system-reminder>内部</system-reminder>'),
      L.user('<command-name>/clear</command-name>'),
      L.user('Base directory for this skill: /x'),
      L.user('帮我看一下\n这个报错'),
    ], { cwd: A }))
    p.write('-a', 's3', stamp([L.lastPrompt('只有最后一句')], { cwd: A }))

    const byId = Object.fromEntries((await list()).sessions.map((s) => [s.sessionId, s]))
    expect(byId.s1.title).toBe('新标题')
    expect(byId.s2.title).toBe('帮我看一下 这个报错')
    expect(byId.s3.title).toBeNull()
  })

  it('TC-02 回退标题截到 80 字', async () => {
    p.write('-a', 's1', stamp([L.user('长'.repeat(120))], { cwd: A }))
    expect((await list()).sessions[0].title).toHaveLength(80)
  })

  it('TC-03 预览行取最后一条 last-prompt 并压换行；无提问的对话不返回；无 last-prompt 为 null', async () => {
    p.write('-a', 's1', stamp([L.user('问'), L.lastPrompt('第一次'), L.lastPrompt('第二次\n换行')], { cwd: A }))
    p.write('-a', 's2', stamp([L.mode(), L.system(), L.answer('只有回答')], { cwd: A }))
    p.write('-a', 's3', stamp([L.user('问但没有 last-prompt')], { cwd: A }))

    const { sessions } = await list()
    const byId = Object.fromEntries(sessions.map((s) => [s.sessionId, s]))
    expect(byId.s1.preview).toBe('第二次 换行')
    expect(byId.s2).toBeUndefined()
    expect(byId.s3.preview).toBeNull()
  })

  it('TC-04 项目路径、上级目录（~）、最后一个分支；无 cwd 回退编码目录名', async () => {
    p.write('-Users-x-Documents-proj-demo', 's1', [
      { ...L.user('问'), cwd: A, gitBranch: 'master' },
      { ...L.answer('答'), cwd: A, gitBranch: 'feat/x' },
    ])
    p.write('-Users-x-Documents-legacy', 's2', [L.user('没有 cwd')])

    const byId = Object.fromEntries((await list()).sessions.map((s) => [s.sessionId, s]))
    expect(byId.s1).toMatchObject({ projectPath: A, projectName: 'skills', parentDir: '~/Documents/trae_projects', branch: 'feat/x' })
    expect(byId.s2).toMatchObject({ projectPath: null, projectName: 'legacy', branch: null })
  })

  it('TC-05 大文件只读头 64KB + 尾 256KB，仍拿到头部 cwd 与尾部标题', async () => {
    const big = [...stamp([L.user('开头的问题')], { cwd: A })]
    for (let i = 0; i < 2000; i++) big.push(filler(10_000))
    big.push(L.aiTitle('尾部标题'), L.lastPrompt('尾部最后一句'))
    const file = p.write('-a', 'big', big)
    expect(fs.statSync(file).size).toBeGreaterThan(19_000_000)

    reader.resetReaderStats()
    const [s] = (await list()).sessions
    expect(s).toMatchObject({ projectPath: A, title: '尾部标题', preview: '尾部最后一句' })
    expect(reader.getReaderStats().bytesRead).toBeLessThanOrEqual(64 * 1024 + 256 * 1024)
  })

  it('TC-05 开头 64KB 全是大段快照时，工作目录、启动方式从尾部取（真实数据里有 20 个这样的对话）', async () => {
    const lines = []
    for (let i = 0; i < 20; i++) lines.push(filler(10_000)) // 约 200KB，没有 cwd
    lines.push(...stamp([L.user('开头之后的第一句'), L.answer('答')], { cwd: A, branch: 'feat/y', entrypoint: 'sdk-cli' }))
    lines.push(L.aiTitle('标题'))
    p.write('-a', 'snap', lines)
    const [s] = (await list()).sessions
    expect(s).toMatchObject({ projectPath: A, projectName: 'skills', auto: true, branch: 'feat/y' })
  })

  it('TC-06 目录不存在 → projectsDirExists=false；不可读 → 抛错', async () => {
    const missing = await service.listRecent({ projectsDir: `${p.dir}/nope` })
    expect(missing).toEqual({ projectsDirExists: false, sessions: [] })

    if (process.getuid && process.getuid() !== 0) {
      fs.chmodSync(p.dir, 0o000)
      try {
        await expect(list()).rejects.toThrow(`没有权限读取 ${p.dir}`)
      } finally {
        fs.chmodSync(p.dir, 0o755)
      }
    }
  })
})

/** 450 轮一问一答的对话：ask i / answer i */
function longConversation(n) {
  const lines = []
  for (let i = 0; i < n; i++) {
    lines.push(L.user(`问 ${i}`))
    lines.push(L.answer(`答 ${i}`))
  }
  return stamp(lines, { cwd: A })
}

describe('readSessionPage', () => {
  const read = (opts) => service.readSessionPage('-a', 's1', { projectsDir: p.dir, ...opts })

  it('TC-07 从尾部读 limit 条、正序；用 cursor 往前翻直到开头', async () => {
    p.write('-a', 's1', longConversation(225)) // 450 条消息

    const first = await read({ limit: 200 })
    expect(first.messages).toHaveLength(200)
    expect(first.messages[0]).toMatchObject({ kind: 'ask', text: '问 125' })
    expect(first.messages[199]).toMatchObject({ kind: 'answer', text: '答 224' })
    expect(first.hasMore).toBe(true)
    expect(first.messages.every((m, i, a) => i === 0 || m.offset > a[i - 1].offset)).toBe(true)
    expect(first.cursor).toBe(first.messages[0].offset)

    const second = await read({ limit: 200, before: first.cursor })
    expect(second.messages[199]).toMatchObject({ kind: 'answer', text: '答 124' })
    const third = await read({ limit: 200, before: second.cursor })
    expect(third.messages).toHaveLength(50)
    expect(third.messages[0]).toMatchObject({ kind: 'ask', text: '问 0' })
    expect(third.hasMore).toBe(false)
  })

  it('TC-07 20MB 文件读一页不整份读', async () => {
    const lines = [...stamp([L.user('开头')], { cwd: A })]
    for (let i = 0; i < 2000; i++) lines.push(filler(10_000))
    lines.push(...longConversation(10))
    p.write('-a', 's1', lines)

    reader.resetReaderStats()
    const page = await read({ limit: 20 })
    expect(page.messages).toHaveLength(20)
    expect(reader.getReaderStats().bytesRead).toBeLessThan(1_000_000)
  })

  it('TC-08 只产出 ask / answer / compact；过滤系统消息；工具对象取值与截断', async () => {
    p.write('-a', 's1', stamp([
      L.meta('<system-reminder>x</system-reminder>'),
      L.user('<local-command-stdout>x</local-command-stdout>'),
      L.user('真实提问'),
      L.answer('', [['Read', { file_path: '/a/b/SessionBrowserPage.jsx' }], ['Bash', { command: 'npm test -- ' + 'x'.repeat(100) }]]),
      L.toolResult(),
      L.answer('', [['Grep', { pattern: 'foo' }], ['WebFetch', { url: 'https://example.com' }], ['Agent', { description: '查一下' }], ['Other', {}]]),
      L.answer('结论'),
      L.compact(),
      L.userBlocks([{ type: 'text', text: '块状提问' }]),
      L.system(),
    ], { cwd: A }))

    const { messages } = await read({})
    expect(messages.map((m) => m.kind)).toEqual(['ask', 'answer', 'answer', 'answer', 'compact', 'ask'])
    expect(messages[0].text).toBe('真实提问')
    expect(messages[1].toolUses).toEqual([
      { name: 'Read', target: 'SessionBrowserPage.jsx' },
      { name: 'Bash', target: ('npm test -- ' + 'x'.repeat(100)).slice(0, 60) },
    ])
    expect(messages[2].toolUses.map((t) => t.target)).toEqual(['foo', 'https://example.com', '查一下', ''])
    expect(messages[3]).toMatchObject({ kind: 'answer', text: '结论', toolUses: [] })
    expect(messages[4].text).toBeUndefined()
    expect(messages[5].text).toBe('块状提问')
  })

  it('TC-09 非法 id 抛 INVALID_ID；文件不存在抛错', async () => {
    await expect(service.readSessionPage('../etc', 's1', { projectsDir: p.dir })).rejects.toThrow('INVALID_ID')
    await expect(service.readSessionPage('-a', 's1/../../x', { projectsDir: p.dir })).rejects.toThrow('INVALID_ID')
    await expect(read({})).rejects.toThrow()
  })
})

describe('searchSessions', () => {
  const search = (kw, opts = {}) => service.searchSessions(kw, { projectsDir: p.dir, ...opts })

  beforeEach(() => {
    p.write('-a', 'a1', stamp([L.user('网络诊断要不要做通知'), L.answer('建议做 Notification'), L.user('再说通知')], { cwd: A }), day(19))
    p.write('-a', 'a2', stamp([L.user('自动调用里提到通知')], { cwd: A, entrypoint: 'sdk-cli' }), day(18))
    p.write('-b', 'b1', stamp([L.user('飞书通知没收到')], { cwd: B }), day(17))
  })

  it('TC-10 空白关键词返回空', async () => {
    expect(await search('   ')).toEqual([])
  })

  it('TC-10 默认全部手动项目；按修改时间倒序；每对话一条；大小写不敏感', async () => {
    const r = await search('通知')
    expect(r.map((x) => x.sessionId)).toEqual(['a1', 'b1'])
    expect((await search('notification')).map((x) => x.sessionId)).toEqual(['a1'])
  })

  it('TC-10 按项目与是否含自动调用过滤', async () => {
    expect((await search('通知', { projectPath: B })).map((x) => x.sessionId)).toEqual(['b1'])
    expect((await search('通知', { includeAuto: true })).map((x) => x.sessionId)).toEqual(['a1', 'a2', 'b1'])
  })

  it('TC-10 片段与偏移：偏移能在分页结果里找到那条消息', async () => {
    const [hit] = await search('通知')
    expect(hit).toMatchObject({ projectId: '-a', sessionId: 'a1' })
    expect(hit.snippet).toContain('通知')
    const { messages } = await service.readSessionPage('-a', 'a1', { projectsDir: p.dir })
    expect(messages.find((m) => m.offset === hit.offset)?.text).toBe('网络诊断要不要做通知')
  })

  it('TC-10 片段前后各 40 字、压换行', async () => {
    p.write('-b', 'b2', stamp([L.user('前'.repeat(60) + '\n关键词\n' + '后'.repeat(60))], { cwd: B }), day(20))
    const [hit] = await search('关键词')
    expect(hit.snippet).not.toContain('\n')
    expect(hit.snippet.replace(/\.\.\./g, '').length).toBeLessThanOrEqual(40 + 3 + 40 + 2)
  })

  it('TC-10 非 ASCII 带大小写的字母也不分大小写（code 门 F-01）', async () => {
    // 关键词只含非 ASCII 的大小写字母（没有 a-z）才会走到「不分大小写」的快路
    p.write('-b', 'u1', stamp([L.user('参数 ÄÖ 的说明')], { cwd: B }), day(21))
    expect((await search('äö')).map((x) => x.sessionId)).toEqual(['u1'])
    p.write('-b', 'u2', stamp([L.user('小写 éè 在这里')], { cwd: B }), day(22))
    expect((await search('ÉÈ')).map((x) => x.sessionId)).toEqual(['u2'])
  })

  it('TC-10 最多 maxResults 条', async () => {
    for (let i = 0; i < 5; i++) p.write('-b', `x${i}`, stamp([L.user('通知 ' + i)], { cwd: B }))
    expect(await search('通知', { maxResults: 3 })).toHaveLength(3)
  })
})
