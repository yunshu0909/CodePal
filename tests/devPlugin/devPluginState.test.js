/** @vitest-environment node
 * v2.1.25 · 插件管理：读两边的安装与开关（主进程）
 * 每条用例在临时目录里造 home：Claude 插件目录、~/.claude/settings.json、~/.codex/config.toml、Codex 本地插件来源、
 * 系统管理设置文件；不读写本机真实配置。新模块用 import() 载入，写实现前先失败于 Failed to resolve import。
 */
import { afterEach, beforeEach, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { readDevPluginState } = await import('../../electron/modules/devPlugin/state.js')

let root
let home
let managed
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'codepal-devplugin-'))
  home = path.join(root, 'home')
  managed = path.join(root, 'managed-settings.json')
  fs.mkdirSync(home, { recursive: true })
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}
const claudeDir = () => path.join(home, '.claude/skills/dev-workflow')
const settingsFile = () => path.join(home, '.claude/settings.json')
const configFile = () => path.join(home, '.codex/config.toml')

/** Claude 那边装上插件；manifest 传 null 表示没有 version 字段 */
function claudePlugin(version = '0.12.22') {
  write(path.join(claudeDir(), '.claude-plugin/plugin.json'), JSON.stringify(version === null ? { name: 'dev-workflow' } : { name: 'dev-workflow', version }))
}
/** Codex 那边：本地来源目录里放插件包，config.toml 里登记插件节 */
function codexPlugin({ version = '0.12.22', enabled = 'true', market = 'local-dev', extraSection = false, source = true } = {}) {
  const sourceDir = path.join(root, 'markets', market)
  if (source) write(path.join(sourceDir, 'plugins/dev-workflow/.codex-plugin/plugin.json'), JSON.stringify({ name: 'dev-workflow', version }))
  let toml = '# 我自己的注释\nmodel = "gpt-6.1-sol"\n\n'
  toml += `[plugins."dev-workflow@${market}"]\n${enabled === null ? '' : `enabled = ${enabled}\n`}\n`
  if (extraSection) toml += '[plugins."dev-workflow@other"]\nenabled = true\n\n'
  toml += `[marketplaces.${market}]\nsource_type = "local"\nsource = "${sourceDir}"\n`
  write(configFile(), toml)
}
const read = (env = {}) => readDevPluginState({ homeDir: home, env, managedPaths: [managed] })

it('TC-101 两边都装了、Claude 没写这一项、Codex 开着：版本 0.12.22，两行都开（后-02-例1、后-03-例1、后-20-例1、后-01-例1、后-19-例1）', async () => {
  claudePlugin()
  write(settingsFile(), JSON.stringify({ permissions: { allow: [] } }))
  codexPlugin()
  const result = await read()
  expect(result.ok).toBe(true)
  expect(result.data.versionText).toBe('0.12.22')
  expect(result.data.claude).toMatchObject({ installed: true, enabled: true, locked: false })
  expect(result.data.codex).toMatchObject({ installed: true, enabled: true, locked: false })
})

it('TC-101 settings.json 写 false 显示关；Codex enabled = false 显示关（后-02-例2、后-03-例2）', async () => {
  claudePlugin()
  write(settingsFile(), JSON.stringify({ enabledPlugins: { 'dev-workflow@skills-dir': false } }))
  codexPlugin({ enabled: 'false' })
  const { data } = await read()
  expect(data.claude.enabled).toBe(false)
  expect(data.codex.enabled).toBe(false)
})

it('TC-101 settings.json 不存在按没写处理（开）；项目自己的 .claude/settings.json 不读（后-18-例1、后-18-例2）', async () => {
  claudePlugin()
  codexPlugin()
  write(path.join(root, 'projectA/.claude/settings.json'), JSON.stringify({ enabledPlugins: { 'dev-workflow@skills-dir': false } }))
  const { data } = await read()
  expect(data.claude.enabled).toBe(true)
})

it('TC-101 版本取 Claude 那边，Claude 没装取 Codex 包，两边不同仍只显示 Claude 的（后-01-例2、后-19-例2）', async () => {
  codexPlugin({ version: '0.12.20' })
  expect((await read()).data.versionText).toBe('0.12.20')
  claudePlugin('0.12.22')
  expect((await read()).data.versionText).toBe('0.12.22')
})

it('TC-103 连续读取 100 次不写任何文件（后-07-例1、后-06-例1）', async () => {
  claudePlugin()
  write(settingsFile(), JSON.stringify({ model: 'opus' }, null, 2))
  codexPlugin()
  const before = [settingsFile(), configFile()].map((f) => [fs.readFileSync(f), fs.statSync(f).mtimeMs])
  for (let i = 0; i < 100; i += 1) await read()
  const after = [settingsFile(), configFile()].map((f) => [fs.readFileSync(f), fs.statSync(f).mtimeMs])
  expect(after).toEqual(before)
})

it('TC-104 格式坏、类型不对、多个插件节、配置不在默认位置：整页读取失败并写明原因（后-02-例4、后-03-例4、后-06-例2、后-15-例1、后-16-例1、后-17-例1）', async () => {
  claudePlugin()
  codexPlugin()
  write(settingsFile(), '{"enabledPlugins": {')
  let r = await read()
  expect(r.ok).toBe(false)
  expect(r.error.message).toContain('~/.claude/settings.json')

  write(settingsFile(), JSON.stringify({ enabledPlugins: null }))
  r = await read()
  expect(r.ok).toBe(false)
  expect(r.error.message).toContain('enabledPlugins')

  write(settingsFile(), JSON.stringify({ enabledPlugins: { 'dev-workflow@skills-dir': 'off' } }))
  expect((await read()).ok).toBe(false)

  write(settingsFile(), '{}')
  codexPlugin({ enabled: '"yes"' })
  r = await read()
  expect(r.ok).toBe(false)
  expect(r.error.message).toContain('enabled')

  codexPlugin({ extraSection: true })
  r = await read()
  expect(r.ok).toBe(false)
  expect(r.error.message).toContain('Codex 配置里有 2 个 dev-workflow 插件节')

  codexPlugin()
  r = await read({ CLAUDE_CONFIG_DIR: path.join(root, 'elsewhere') })
  expect(r.ok).toBe(false)
  expect(r.error.message).toContain('Claude Code 配置不在默认位置，这一版不支持')

  write(configFile(), '[plugins\n')
  r = await read()
  expect(r.ok).toBe(false)
  expect(r.error.message).toContain('~/.codex/config.toml')
})

it('TC-104 Codex 插件节没写 enabled（默认值未核实）按读取失败；系统管理设置读不出也按读取失败（B-001、B-002）', async () => {
  claudePlugin()
  codexPlugin({ enabled: null })
  expect((await read()).ok).toBe(false)
  codexPlugin()
  write(managed, '{broken')
  const r = await read()
  expect(r.ok).toBe(false)
  expect(r.error.message).toContain('系统管理设置')
})

it('TC-105 没装的判法：删插件目录 / 删插件节 / 两边都没装时版本位写「没装」；manifest 无 version 写「看不出版本」（后-02-例3、后-03-例3、后-26-例1、后-26-例2）', async () => {
  codexPlugin()
  let { data } = await read()
  expect(data.claude.installed).toBe(false)
  write(configFile(), 'model = "x"\n')
  ;({ data } = await read())
  expect(data.codex.installed).toBe(false)
  expect(data.versionText).toBe('没装')
  claudePlugin(null)
  ;({ data } = await read())
  expect(data.versionText).toBe('看不出版本')
  expect(data.claude.installed).toBe(true)
  expect(data.claude.enabled).toBe(true)
})

it('TC-105 config.toml 不存在按没装；装上后重新读不再是没装', async () => {
  claudePlugin()
  let { data } = await read()
  expect(data.codex.installed).toBe(false)
  codexPlugin()
  ;({ data } = await read())
  expect(data.codex.installed).toBe(true)
})

it('TC-110 Codex 插件节在但来源目录找不到：按没装显示（真-03）', async () => {
  claudePlugin()
  codexPlugin({ source: false })
  const { data } = await read()
  expect(data.codex.installed).toBe(false)
})

it('TC-110 系统管理设置写了这一项：按它显示、锁定（后-14-例1）；没有管理设置文件时照常（后-14-例2）', async () => {
  claudePlugin()
  codexPlugin()
  let { data } = await read()
  expect(data.claude.locked).toBe(false)
  write(managed, JSON.stringify({ enabledPlugins: { 'dev-workflow@skills-dir': false } }))
  ;({ data } = await read())
  expect(data.claude).toMatchObject({ enabled: false, locked: true })
  fs.rmSync(managed)
  ;({ data } = await read())
  expect(data.claude.locked).toBe(false)
})
