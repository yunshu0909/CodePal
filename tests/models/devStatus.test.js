/** @vitest-environment node
 * v2.1.17 · dev 插件两端分开显示（后-09、§7.4）
 * Claude Code 端：~/.claude/skills/dev-workflow/.claude-plugin/plugin.json 的 version
 * Codex 端：~/.codex/config.toml 里开着的 dev-workflow@<来源> → 本地来源的插件 version，并在插件缓存里核对这一版存在
 * 已生效 = 版本 ≥ 最低版本；版本未知不算支持
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { makeSandbox, KEY } from './helpers'

const require = createRequire(import.meta.url)
// 新模块用 import() 载入：写实现前先失败于 Failed to resolve import
const { readDevStatus, compareVersions } = await import('../../electron/modules/models/devStatus.js')
const defaults = await import('../../electron/modules/models/reviewDefaults.js')
const { createReviewCenter } = await import('../../electron/modules/models/reviewCenter.js')
const store = require('../../electron/modules/models/store.js')

let sb
beforeEach(() => {
  sb = makeSandbox()
  for (const [k, v] of Object.entries(sb.env)) vi.stubEnv(k, v)
})
afterEach(() => {
  vi.unstubAllEnvs()
  sb.cleanup()
})

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}
function claudeEnd(version) {
  const file = path.join(sb.home, '.claude/skills/dev-workflow/.claude-plugin/plugin.json')
  write(file, version === null ? '{broken' : JSON.stringify(version === undefined ? { name: 'dev-workflow' } : { name: 'dev-workflow', version }))
}
function codexEnd(version, { market = 'mkt-a', enabled = true, extraEnabled = false, cache = true, source = true } = {}) {
  const sourceDir = path.join(sb.root, 'markets', market)
  let toml = 'model = "gpt-6.1-sol"\n\n'
  toml += `[plugins."dev-workflow@${market}"]\nenabled = ${enabled}\n\n`
  if (extraEnabled) toml += `[plugins."dev-workflow@mkt-b"]\nenabled = true\n\n`
  toml += `[marketplaces.${market}]\nsource_type = "local"\nsource = "${sourceDir}"\n`
  write(path.join(sb.home, '.codex/config.toml'), toml)
  if (source) write(path.join(sourceDir, 'plugins/dev-workflow/.codex-plugin/plugin.json'), JSON.stringify({ name: 'dev-workflow', version }))
  if (cache) fs.mkdirSync(path.join(sb.home, '.codex/plugins/cache', market, 'dev-workflow', version), { recursive: true })
}
const min = defaults.MIN_DEV_WORKFLOW
const newer = () => {
  const parts = min.split('.').map(Number)
  parts[2] += 1
  return parts.join('.')
}

it('SC-040 两端版本都不低于最低版本：两端都已生效；最低版本只有一个来源，审核配置与比较用同一个常量', () => {
  claudeEnd(min)
  codexEnd(newer())
  expect(readDevStatus({ homeDir: sb.home, minVersion: min })).toEqual({ claude: 'ok', codex: 'ok' })
  expect(typeof min).toBe('string')
  expect(min).toMatch(/^\d+\.\d+\.\d+$/)
  store.setKey('deepseek', KEY)
  store.writeStatus('deepseek', 'deepseek-flash', { ok: true, source: 'test' })
  const center = createReviewCenter({ homeDir: sb.home, env: sb.env, locateClaude: () => null, locateCodex: () => null })
  center.reconcile()
  center.list()
  expect(center.rulesGet().dev).toEqual({ claude: 'ok', codex: 'ok' })
  const config = JSON.parse(fs.readFileSync(path.join(sb.models, 'review-config.json'), 'utf8'))
  expect(config.minDevWorkflow).toBe(defaults.MIN_DEV_WORKFLOW)
  center.stop()
})

it('SC-041 两端都没装：两端都是没装', () => {
  expect(readDevStatus({ homeDir: sb.home, minVersion: min })).toEqual({ claude: 'none', codex: 'none' })
  // Codex 设置里 dev-workflow 关着也算没装
  codexEnd(min, { enabled: false })
  expect(readDevStatus({ homeDir: sb.home, minVersion: min }).codex).toBe('none')
})

it('SC-042 读不出版本：两端各自显示版本未知，另一端照常；版本未知不算支持', () => {
  claudeEnd(null)
  codexEnd(min)
  expect(readDevStatus({ homeDir: sb.home, minVersion: min })).toEqual({ claude: 'unknown', codex: 'ok' })
  claudeEnd(undefined)
  expect(readDevStatus({ homeDir: sb.home, minVersion: min }).claude).toBe('unknown')
  claudeEnd(min)
  // 两个来源都开着：判断不了用的是哪一个
  codexEnd(min, { extraEnabled: true })
  expect(readDevStatus({ homeDir: sb.home, minVersion: min })).toEqual({ claude: 'ok', codex: 'unknown' })
  // 来源里的版本在缓存里找不到
  fs.rmSync(path.join(sb.home, '.codex'), { recursive: true, force: true })
  codexEnd(min, { cache: false })
  expect(readDevStatus({ homeDir: sb.home, minVersion: min }).codex).toBe('unknown')
  // 来源里没有插件版本文件
  fs.rmSync(path.join(sb.home, '.codex'), { recursive: true, force: true })
  codexEnd(min, { source: false, market: 'mkt-c' })
  expect(readDevStatus({ homeDir: sb.home, minVersion: min }).codex).toBe('unknown')
})

it('SC-043 版本太旧：两端各自显示太旧；版本按数字逐段比较', () => {
  claudeEnd('0.12.10')
  codexEnd('0.12.10')
  expect(compareVersions('0.12.10', min)).toBeLessThan(0)
  expect(readDevStatus({ homeDir: sb.home, minVersion: min })).toEqual({ claude: 'old', codex: 'old' })
  expect(compareVersions('0.12.13', '0.12.9')).toBeGreaterThan(0)
  expect(compareVersions('0.13.0', '0.12.13')).toBeGreaterThan(0)
  expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
  claudeEnd(newer())
  expect(readDevStatus({ homeDir: sb.home, minVersion: min })).toEqual({ claude: 'ok', codex: 'old' })
})
