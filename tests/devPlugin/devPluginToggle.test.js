/** @vitest-environment node
 * v2.1.25 · 插件管理：开关写入（主进程）
 * Claude 那边经现有 Claude 设置唯一写入口写 ~/.claude/settings.json 的 enabledPlugins；Codex 那边经 Codex 配置负责人只改
 * config.toml 里 dev-workflow 插件节的 enabled。全部在临时目录里造，写入口的失败用 deps 注入；新模块用 import() 载入。
 */
import { afterEach, beforeEach, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { readDevPluginState } = await import('../../electron/modules/devPlugin/state.js')
const { createDevPluginToggle } = await import('../../electron/modules/devPlugin/toggle.js')
const { registerDevPluginHandlers } = await import('../../electron/modules/devPlugin/ipc.js')
const claudeSettings = require('../../electron/services/claudeSettingsService.js')

let root
let home
let managed
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'codepal-devtoggle-'))
  home = path.join(root, 'home')
  managed = path.join(root, 'managed-settings.json')
  fs.mkdirSync(home, { recursive: true })
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}
const settingsFile = () => path.join(home, '.claude/settings.json')
const configFile = () => path.join(home, '.codex/config.toml')
function claudePlugin(dir = path.join(home, '.claude/skills/dev-workflow'), name = 'dev-workflow') {
  write(path.join(dir, '.claude-plugin/plugin.json'), JSON.stringify({ name, version: '0.12.22' }))
}
const TOML_HEAD = '# 我自己的注释\nmodel = "gpt-6.1-sol"\n\n[projects."/x"]\ntrust_level = "trusted"\n\n'
function codexPlugin({ enabled = true, market = 'local-dev' } = {}) {
  const sourceDir = path.join(root, 'markets', market)
  write(path.join(sourceDir, 'plugins/dev-workflow/.codex-plugin/plugin.json'), JSON.stringify({ name: 'dev-workflow', version: '0.12.22' }))
  write(configFile(), `${TOML_HEAD}[plugins."dev-workflow@${market}"]\nenabled = ${enabled}\n\n[marketplaces.${market}]\nsource_type = "local"\nsource = "${sourceDir}"\n`)
}
function setup() {
  claudePlugin()
  write(settingsFile(), JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, hooks: { Stop: [] } }, null, 2))
  codexPlugin()
}
const read = async () => (await readDevPluginState({ homeDir: home, env: {}, managedPaths: [managed] })).data
const toggle = (deps = {}) => createDevPluginToggle({ homeDir: home, env: {}, managedPaths: [managed], deps })
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))

it('TC-107 关 Codex：只改插件节 enabled 这一行，其余行与注释字节不变（后-10-例1）', async () => {
  setup()
  const before = fs.readFileSync(configFile(), 'utf8')
  const t = toggle()
  const result = await t.setEnabled({ tool: 'codex', enabled: false, identity: (await read()).identity })
  expect(result).toMatchObject({ ok: true, status: 'saved', enabled: false })
  const after = fs.readFileSync(configFile(), 'utf8')
  expect(after).toBe(before.replace('enabled = true', 'enabled = false'))
  expect((await read()).codex.enabled).toBe(false)
})

it('TC-107 Claude 开关只增改 enabledPlugins 这一项，其他字段内容不变；再开变 true（后-09-例1、后-09-例2）', async () => {
  setup()
  const t = toggle()
  let result = await t.setEnabled({ tool: 'claude', enabled: false, identity: (await read()).identity })
  expect(result).toMatchObject({ ok: true, status: 'saved', enabled: false })
  let data = json(settingsFile())
  expect(data.enabledPlugins).toEqual({ 'dev-workflow@skills-dir': false })
  expect(data.permissions).toEqual({ allow: ['Bash(ls)'] })
  expect(data.hooks).toEqual({ Stop: [] })
  result = await t.setEnabled({ tool: 'claude', enabled: true, identity: (await read()).identity })
  expect(result.ok).toBe(true)
  data = json(settingsFile())
  expect(data.enabledPlugins['dev-workflow@skills-dir']).toBe(true)
})

it('TC-107 和「Claude Code 设置」页的保存经同一写入口排队，互不覆盖（后-05-例1）', async () => {
  setup()
  const t = toggle()
  const identity = (await read()).identity
  const other = claudeSettings.mutateClaudeSettingsFile(({ data }) => ({ ok: true, next: { ...data, permissions: { allow: ['Bash(ls)', 'Read'] } } }), { filePath: settingsFile(), managedPaths: [managed] })
  const mine = t.setEnabled({ tool: 'claude', enabled: false, identity })
  await Promise.all([other, mine])
  const data = json(settingsFile())
  expect(data.permissions.allow).toEqual(['Bash(ls)', 'Read'])
  expect(data.enabledPlugins['dev-workflow@skills-dir']).toBe(false)
})

it('TC-107 文件已是目标值：直接成功、不写文件（后-24-例2）；页面传来的多余 path 字段被忽略（后-04-例1）', async () => {
  setup()
  const identity = (await read()).identity
  codexPlugin({ enabled: false })
  const mtime = fs.statSync(configFile()).mtimeMs
  const bytes = fs.readFileSync(configFile())
  const result = await toggle().setEnabled({ tool: 'codex', enabled: false, identity })
  expect(result).toMatchObject({ ok: true, status: 'saved', enabled: false })
  expect(fs.statSync(configFile()).mtimeMs).toBe(mtime)
  expect(fs.readFileSync(configFile())).toEqual(bytes)

  codexPlugin({ enabled: true })
  const handlers = {}
  registerDevPluginHandlers({ ipcMain: { handle: (ch, fn) => { handlers[ch] = fn } }, homeDir: home, env: {}, managedPaths: [managed] })
  const victim = path.join(root, 'victim.txt')
  write(victim, 'keep')
  await handlers['devPlugin:read']()
  const reply = await handlers['devPlugin:setEnabled'](null, { tool: 'codex', enabled: false, path: victim })
  expect(reply.success).toBe(true)
  expect(fs.readFileSync(victim, 'utf8')).toBe('keep')
  expect(fs.readFileSync(configFile(), 'utf8')).toContain('enabled = false')
  const bad = await handlers['devPlugin:setEnabled'](null, { tool: 'nope', enabled: false })
  expect(bad.success).toBe(false)
})

it('TC-107 关了以后回退代码不迁移数据：值仍是 false，再打开可改回（后-22-例1）', async () => {
  setup()
  const t = toggle()
  await t.setEnabled({ tool: 'codex', enabled: false, identity: (await read()).identity })
  expect(fs.readFileSync(configFile(), 'utf8')).toContain('enabled = false')
  await t.setEnabled({ tool: 'codex', enabled: true, identity: (await read()).identity })
  expect(fs.readFileSync(configFile(), 'utf8')).toContain('enabled = true')
})

it('TC-109 config.toml 只读：文件字节不变，报「没改成：~/.codex/config.toml 写不进去」（后-13-例1）', async () => {
  setup()
  const identity = (await read()).identity
  fs.chmodSync(configFile(), 0o444)
  const bytes = fs.readFileSync(configFile())
  const result = await toggle().setEnabled({ tool: 'codex', enabled: false, identity })
  expect(result).toMatchObject({ ok: false, status: 'failed', message: '没改成：~/.codex/config.toml 写不进去' })
  expect(fs.readFileSync(configFile())).toEqual(bytes)
})

it('TC-109 备份写不进 / 改名失败：不改原文件，报没改成（后-13-例2、真-04）', async () => {
  setup()
  const identity = (await read()).identity
  const claudeBytes = fs.readFileSync(settingsFile())
  const stub = toggle({ mutateClaudeSettingsFile: async () => ({ success: false, committed: false, errorCode: 'BACKUP_FAILED', error: 'backup failed' }) })
  let result = await stub.setEnabled({ tool: 'claude', enabled: false, identity })
  expect(result).toMatchObject({ ok: false, status: 'failed', message: '没改成：~/.claude/settings.json 写不进去' })
  expect(fs.readFileSync(settingsFile())).toEqual(claudeBytes)

  const codexBytes = fs.readFileSync(configFile())
  const failing = toggle({ codexCommitDeps: { renameFn: async () => { throw Object.assign(new Error('rename'), { code: 'EIO' }) } } })
  result = await failing.setEnabled({ tool: 'codex', enabled: false, identity })
  expect(result).toMatchObject({ ok: false, status: 'failed' })
  expect(fs.readFileSync(configFile())).toEqual(codexBytes)
})

it('TC-109 读取之后、提交之前外部改了同一文件的别的配置：不写，外部改的内容保留', async () => {
  setup()
  const identity = (await read()).identity
  const external = `${TOML_HEAD.replace('gpt-6.1-sol', 'gpt-external')}`
  let result = await toggle({ codexCommitDeps: { beforeConfigRename: async () => {
    const text = fs.readFileSync(configFile(), 'utf8').replace('gpt-6.1-sol', 'gpt-external')
    fs.writeFileSync(configFile(), text)
  } } }).setEnabled({ tool: 'codex', enabled: false, identity })
  expect(result.ok).toBe(false)
  const text = fs.readFileSync(configFile(), 'utf8')
  expect(text).toContain('gpt-external')
  expect(text).toContain('enabled = true')
  expect(external).toContain('gpt-external')

  result = await toggle({ onClaudeMutate: () => {
    fs.writeFileSync(settingsFile(), JSON.stringify({ model: 'external' }))
  } }).setEnabled({ tool: 'claude', enabled: false, identity })
  expect(result.ok).toBe(false)
  expect(json(settingsFile())).toEqual({ model: 'external' })
})

it('TC-109 写前复验：插件节被删 / 插件目录改指别处 / manifest name 不对时不写并报别处改过（后-24-例1、后-24-例3、后-24-例4）', async () => {
  setup()
  let identity = (await read()).identity
  const sourceDir = path.join(root, 'markets', 'local-dev')
  write(configFile(), `${TOML_HEAD}[marketplaces.local-dev]\nsource_type = "local"\nsource = "${sourceDir}"\n`)
  const bytes = fs.readFileSync(configFile())
  let result = await toggle().setEnabled({ tool: 'codex', enabled: false, identity })
  expect(result).toMatchObject({ ok: false, status: 'changed', message: '插件状态刚被别处改过，已重新读取' })
  expect(fs.readFileSync(configFile())).toEqual(bytes)

  // Claude 插件目录是指向某个版本目录的链接：读取后换指另一处（同名插件）
  fs.rmSync(path.join(home, '.claude/skills/dev-workflow'), { recursive: true })
  const dirA = path.join(root, 'plugins-local/a')
  const dirB = path.join(root, 'plugins-local/b')
  claudePlugin(dirA)
  claudePlugin(dirB)
  fs.symlinkSync(dirA, path.join(home, '.claude/skills/dev-workflow'))
  identity = (await read()).identity
  fs.unlinkSync(path.join(home, '.claude/skills/dev-workflow'))
  fs.symlinkSync(dirB, path.join(home, '.claude/skills/dev-workflow'))
  const settingsBytes = fs.readFileSync(settingsFile())
  result = await toggle().setEnabled({ tool: 'claude', enabled: false, identity })
  expect(result.status).toBe('changed')
  expect(fs.readFileSync(settingsFile())).toEqual(settingsBytes)

  identity = (await read()).identity
  claudePlugin(dirB, 'other-plugin')
  result = await toggle().setEnabled({ tool: 'claude', enabled: false, identity })
  expect(result.status).toBe('changed')
})

it('TC-109 系统管理设置读不出时 Claude 一行不写（B-002）', async () => {
  setup()
  const identity = (await read()).identity
  write(managed, '{broken')
  const bytes = fs.readFileSync(settingsFile())
  const result = await toggle().setEnabled({ tool: 'claude', enabled: false, identity })
  expect(result.ok).toBe(false)
  expect(fs.readFileSync(settingsFile())).toEqual(bytes)
})

it('TC-110 写时才发现系统管理设置锁定：不写，报「没改成：这一项被系统管理设置锁定」（后-14-例1）', async () => {
  setup()
  const identity = (await read()).identity
  write(managed, JSON.stringify({ enabledPlugins: { 'dev-workflow@skills-dir': true } }))
  const bytes = fs.readFileSync(settingsFile())
  const result = await toggle().setEnabled({ tool: 'claude', enabled: false, identity })
  expect(result).toMatchObject({ ok: false, status: 'locked', message: '没改成：这一项被系统管理设置锁定' })
  expect(fs.readFileSync(settingsFile())).toEqual(bytes)
})

it('TC-111 保存中再点同一边：只写一次；保存中可查到在途（后-11-例1、后-25-例1）', async () => {
  setup()
  const identity = (await read()).identity
  let commits = 0
  let release
  const gate = new Promise((r) => { release = r })
  const t = toggle({ codexCommitDeps: { beforeConfigCommit: async () => { await gate }, afterConfigCommit: async () => { commits += 1 } } })
  const first = t.setEnabled({ tool: 'codex', enabled: false, identity })
  const second = t.setEnabled({ tool: 'codex', enabled: false, identity })
  expect(t.saving()).toEqual({ claude: false, codex: true })
  release()
  const [a, b] = await Promise.all([first, second])
  expect(a.ok && b.ok).toBe(true)
  expect(commits).toBe(1)
  expect(t.saving()).toEqual({ claude: false, codex: false })
})

it('TC-112 关了再点一次：按同样过程打开', async () => {
  setup()
  const t = toggle()
  await t.setEnabled({ tool: 'codex', enabled: false, identity: (await read()).identity })
  const result = await t.setEnabled({ tool: 'codex', enabled: true, identity: (await read()).identity })
  expect(result).toMatchObject({ ok: true, status: 'saved', enabled: true })
  expect((await read()).codex.enabled).toBe(true)
})

it('TC-113 改名后回读对不上 / 读不出：报「保存结果没确认」，不撤回别人的内容、不自动重写（后-25-例2、后-25-例3）', async () => {
  setup()
  const identity = (await read()).identity
  let commits = 0
  const result = await toggle({ codexCommitDeps: { afterConfigCommit: async () => {
    commits += 1
    fs.writeFileSync(configFile(), fs.readFileSync(configFile(), 'utf8').replace('enabled = false', 'enabled = true').replace('gpt-6.1-sol', 'gpt-later'))
  } } }).setEnabled({ tool: 'codex', enabled: false, identity })
  expect(result).toMatchObject({ ok: false, status: 'uncertain', message: '保存结果没确认：~/.codex/config.toml，重新打开这页看实际状态' })
  expect(commits).toBe(1)
  expect(fs.readFileSync(configFile(), 'utf8')).toContain('gpt-later')

  setup()
  const unreadable = await toggle({ readFile: async () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }) } })
    .setEnabled({ tool: 'codex', enabled: false, identity: (await read()).identity })
  expect(unreadable.status).toBe('uncertain')

  const claude = await toggle({ mutateClaudeSettingsFile: async () => ({ success: false, committed: true, errorCode: 'SETTINGS_READBACK_MISMATCH', error: 'mismatch' }) })
    .setEnabled({ tool: 'claude', enabled: false, identity: (await read()).identity })
  expect(claude).toMatchObject({ ok: false, status: 'uncertain', message: '保存结果没确认：~/.claude/settings.json，重新打开这页看实际状态' })
})

it('TC-113 回读一致时不出现没确认（真-08 消失）', async () => {
  setup()
  const result = await toggle().setEnabled({ tool: 'codex', enabled: false, identity: (await read()).identity })
  expect(result.status).toBe('saved')
  expect(result.message ?? '').not.toContain('没确认')
})
