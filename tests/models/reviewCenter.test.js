/** @vitest-environment node
 * v2.1.17 · 审核配置的唯一写方（后-01～后-19、后-29、后-32、后-44、后-49、后-51、后-56；A-007、A-009、A-011、B-001、B-002）
 *
 * 文件：hub.json（本页设置）、review-rules.json（只存改过的审核规则）、review-config.json（给 dev 读的审核配置）
 * 保存两步：先写设置 / 规则，再重新生成审核配置；第二步失败把第一步按字节退回。
 * 恢复记录 .save-journal.json：「saving」= 保存途中（断电后以已落盘的设置为准）；「rollback」= 明确失败且退回也失败（启动时还原）。
 * 写入锁 .write.lock：同一配置目录只允许一个 CodePal 写。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { makeSandbox, KEY, FAKE } from './helpers'

const require = createRequire(import.meta.url)
// 新模块用 import() 载入：写实现前先失败于 Failed to resolve import
const { createReviewCenter } = await import('../../electron/modules/models/reviewCenter.js')
const { LOCK_BUSY_MESSAGE } = await import('../../electron/modules/models/writeLock.js')
const defaults = await import('../../electron/modules/models/reviewDefaults.js')
const { registerModelsHandlers } = require('../../electron/modules/models/ipc.js')
const store = require('../../electron/modules/models/store.js')

const ROLLBACK_MESSAGE = '保存失败，也没能退回原来的设置；检查配置目录的权限后重启 CodePal'
let sb, state, codexBin, center, lifecycle, handlers, children

const file = (name) => path.join(sb.models, name)
const bytes = (name) => (fs.existsSync(file(name)) ? fs.readFileSync(file(name)) : null)
const read = (name) => JSON.parse(fs.readFileSync(file(name), 'utf8'))
const configIds = () => read('review-config.json').models.map((m) => m.id)
const model = (data, id) => data.vendors.flatMap((v) => v.models).find((m) => m.id === id)
function home(relative, value) {
  const target = path.join(sb.home, relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value))
}
function machine() {
  home('.claude.json', { oauthAccount: { token: 'token_redacted' } })
  home('.claude/settings.json', { model: 'claude-sonnet-5-5' })
  home('.codex/auth.json', 'auth_value_must_never_be_read')
  home('.codex/config.toml', 'model = "gpt-6-sol"\n')
  home('.codex/models_cache.json', {
    models: ['gpt-6-astra', 'gpt-6-sol'].map((slug) => ({
      slug,
      display_name: slug.toUpperCase(),
      visibility: 'list',
      supported_reasoning_levels: ['low', 'high', 'ultra'].map((effort) => ({ effort })),
    })),
  })
  state.claude = true
  state.codex = true
}
const options = () => ({
  homeDir: sb.home,
  env: sb.env,
  locateClaude: () => (state.claude ? FAKE : null),
  locateCodex: () => (state.codex ? codexBin : null),
})
/** 模拟 CodePal 启动：建好后先做一次启动对账（打开页面只读，审核配置在启动、保存、模型接入事件后生成） */
function open() {
  center?.stop()
  center = createReviewCenter(options())
  center.reconcile()
  return center
}
function openIpc() {
  lifecycle?.stop()
  handlers = {}
  lifecycle = registerModelsHandlers({
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn } },
    getMainWindow: () => null,
    loginPath: () => sb.bin,
    hubOptions: options(),
  })
}
async function call(channel, payload) {
  expect(typeof handlers[channel], channel).toBe('function')
  return await handlers[channel]({}, payload)
}
function caught(fn) {
  try {
    fn()
  } catch (error) {
    return error
  }
  return null
}
/** 让指定文件的原子替换失败：前 after 次放行，之后失败 times 次（Infinity = 一直失败）；几条规则共用一个替身 */
let renameRules = []
function denyRename(name, { after = 0, times = Infinity } = {}) {
  renameRules.push({ target: file(name), after, times, seen: 0, failed: 0 })
  if (vi.isMockFunction(fs.renameSync)) return
  const real = fs.renameSync
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    for (const rule of renameRules) {
      if (to !== rule.target) continue
      rule.seen += 1
      if (rule.seen > rule.after && rule.failed < rule.times) {
        rule.failed += 1
        const error = new Error('test write denied')
        error.code = 'EACCES'
        throw error
      }
    }
    return real(from, to)
  })
}
/** 撤掉所有替身与失败规则 */
function allowRename() {
  vi.restoreAllMocks()
  renameRules = []
}
function aged(name) {
  const past = new Date(Date.now() - 3600_000)
  fs.utimesSync(file(name), past, past)
  return fs.statSync(file(name)).mtimeMs
}
function journal(stateName, name, before) {
  fs.writeFileSync(
    file('.save-journal.json'),
    JSON.stringify({ schemaVersion: 1, state: stateName, file: name, before: before === null ? null : before.toString('base64'), startedAt: new Date().toISOString() }),
    { mode: 0o600 },
  )
}

beforeEach(() => {
  sb = makeSandbox()
  for (const [k, v] of Object.entries(sb.env)) vi.stubEnv(k, v)
  state = { claude: false, codex: false }
  fs.mkdirSync(sb.bin, { recursive: true })
  codexBin = path.join(sb.bin, 'codex')
  fs.writeFileSync(codexBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  store.setKey('deepseek', KEY)
  store.writeStatus('deepseek', 'deepseek-flash', { ok: true, source: 'test' })
  center = null
  lifecycle = null
  children = []
})
afterEach(() => {
  center?.stop()
  lifecycle?.stop()
  for (const child of children) child.kill('SIGKILL')
  allowRename()
  vi.unstubAllEnvs()
  sb.cleanup()
})

it('SC-004 本页设置坏了：读模型、读规则都报设置文件无法解析，坏文件一个字节都不改', async () => {
  open().list()
  for (const broken of ['{broken', '[]', '{"schemaVersion":1,"reviewEnabled":null,"effort":{}}']) {
    fs.writeFileSync(file('hub.json'), broken)
    const before = bytes('hub.json')
    for (const read of [() => center.list(), () => center.rulesGet()]) {
      const error = caught(read)
      expect(error?.code).toBe('HUB_FILE_INVALID')
      expect(error.message).toBe('模型汇总的设置文件无法解析，修好或删除它后重试')
    }
    expect(bytes('hub.json').equals(before)).toBe(true)
  }
  center.stop()
  center = null
  openIpc()
  const result = await call('models:rulesGet')
  expect(result).toMatchObject({ success: false, error: { code: 'HUB_FILE_INVALID' } })
})

it('SC-006 打开只读不写：反复读模型和规则不改设置文件；接入模型首次出现抄档位只在重新生成路径做', () => {
  const c = open()
  c.list()
  c.rulesSet({ key: 'gates.lite.G1.rounds', value: 2 })
  const hubTime = aged('hub.json')
  const rulesTime = aged('review-rules.json')
  const configTime = aged('review-config.json')
  const hubBefore = bytes('hub.json')
  const rulesBefore = bytes('review-rules.json')
  store.setKey('mimo-api', KEY)
  store.writeStatus('mimo-api', 'mimo-v2.6-pro', { ok: true, source: 'test' })
  for (let i = 0; i < 3; i += 1) {
    c.list()
    c.rulesGet()
  }
  expect(bytes('hub.json').equals(hubBefore)).toBe(true)
  expect(fs.statSync(file('hub.json')).mtimeMs).toBe(hubTime)
  expect(bytes('review-rules.json').equals(rulesBefore)).toBe(true)
  expect(fs.statSync(file('review-rules.json')).mtimeMs).toBe(rulesTime)
  expect(read('hub.json').effort['mimo-api:mimo-v2.6-pro']).toBeUndefined()
  // 打开只读：给 dev 的审核配置也不在读页面时写（它在启动、保存、模型接入事件后重新生成）
  expect(fs.statSync(file('review-config.json')).mtimeMs).toBe(configTime)
  // 重新生成路径（模型接入事件后 / 启动对账）把接入现值抄进 hub
  c.refreshQuietly()
  const access = store.readConfig().providers['mimo-api'].models[0].effort
  expect(read('hub.json').effort['mimo-api:mimo-v2.6-pro']).toBe(access)
})

it('SC-009 审核规则文件坏了：只有规则读取失败；模型照常能改，审核配置的规则部分沿用上一份有效的，没有就用默认值', () => {
  const c = open()
  c.list()
  c.rulesSet({ key: 'gates.lite.G1.reviewers', value: 3 })
  fs.writeFileSync(file('review-rules.json'), '{broken')
  const before = bytes('review-rules.json')
  const error = caught(() => c.rulesGet())
  expect(error?.code).toBe('RULES_FILE_INVALID')
  expect(error.message).toBe('审核规则文件无法解析，修好或删除它后重试')
  expect(() => c.list()).not.toThrow()
  c.setEnabled({ id: 'deepseek:deepseek-flash', enabled: false })
  c.setEnabled({ id: 'deepseek:deepseek-flash', enabled: true })
  expect(read('review-config.json').gates['lite.G1'].reviewers).toBe(3)
  expect(bytes('review-rules.json').equals(before)).toBe(true)
  // 规则改坏的同时审核配置也没了：规则部分用默认值
  fs.rmSync(file('review-config.json'))
  c.setEnabled({ id: 'deepseek:deepseek-flash', enabled: false })
  expect(read('review-config.json').gates).toEqual(defaults.DEFAULTS.gates)
  expect(caught(() => c.rulesSet({ key: 'selfReview', value: true }))?.code).toBe('RULES_FILE_INVALID')
  expect(bytes('review-rules.json').equals(before)).toBe(true)
})

it('SC-012 打开模型后审核配置末尾是它，关掉后移出', () => {
  machine()
  const c = open()
  c.list()
  c.setEnabled({ id: 'codex:gpt-6-astra', enabled: true })
  expect(configIds().at(-1)).toBe('codex:gpt-6-astra')
  c.setEnabled({ id: 'codex:gpt-6-astra', enabled: false })
  expect(configIds()).not.toContain('codex:gpt-6-astra')
})

it('SC-014 第一步失败什么都不变；第二步失败把设置按字节退回、审核配置不变、恢复记录删除', () => {
  const c = open()
  c.list()
  const hubBefore = bytes('hub.json')
  const configBefore = bytes('review-config.json')
  denyRename('hub.json')
  expect(caught(() => c.setEnabled({ id: 'deepseek:deepseek-flash', enabled: false }))?.code).toBe('write_denied')
  allowRename()
  expect(bytes('hub.json').equals(hubBefore)).toBe(true)
  expect(bytes('review-config.json').equals(configBefore)).toBe(true)
  expect(fs.existsSync(file('.save-journal.json'))).toBe(false)

  denyRename('review-config.json')
  expect(caught(() => c.setEnabled({ id: 'deepseek:deepseek-flash', enabled: false }))?.code).toBe('write_denied')
  allowRename()
  expect(bytes('hub.json').equals(hubBefore)).toBe(true)
  expect(bytes('review-config.json').equals(configBefore)).toBe(true)
  expect(fs.existsSync(file('.save-journal.json'))).toBe(false)
  expect(fs.readdirSync(sb.models).some((n) => n.endsWith('.tmp'))).toBe(false)
})

it('SC-014 回滚本身也失败：返回回滚失败、不宣称已退回、记录改成要退回；重启后按记录还原，两份文件一致', () => {
  const c = open()
  c.list()
  // 先走一次重新生成路径（接入模型首次出现时抄等级），之后的字节对比才只反映这次保存
  c.refreshQuietly()
  const hubBefore = bytes('hub.json')
  denyRename('review-config.json')
  denyRename('hub.json', { after: 1 })
  const error = caught(() => c.setEnabled({ id: 'deepseek:deepseek-flash', enabled: false }))
  allowRename()
  expect(error?.code).toBe('ROLLBACK_FAILED')
  expect(error.message).toBe(ROLLBACK_MESSAGE)
  expect(read('.save-journal.json')).toMatchObject({ state: 'rollback', file: 'hub.json' })
  expect(read('hub.json').reviewEnabled['deepseek:deepseek-flash']).toBe(false)
  c.stop()
  center = null
  const restarted = open()
  restarted.reconcile()
  expect(bytes('hub.json').equals(hubBefore)).toBe(true)
  expect(configIds()).toEqual(['deepseek:deepseek-flash'])
  expect(fs.existsSync(file('.save-journal.json'))).toBe(false)
  expect(model(restarted.list(), 'deepseek:deepseek-flash').enabled).toBe(true)
})

it('SC-014 有没做完的退回时：再保存、重试、来源事件都先做退回，做不完就拒绝且不动记录；能写了第一次写入先还原再执行', () => {
  machine()
  const c = open()
  c.list()
  const hubBefore = bytes('hub.json')
  denyRename('review-config.json')
  denyRename('hub.json', { after: 1 })
  expect(caught(() => c.setEnabled({ id: 'claude:sonnet', enabled: false }))?.code).toBe('ROLLBACK_FAILED')
  const pending = bytes('.save-journal.json')
  expect(read('.save-journal.json').state).toBe('rollback')
  // 写入仍然失败：任何写入都不能覆盖或删掉「要退回」记录
  const again = caught(() => c.setEnabled({ id: 'codex:gpt-6-astra', enabled: true }))
  expect(again?.code).toBe('ROLLBACK_FAILED')
  expect(again.message).toBe(ROLLBACK_MESSAGE)
  expect(caught(() => c.rulesSet({ key: 'selfReview', value: true }))?.code).toBe('ROLLBACK_FAILED')
  expect(c.republish()).toEqual({ exportOk: false })
  c.refreshQuietly()
  expect(bytes('.save-journal.json').equals(pending)).toBe(true)
  expect(fs.existsSync(file('review-rules.json'))).toBe(false)
  // 写入恢复：这次保存先把旧设置还原，再执行这次的改动，两份文件一致
  allowRename()
  c.setEffort({ id: 'codex:gpt-6-sol', effort: 'ultra' })
  expect(fs.existsSync(file('.save-journal.json'))).toBe(false)
  const hub = read('hub.json')
  expect(hub.reviewEnabled['claude:sonnet']).toBe(JSON.parse(hubBefore.toString()).reviewEnabled['claude:sonnet'])
  expect(hub.effort['codex:gpt-6-sol']).toBe('ultra')
  expect(configIds()).toEqual(['claude:sonnet', 'codex:gpt-6-sol', 'deepseek:deepseek-flash'])
  expect(read('review-config.json').models.find((m) => m.id === 'codex:gpt-6-sol').effort).toBe('ultra')
})

it('SC-014 连「要退回」都写不进：同一句不承诺的提示，记录仍是保存中；重启后以磁盘上的设置为准，两份文件一致', () => {
  const c = open()
  c.list()
  denyRename('review-config.json')
  denyRename('hub.json', { after: 1 })
  denyRename('.save-journal.json', { after: 1 })
  const error = caught(() => c.setEnabled({ id: 'deepseek:deepseek-flash', enabled: false }))
  allowRename()
  expect(error?.code).toBe('ROLLBACK_FAILED')
  expect(error.message).toBe(ROLLBACK_MESSAGE)
  expect(read('.save-journal.json').state).toBe('saving')
  expect(read('hub.json').reviewEnabled['deepseek:deepseek-flash']).toBe(false)
  c.stop()
  center = null
  open().reconcile()
  expect(read('hub.json').reviewEnabled['deepseek:deepseek-flash']).toBe(false)
  expect(configIds()).toEqual([])
  expect(fs.existsSync(file('.save-journal.json'))).toBe(false)
})

it('SC-014 保存途中断电：重启后以已落盘的新设置为准重新生成，不退回旧值；配置已生成只剩记录时不重写配置', () => {
  const c = open()
  c.list()
  const old = bytes('hub.json')
  c.stop()
  center = null
  // 模拟：记录写下、第一步写完新设置、还没生成审核配置就断电
  journal('saving', 'hub.json', old)
  const next = read('hub.json')
  next.reviewEnabled['deepseek:deepseek-flash'] = false
  fs.writeFileSync(file('hub.json'), JSON.stringify(next), { mode: 0o600 })
  expect(configIds()).toEqual(['deepseek:deepseek-flash'])
  open().reconcile()
  expect(read('hub.json').reviewEnabled['deepseek:deepseek-flash']).toBe(false)
  expect(configIds()).toEqual([])
  expect(fs.existsSync(file('.save-journal.json'))).toBe(false)

  // 模拟：审核配置也已生成、只差删记录
  journal('saving', 'hub.json', old)
  const configTime = aged('review-config.json')
  const configBefore = bytes('review-config.json')
  open().reconcile()
  expect(read('hub.json').reviewEnabled['deepseek:deepseek-flash']).toBe(false)
  expect(bytes('review-config.json').equals(configBefore)).toBe(true)
  expect(fs.statSync(file('review-config.json')).mtimeMs).toBe(configTime)
  expect(fs.existsSync(file('.save-journal.json'))).toBe(false)
})

it('SC-014 写入锁：另一个活着的 CodePal 占着时保存失败、什么都不写；占锁的进程已不在就接管', () => {
  open().list()
  center.stop()
  center = null
  expect(fs.existsSync(file('.write.lock'))).toBe(false)
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' })
  children.push(other)
  fs.writeFileSync(file('.write.lock'), JSON.stringify({ pid: other.pid }))
  const hubBefore = bytes('hub.json')
  const configBefore = bytes('review-config.json')
  const c = open()
  const error = caught(() => c.setEnabled({ id: 'deepseek:deepseek-flash', enabled: false }))
  expect(error?.code).toBe('LOCK_BUSY')
  expect(error.message).toBe(LOCK_BUSY_MESSAGE)
  expect(LOCK_BUSY_MESSAGE).toBe('另一个 CodePal 正在写这份配置，关掉它后重试')
  expect(bytes('hub.json').equals(hubBefore)).toBe(true)
  expect(bytes('review-config.json').equals(configBefore)).toBe(true)
  expect(caught(() => c.rulesSet({ key: 'selfReview', value: true }))?.code).toBe('LOCK_BUSY')
  expect(fs.existsSync(file('review-rules.json'))).toBe(false)

  const gone = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' })
  fs.writeFileSync(file('.write.lock'), JSON.stringify({ pid: Number(gone.stdout) }))
  expect(c.setEnabled({ id: 'deepseek:deepseek-flash', enabled: false })).toEqual({ id: 'deepseek:deepseek-flash', enabled: false })
  expect(read('.write.lock').pid).toBe(process.pid)
  c.stop()
  center = null
  expect(fs.existsSync(file('.write.lock'))).toBe(false)
})

it('SC-014 两个 CodePal 同时接管崩溃留下的锁：另一个正在接管时这次保存失败，旧锁不动', () => {
  open().list()
  center.stop()
  center = null
  const gone = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' })
  fs.writeFileSync(file('.write.lock'), JSON.stringify({ pid: Number(gone.stdout) }))
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' })
  children.push(other)
  fs.writeFileSync(file(`.write-lock-takeover.${other.pid}`), String(other.pid))
  const lockBefore = bytes('.write.lock')
  const hubBefore = bytes('hub.json')
  const c = open()
  expect(caught(() => c.setEnabled({ id: 'deepseek:deepseek-flash', enabled: false }))?.code).toBe('LOCK_BUSY')
  expect(bytes('.write.lock').equals(lockBefore)).toBe(true)
  expect(bytes('hub.json').equals(hubBefore)).toBe(true)
  expect(fs.existsSync(file(`.write-lock-takeover.${process.pid}`))).toBe(false)
  // 对方接管完、标记删掉后（进程不在的标记不算），这边就能接管
  fs.rmSync(file(`.write-lock-takeover.${other.pid}`))
  fs.writeFileSync(file(`.write-lock-takeover.${Number(gone.stdout)}`), 'x')
  expect(c.setEnabled({ id: 'deepseek:deepseek-flash', enabled: false })).toEqual({ id: 'deepseek:deepseek-flash', enabled: false })
  expect(read('.write.lock').pid).toBe(process.pid)
})

it('SC-014 判定旧锁可接管之后、真正接管之前锁被别人换成了新锁：不删别人的新锁，这次保存失败', () => {
  open().list()
  center.stop()
  center = null
  const gone = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' })
  fs.writeFileSync(file('.write.lock'), JSON.stringify({ pid: Number(gone.stdout) }))
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' })
  children.push(other)
  const fresh = JSON.stringify({ pid: other.pid })
  const realWrite = fs.writeFileSync
  // 这边刚放下接管标记时，另一个 CodePal 已接管完：锁文件换成它的
  vi.spyOn(fs, 'writeFileSync').mockImplementation((target, ...rest) => {
    const result = realWrite(target, ...rest)
    if (String(target).endsWith(`.write-lock-takeover.${process.pid}`)) realWrite(file('.write.lock'), fresh)
    return result
  })
  const hubBefore = bytes('hub.json')
  const c = open()
  expect(caught(() => c.setEnabled({ id: 'deepseek:deepseek-flash', enabled: false }))?.code).toBe('LOCK_BUSY')
  expect(fs.readFileSync(file('.write.lock'), 'utf8')).toBe(fresh)
  expect(bytes('hub.json').equals(hubBefore)).toBe(true)
})

it('SC-014 锁文件一出现就是完整内容：先写临时文件再链接成锁，不留临时文件', () => {
  const realLink = fs.linkSync
  const seen = []
  vi.spyOn(fs, 'linkSync').mockImplementation((from, to) => {
    if (String(to).endsWith('.write.lock')) seen.push(JSON.parse(fs.readFileSync(from, 'utf8')).pid)
    return realLink(from, to)
  })
  const c = open()
  c.list()
  c.setEnabled({ id: 'deepseek:deepseek-flash', enabled: false })
  expect(seen).toEqual([process.pid])
  expect(read('.write.lock').pid).toBe(process.pid)
  expect(fs.readdirSync(sb.models).some((name) => name.endsWith('.tmp'))).toBe(false)
})

it('SC-044 审核配置换好之后旧审核清单删不掉：保存照样成功，设置、页面与审核配置一致', () => {
  const c = open()
  c.list()
  // 旧清单变成删不掉的目录（rmSync 不带 recursive 会报错）
  fs.mkdirSync(file('review-models.json'))
  fs.writeFileSync(path.join(file('review-models.json'), 'keep'), 'x')
  expect(c.rulesSet({ key: 'selfReview', value: true })).toMatchObject({ key: 'selfReview', value: true })
  expect(read('review-rules.json').overrides).toEqual({ selfReview: true })
  expect(read('review-config.json').selfReview).toBe(true)
  expect(c.rulesGet()).toMatchObject({ exportOk: true, effective: { selfReview: true } })
  expect(fs.existsSync(file('.save-journal.json'))).toBe(false)
  expect(c.setEnabled({ id: 'deepseek:deepseek-flash', enabled: false })).toEqual({ id: 'deepseek:deepseek-flash', enabled: false })
  expect(configIds()).not.toContain('deepseek:deepseek-flash')
})

it('SC-014 两份文件都已写好之后删不掉恢复记录：保存照样算成功，页面与磁盘一致；之后的写入照常', () => {
  const c = open()
  c.list()
  const journalPath = file('.save-journal.json')
  const realRm = fs.rmSync
  vi.spyOn(fs, 'rmSync').mockImplementation((target, ...rest) => {
    if (target === journalPath && fs.existsSync(journalPath)) {
      const error = new Error('test cleanup denied')
      error.code = 'EPERM'
      throw error
    }
    return realRm(target, ...rest)
  })
  expect(c.rulesSet({ key: 'gates.lite.G1.reviewers', value: 3 })).toMatchObject({ key: 'gates.lite.G1.reviewers', value: 3 })
  expect(read('review-rules.json').overrides).toEqual({ 'gates.lite.G1.reviewers': 3 })
  expect(read('review-config.json').gates['lite.G1'].reviewers).toBe(3)
  expect(c.rulesGet()).toMatchObject({ exportOk: true, effective: { gates: { 'lite.G1': { reviewers: 3 } } } })
  vi.restoreAllMocks()
  // 留下的「保存中」记录在下一次写入时按已落盘的设置处理掉
  expect(c.rulesSet({ key: 'gates.lite.G1.rounds', value: 2 })).toMatchObject({ value: 2 })
  expect(fs.existsSync(journalPath)).toBe(false)
  expect(read('review-config.json').gates['lite.G1']).toEqual({ reviewers: 3, rounds: 2 })
  // 页面用来在保存中判断「改过没有」的建议值
  expect(c.rulesGet().suggested).toEqual(defaults.effectiveRules({}, defaults.DEFAULTS))
})

it('SC-045 点重试时另一个 CodePal 占着写入锁：红字状态不变，返回锁被占', () => {
  const c = open()
  c.list()
  fs.rmSync(file('review-config.json'))
  denyRename('review-config.json')
  c.reconcile()
  expect(c.rulesGet()).toMatchObject({ exportOk: false, exportUsing: 'defaults' })
  allowRename()
  c.stop()
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' })
  children.push(other)
  fs.writeFileSync(file('.write.lock'), JSON.stringify({ pid: other.pid }))
  expect(caught(() => c.republish())?.code).toBe('LOCK_BUSY')
  expect(c.rulesGet()).toMatchObject({ exportOk: false, exportUsing: 'defaults' })
  fs.rmSync(file('.write.lock'))
  expect(c.republish()).toEqual({ exportOk: true })
})

it('SC-016 整串保存顺序：只接受当前可见审核在用的排列；暂时消失的模型留在原位，恢复后顺序一致', () => {
  machine()
  store.setKey('mimo-api', KEY)
  store.writeStatus('mimo-api', 'mimo-v2.6-pro', { ok: true, source: 'test' })
  const c = open()
  c.list()
  c.setEnabled({ id: 'mimo-api:mimo-v2.6-pro', enabled: true })
  c.setEnabled({ id: 'deepseek:deepseek-flash', enabled: true })
  // [A, B, C, D] = sonnet, gpt-6-sol, mimo, deepseek
  c.setOrder({ order: ['claude:sonnet', 'codex:gpt-6-sol', 'mimo-api:mimo-v2.6-pro', 'deepseek:deepseek-flash'] })
  c.setEffort({ id: 'codex:gpt-6-sol', effort: 'ultra' })
  for (const bad of [
    ['claude:sonnet', 'codex:gpt-6-sol', 'mimo-api:mimo-v2.6-pro'],
    ['claude:sonnet', 'codex:gpt-6-sol', 'mimo-api:mimo-v2.6-pro', 'deepseek:deepseek-flash', 'codex:gpt-6-astra'],
    ['claude:sonnet', 'claude:sonnet', 'mimo-api:mimo-v2.6-pro', 'deepseek:deepseek-flash'],
    ['claude:sonnet', 'codex:gpt-6-sol', 'mimo-api:mimo-v2.6-pro', 'nobody:x'],
    'claude:sonnet',
  ]) {
    const before = bytes('hub.json')
    expect(caught(() => c.setOrder({ order: bad }))?.code).toBe('invalid_input')
    expect(bytes('hub.json').equals(before)).toBe(true)
  }
  // B 暂时消失
  fs.rmSync(path.join(sb.home, '.codex/auth.json'))
  expect(c.list().order).toEqual(['claude:sonnet', 'mimo-api:mimo-v2.6-pro', 'deepseek:deepseek-flash'])
  c.setOrder({ order: ['deepseek:deepseek-flash', 'claude:sonnet', 'mimo-api:mimo-v2.6-pro'] })
  expect(read('hub.json').order).toEqual(['deepseek:deepseek-flash', 'codex:gpt-6-sol', 'claude:sonnet', 'mimo-api:mimo-v2.6-pro'])
  expect(configIds()).toEqual(['deepseek:deepseek-flash', 'claude:sonnet', 'mimo-api:mimo-v2.6-pro'])
  home('.codex/auth.json', 'auth_value_must_never_be_read')
  const data = c.list()
  expect(data.order).toEqual(['deepseek:deepseek-flash', 'codex:gpt-6-sol', 'claude:sonnet', 'mimo-api:mimo-v2.6-pro'])
  expect(model(data, 'codex:gpt-6-sol')).toMatchObject({ enabled: true, effort: 'ultra' })
  c.refreshQuietly()
  expect(configIds()).toEqual(['deepseek:deepseek-flash', 'codex:gpt-6-sol', 'claude:sonnet', 'mimo-api:mimo-v2.6-pro'])
})

it('SC-018 顺序保存失败：审核配置写不进时顺序退回', () => {
  machine()
  const c = open()
  c.list()
  const before = bytes('hub.json')
  denyRename('review-config.json')
  expect(caught(() => c.setOrder({ order: ['deepseek:deepseek-flash', 'codex:gpt-6-sol', 'claude:sonnet'] }))?.code).toBe('write_denied')
  allowRename()
  expect(bytes('hub.json').equals(before)).toBe(true)
  expect(c.list().order).toEqual(['claude:sonnet', 'codex:gpt-6-sol', 'deepseek:deepseek-flash'])
})

it('SC-021 审核用的等级写进审核配置；档位不再支持显示默认档并标出原值；没有档位的模型等级为空', () => {
  machine()
  store.setKey('mimo-api', KEY)
  store.writeStatus('mimo-api', 'mimo-v2.6-pro', { ok: true, source: 'test' })
  store.setKey('minimax-api', 'fixture.minimax-api')
  store.writeStatus('minimax-api', 'MiniMax-M3', { ok: true, source: 'test' })
  const c = open()
  c.list()
  c.setEffort({ id: 'deepseek:deepseek-flash', effort: 'high' })
  expect(read('review-config.json').models.find((m) => m.id === 'deepseek:deepseek-flash').effort).toBe('high')
  expect(caught(() => c.setEffort({ id: 'deepseek:deepseek-flash', effort: 'ultra' }))?.code).toBe('invalid_input')
  c.setEnabled({ id: 'mimo-api:mimo-v2.6-pro', enabled: true })
  c.setEnabled({ id: 'minimax-api:MiniMax-M3', enabled: true })
  const hub = read('hub.json')
  hub.effort['mimo-api:mimo-v2.6-pro'] = 'max'
  hub.effort['codex:gpt-6-sol'] = 'max'
  fs.writeFileSync(file('hub.json'), JSON.stringify(hub), { mode: 0o600 })
  const data = c.list()
  expect(model(data, 'mimo-api:mimo-v2.6-pro')).toMatchObject({ effort: 'high', effortUnsupported: 'max' })
  expect(model(data, 'codex:gpt-6-sol')).toMatchObject({ effort: 'high', effortUnsupported: 'max' })
  expect(model(data, 'minimax-api:MiniMax-M3')).toMatchObject({ efforts: [], effort: null })
  expect(model(data, 'deepseek:deepseek-flash').effortUnsupported).toBeUndefined()
  c.refreshQuietly()
  const config = read('review-config.json').models
  expect(config.find((m) => m.id === 'mimo-api:mimo-v2.6-pro').effort).toBe('high')
  expect(config.find((m) => m.id === 'codex:gpt-6-sol').effort).toBe('high')
  expect(config.find((m) => m.id === 'minimax-api:MiniMax-M3').effort).toBeNull()
})

it('SC-025 每道关的个数和轮数：逐个保存后重读一致，规则文件只存改过的项，审核配置跟着变；非法键和值不写文件', () => {
  const c = open()
  c.list()
  const values = {}
  for (const [index, gate] of defaults.GATE_IDS.entries()) {
    const reviewers = (index % 3) + 1
    const rounds = (index % 5) + 1
    expect(c.rulesSet({ key: `gates.${gate}.reviewers`, value: reviewers })).toMatchObject({ key: `gates.${gate}.reviewers`, value: reviewers })
    c.rulesSet({ key: `gates.${gate}.rounds`, value: rounds })
    values[gate] = { reviewers, rounds }
  }
  const reopened = open()
  expect(reopened.rulesGet().effective.gates).toEqual(values)
  expect(read('review-config.json').gates).toEqual(values)
  const overrides = read('review-rules.json').overrides
  for (const [gate, value] of Object.entries(values)) {
    for (const field of ['reviewers', 'rounds']) {
      const key = `gates.${gate}.${field}`
      if (value[field] === defaults.DEFAULTS.gates[gate][field]) expect(overrides[key]).toBeUndefined()
      else expect(overrides[key]).toBe(value[field])
    }
  }
  expect(fs.statSync(file('review-rules.json')).mode & 0o777).toBe(0o600)
  const before = bytes('review-rules.json')
  for (const [key, value] of [['gates.lite.G1.reviewers', 4], ['gates.formal.G3.rounds', 0], ['gates.lite.G1.rounds', 1.5], ['nope', 1], ['gates.lite.G1.reviewers', '3']]) {
    expect(caught(() => reopened.rulesSet({ key, value }))?.code).toBe('invalid_input')
  }
  expect(caught(() => reopened.rulesSet(undefined))?.code).toBe('invalid_input')
  expect(bytes('review-rules.json').equals(before)).toBe(true)
})

it('SC-027 规则保存失败：第二步失败规则文件按字节退回；退回也失败记成要退回，重启还原', () => {
  const c = open()
  c.list()
  c.rulesSet({ key: 'gates.formal.G3.rounds', value: 3 })
  c.rulesSet({ key: 'gates.lite.G1.reviewers', value: 3 })
  const before = bytes('review-rules.json')
  denyRename('review-config.json')
  expect(caught(() => c.rulesSet({ key: 'gates.lite.G1.reviewers', value: 1 }))?.code).toBe('write_denied')
  allowRename()
  expect(bytes('review-rules.json').equals(before)).toBe(true)

  denyRename('review-config.json')
  denyRename('review-rules.json', { after: 1 })
  const error = caught(() => c.rulesSet({ key: 'gates.lite.G1.reviewers', value: 1 }))
  allowRename()
  expect(error?.code).toBe('ROLLBACK_FAILED')
  expect(error.message).toBe(ROLLBACK_MESSAGE)
  expect(read('.save-journal.json')).toMatchObject({ state: 'rollback', file: 'review-rules.json' })
  open().reconcile()
  expect(bytes('review-rules.json').equals(before)).toBe(true)
  expect(read('review-config.json').gates['lite.G1'].reviewers).toBe(3)
  expect(fs.existsSync(file('.save-journal.json'))).toBe(false)
})

it('SC-027 保存途中断电（轮数 3 改 4）：重启后保留 4，审核配置跟到 4', () => {
  const c = open()
  c.list()
  c.stop()
  center = null
  journal('saving', 'review-rules.json', null)
  fs.writeFileSync(
    file('review-rules.json'),
    JSON.stringify({ schemaVersion: 1, overrides: { 'gates.formal.G3.rounds': 4 }, updatedAt: new Date().toISOString() }),
    { mode: 0o600 },
  )
  expect(read('review-config.json').gates['formal.G3'].rounds).toBe(3)
  open().reconcile()
  expect(read('review-rules.json').overrides['gates.formal.G3.rounds']).toBe(4)
  expect(read('review-config.json').gates['formal.G3'].rounds).toBe(4)
  expect(fs.existsSync(file('.save-journal.json'))).toBe(false)
})

it('SC-030 自审开关：保存后审核配置 selfReview 跟着变；第二步失败规则文件退回', () => {
  const c = open()
  c.list()
  expect(c.rulesSet({ key: 'selfReview', value: true })).toMatchObject({ key: 'selfReview', value: true, changed: true })
  expect(read('review-config.json').selfReview).toBe(true)
  const before = bytes('review-rules.json')
  denyRename('review-config.json')
  expect(caught(() => c.rulesSet({ key: 'selfReview', value: false }))?.code).toBe('write_denied')
  allowRename()
  expect(bytes('review-rules.json').equals(before)).toBe(true)
  expect(read('review-config.json').selfReview).toBe(true)
})

it('SC-033 高级三项：各自保存、重读一致、审核配置跟着变；不在档位里的值拒绝', () => {
  const c = open()
  c.list()
  c.rulesSet({ key: 'advanced.timeoutMinutes', value: 30 })
  c.rulesSet({ key: 'advanced.failoverMax', value: 5 })
  c.rulesSet({ key: 'advanced.autoExtendRounds', value: 0 })
  expect(open().rulesGet().effective.advanced).toEqual({ timeoutMinutes: 30, failoverMax: 5, autoExtendRounds: 0 })
  expect(read('review-config.json').advanced).toEqual({ timeoutMinutes: 30, failoverMax: 5, autoExtendRounds: 0 })
  for (const [key, value] of [['advanced.timeoutMinutes', 25], ['advanced.failoverMax', -1], ['advanced.autoExtendRounds', 9]]) {
    expect(caught(() => center.rulesSet({ key, value }))?.code).toBe('invalid_input')
  }
})

it('SC-035 恢复默认：清空改过项、审核配置回到建议值；模型的开关、顺序、等级字节不变', () => {
  machine()
  const c = open()
  c.list()
  c.setEffort({ id: 'codex:gpt-6-sol', effort: 'ultra' })
  c.rulesSet({ key: 'gates.lite.G1.reviewers', value: 3 })
  c.rulesSet({ key: 'advanced.timeoutMinutes', value: 30 })
  const hubBefore = bytes('hub.json')
  expect(c.rulesReset()).toEqual({ effective: defaults.effectiveRules({}), changed: false })
  expect(read('review-rules.json').overrides).toEqual({})
  expect(read('review-config.json').gates).toEqual(defaults.DEFAULTS.gates)
  expect(read('review-config.json').advanced).toEqual(defaults.DEFAULTS.advanced)
  expect(bytes('hub.json').equals(hubBefore)).toBe(true)
  expect(c.rulesGet().changed).toBe(false)
})

it('SC-037 恢复默认失败：规则文件退回，改过项还在', () => {
  const c = open()
  c.list()
  c.rulesSet({ key: 'gates.lite.G1.reviewers', value: 3 })
  const before = bytes('review-rules.json')
  denyRename('review-config.json')
  expect(caught(() => c.rulesReset())?.code).toBe('write_denied')
  allowRename()
  expect(bytes('review-rules.json').equals(before)).toBe(true)
  expect(c.rulesGet().changed).toBe(true)
})

it('SC-044 审核配置内容：字段照定稿、按顺序只列打开且可用的、不含 Key 与本机路径，0644', () => {
  machine()
  store.setKey('minimax-api', 'fixture.minimax-api')
  store.writeStatus('minimax-api', 'MiniMax-M3', { ok: true, source: 'test' })
  const c = open()
  c.list()
  c.setEnabled({ id: 'minimax-api:MiniMax-M3', enabled: true })
  const access = store.readConfig().providers.deepseek.models[0].effort
  const config = read('review-config.json')
  expect(Object.keys(config).sort()).toEqual(
    ['schemaVersion', 'generator', 'generatedAt', 'defaultsVersion', 'minDevWorkflow', 'selfReview', 'models', 'gates', 'advanced'].sort(),
  )
  expect(config).toMatchObject({
    schemaVersion: 1,
    defaultsVersion: defaults.DEFAULTS_VERSION,
    minDevWorkflow: defaults.MIN_DEV_WORKFLOW,
    selfReview: false,
    gates: defaults.DEFAULTS.gates,
    advanced: defaults.DEFAULTS.advanced,
  })
  expect(config.generator).toMatch(/^CodePal \d/)
  expect(Number.isNaN(Date.parse(config.generatedAt))).toBe(false)
  expect(config.models).toEqual([
    { id: 'claude:sonnet', family: 'anthropic', runner: 'claude-cli', model: 'sonnet', displayName: 'Sonnet 5.5', effort: 'high' },
    { id: 'codex:gpt-6-sol', family: 'openai', runner: 'codex-exec', model: 'gpt-6-sol', displayName: 'GPT-6-SOL', effort: 'high' },
    { id: 'deepseek:deepseek-flash', family: 'deepseek', runner: 'codepal', provider: 'deepseek', model: 'deepseek-flash', displayName: 'deepseek-flash', effort: access },
    { id: 'minimax-api:MiniMax-M3', family: 'minimax', runner: 'codepal', provider: 'minimax-api', model: 'MiniMax-M3', displayName: 'MiniMax-M3', effort: null },
  ])
  const text = fs.readFileSync(file('review-config.json'), 'utf8')
  for (const secret of [KEY, 'fixture.minimax-api', 'token_redacted', 'auth_value', sb.root, sb.bin, '"command"', '"billing"']) {
    expect(text.includes(secret), secret).toBe(false)
  }
  expect(fs.statSync(file('review-config.json')).mode & 0o777).toBe(0o644)
})

it('SC-044 重新生成的时机：保存、模型接入事件、启动对账会写；内容没变不写', async () => {
  const c = open()
  c.list()
  let stamp = aged('review-config.json')
  let before = bytes('review-config.json')
  c.list()
  c.rulesGet()
  c.refreshQuietly()
  c.reconcile()
  expect(bytes('review-config.json').equals(before)).toBe(true)
  expect(fs.statSync(file('review-config.json')).mtimeMs).toBe(stamp)
  c.rulesSet({ key: 'gates.formal.G4.rounds', value: 5 })
  expect(read('review-config.json').gates['formal.G4'].rounds).toBe(5)
  c.stop()
  center = null

  // 模型接入里删掉模型：不用打开本页，审核配置马上去掉它
  openIpc()
  expect(read('review-config.json').models.map((m) => m.id)).toEqual(['deepseek:deepseek-flash'])
  const removed = await call('models:removeModel', { providerId: 'deepseek', modelId: 'deepseek-flash' })
  expect(removed.success).toBe(true)
  expect(read('review-config.json').models).toEqual([])
  lifecycle.stop()
  lifecycle = null

  // 启动对账：手改过的审核配置（范围内）按设置写回
  const config = read('review-config.json')
  config.gates['lite.G1'].reviewers = 3
  fs.writeFileSync(file('review-config.json'), JSON.stringify(config))
  openIpc()
  expect(read('review-config.json').gates['lite.G1'].reviewers).toBe(2)
  expect(read('review-config.json').gates['formal.G4'].rounds).toBe(5)
})

it('SC-044 手改坏了或超范围：当作坏了，打开页面只读且不报红字，启动对账时按设置重新生成；首次写删掉旧审核清单', () => {
  fs.mkdirSync(sb.models, { recursive: true })
  fs.writeFileSync(file('review-models.json'), JSON.stringify({ schemaVersion: 1, models: [] }))
  const c = open()
  c.list()
  expect(fs.existsSync(file('review-models.json'))).toBe(false)
  const good = read('review-config.json')
  for (const mutate of [
    (cfg) => { cfg.gates['lite.G1'].reviewers = 9 },
    (cfg) => { cfg.advanced.timeoutMinutes = 7 },
    (cfg) => { cfg.schemaVersion = 99 },
    (cfg) => { delete cfg.models },
    () => '{broken',
  ]) {
    const cfg = structuredClone(good)
    const replaced = mutate(cfg)
    fs.writeFileSync(file('review-config.json'), typeof replaced === 'string' ? replaced : JSON.stringify(cfg))
    const broken = bytes('review-config.json')
    c.list()
    // 打开只读：坏文件不动，也不报红字（发现就重新生成、不提示；红字只在重新生成写不进去时出现）
    expect(bytes('review-config.json').equals(broken)).toBe(true)
    expect(c.rulesGet()).toMatchObject({ exportOk: true, exportUsing: null })
    c.reconcile()
    expect(read('review-config.json').gates).toEqual(good.gates)
    expect(read('review-config.json').advanced).toEqual(good.advanced)
    expect(read('review-config.json').schemaVersion).toBe(1)
    expect(c.rulesGet().exportOk).toBe(true)
  }
})

it('SC-044 写法：先写临时文件再替换，替换前失败原文件不变；同一进程并发两次保存按顺序执行', async () => {
  const c = open()
  c.list()
  // 让审核配置和设置对不上（手改成范围内的另一个值），这样重新生成一定要写
  const stale = read('review-config.json')
  stale.gates['lite.G1'].reviewers = 3
  fs.writeFileSync(file('review-config.json'), JSON.stringify(stale))
  const before = bytes('review-config.json')
  const realWrite = fs.writeFileSync
  vi.spyOn(fs, 'writeFileSync').mockImplementation((target, ...rest) => {
    if (String(target).startsWith(`${file('review-config.json')}.`) && String(target).endsWith('.tmp')) {
      const error = new Error('disk full')
      error.code = 'ENOSPC'
      throw error
    }
    return realWrite(target, ...rest)
  })
  expect(c.republish()).toEqual({ exportOk: false })
  allowRename()
  expect(bytes('review-config.json').equals(before)).toBe(true)
  expect(fs.readdirSync(sb.models).some((n) => n.endsWith('.tmp'))).toBe(false)
  c.stop()
  center = null

  openIpc()
  const results = await Promise.all([
    call('models:rulesSet', { key: 'gates.lite.G0.rounds', value: 5 }),
    call('models:rulesSet', { key: 'advanced.failoverMax', value: 1 }),
    call('models:hubSetEnabled', { id: 'deepseek:deepseek-flash', enabled: false }),
  ])
  expect(results.every((r) => r.success)).toBe(true)
  expect(read('review-rules.json').overrides).toEqual({ 'gates.lite.G0.rounds': 5, 'advanced.failoverMax': 1 })
  expect(read('review-config.json')).toMatchObject({ models: [], advanced: { failoverMax: 1 }, gates: { 'lite.G0': { rounds: 5 } } })
})

it('SC-045 审核配置没了且重新生成写不进去：规则页报写不进去、dev 用默认规则，点重试成功后恢复；退回的保存本身不新增红字', async () => {
  const c = open()
  c.list()
  // 保存失败、已整体退回：这次保存本身不新增红字
  denyRename('review-config.json')
  expect(caught(() => c.rulesSet({ key: 'selfReview', value: true }))?.code).toBe('write_denied')
  expect(c.rulesGet().exportOk).toBe(true)
  allowRename()
  // 审核配置没了：只打开页面不报；启动对账要重新生成却写不进去才报
  fs.rmSync(file('review-config.json'))
  expect(c.rulesGet().exportOk).toBe(true)
  denyRename('review-config.json')
  c.reconcile()
  expect(c.rulesGet()).toMatchObject({ exportOk: false, exportUsing: 'defaults' })
  // 原有红字照旧：再一次保存失败、已退回，红字不消失
  expect(caught(() => c.rulesSet({ key: 'selfReview', value: true }))?.code).toBe('write_denied')
  expect(c.rulesGet().exportOk).toBe(false)
  expect(c.republish()).toEqual({ exportOk: false })
  expect(c.rulesGet()).toMatchObject({ exportOk: false, exportUsing: 'defaults' })
  allowRename()
  expect(c.republish()).toEqual({ exportOk: true })
  expect(c.rulesGet().exportOk).toBe(true)
  c.stop()
  center = null
  openIpc()
  fs.rmSync(file('review-config.json'))
  denyRename('review-config.json')
  expect(await call('models:configRepublish')).toEqual({ success: true, data: { exportOk: false }, error: null })
  allowRename()
  expect(await call('models:configRepublish')).toEqual({ success: true, data: { exportOk: true }, error: null })
  const rules = await call('models:rulesGet')
  expect(rules.success).toBe(true)
  expect(rules.data).toMatchObject({ exportOk: true, changed: false, defaultsVersion: defaults.DEFAULTS_VERSION })
  expect(Object.keys(rules.data.dev).sort()).toEqual(['claude', 'codex'])
})

it('SC-050 还留着上一份有效审核配置但更新不了：规则页报写不进去、dev 还在用上一份，配置字节不变', () => {
  const c = open()
  c.list()
  c.rulesSet({ key: 'selfReview', value: true })
  const before = bytes('review-config.json')
  denyRename('review-config.json')
  // 模型接入里测不通（来源变了），后台重新生成写不进去
  store.writeStatus('deepseek', 'deepseek-flash', { ok: false, source: 'test' })
  c.refreshQuietly()
  expect(c.rulesGet()).toMatchObject({ exportOk: false, exportUsing: 'previous' })
  expect(bytes('review-config.json').equals(before)).toBe(true)
  expect(read('review-config.json').selfReview).toBe(true)
  allowRename()
  expect(c.republish()).toEqual({ exportOk: true })
  expect(c.rulesGet().exportOk).toBe(true)
  expect(configIds()).toEqual([])
})
