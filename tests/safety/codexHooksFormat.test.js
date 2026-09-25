/**
 * Codex 配置写入的格式保真 — 行为测试（v2.0.0 发版前 subagent 配置安全测试发现）
 *
 * 负责：
 * - 装 / 卸会话状态钩子不改用户其余内容：多行字符串里的空行、表之间的空行都原样
 * - CRLF 文件写回后仍全是 CRLF，第二次启动不再改动
 * - 注释里提到 [features] 不会把 hooks = true 写进别的表
 * - 带 BOM 的 config.toml 也能做一次性 MCP 清理，BOM 保留
 * - 只读的 config.toml 不被改写，失败如实上报
 *
 * 所有文件都在 mkdtemp 的临时 HOME 里。
 *
 * @module tests/safety/codexHooksFormat.test
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile, chmod } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { parse } = require('smol-toml')
const { runLegacyProviderRegistryCleanup } = require('../../electron/services/legacyMcpCleanup')

const originalHome = process.env.HOME
const noTrust = async () => ({ trusted: 0, alreadyTrusted: 0 })
function loadSessionStatus(home) {
  process.env.HOME = home
  for (const id of Object.keys(require.cache)) {
    if (/electron[\\/]services[\\/](sessionStatusService|claudeSettingsService)\.js$/.test(id)) delete require.cache[id]
  }
  return require('../../electron/services/sessionStatusService')
}
afterEach(() => {
  process.env.HOME = originalHome
  for (const id of Object.keys(require.cache)) {
    if (/electron[\\/]services[\\/](sessionStatusService|claudeSettingsService)\.js$/.test(id)) delete require.cache[id]
  }
})

async function codexHome(config) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'codepal-hookfmt-'))
  await mkdir(path.join(home, '.codex'), { recursive: true })
  const file = path.join(home, '.codex', 'config.toml')
  await writeFile(file, config)
  return { home, file }
}

const USER_CONFIG = 'model = "gpt-5"\ndeveloper_instructions = """\nA\n\n\n\nB\n"""\n\n\n\n[tui]\ntheme = "dark"\n'

describe('会话状态钩子不改用户其余内容', () => {
  it('H-1 多行字符串里的空行、表之间的空行都原样保留', async () => {
    const { home, file } = await codexHome(USER_CONFIG)
    await loadSessionStatus(home).installSessionStatus({ trustHooks: noTrust })
    const after = await readFile(file, 'utf8')
    expect(after.startsWith('model = "gpt-5"\ndeveloper_instructions = """\nA\n\n\n\nB\n"""\n\n\n\n[tui]\ntheme = "dark"\n')).toBe(true)
    expect(parse(after).developer_instructions).toBe('A\n\n\n\nB\n')
    expect(parse(after).features.hooks).toBe(true)
  })

  it('H-2 卸载只删我们的钩子，多行字符串不变', async () => {
    const { home, file } = await codexHome(USER_CONFIG)
    const svc = loadSessionStatus(home)
    await svc.installSessionStatus({ trustHooks: noTrust })
    await svc.uninstallSessionStatus()
    const after = await readFile(file, 'utf8')
    expect(parse(after).developer_instructions).toBe('A\n\n\n\nB\n')
    expect(after).not.toMatch(/codex-hook\.sh/)
  })

  it('H-3 CRLF 文件写回后仍全是 CRLF；再装一次不改动', async () => {
    const { home, file } = await codexHome(USER_CONFIG.replace(/\n/g, '\r\n'))
    const svc = loadSessionStatus(home)
    await svc.installSessionStatus({ trustHooks: noTrust })
    const once = await readFile(file, 'utf8')
    expect(once).toMatch(/codex-hook\.sh/)
    expect(once.replace(/\r\n/g, '')).not.toMatch(/\n/)
    await svc.installSessionStatus({ trustHooks: noTrust })
    expect(await readFile(file, 'utf8')).toBe(once)
  })

  it('H-4 注释里提到 [features] 时，hooks = true 仍写进真正的 [features] 表', async () => {
    const { home, file } = await codexHome('[tui]\n# 想开钩子要去 [features] 里加 hooks = true\ntheme = "dark"\n')
    await loadSessionStatus(home).installSessionStatus({ trustHooks: noTrust })
    const doc = parse(await readFile(file, 'utf8'))
    expect(doc.features?.hooks).toBe(true)
    expect(doc.tui.hooks).toBeUndefined()
  })
})

describe('[features] 按 TOML 语义定位（Codex 审核反例）', () => {
  it('H-7 文件开头有 BOM 且第一行就是 [features]：改这张表，不追加第二个', async () => {
    const { home, file } = await codexHome('\uFEFF[features]\nhooks = false\n')
    const result = await loadSessionStatus(home).installSessionStatus({ trustHooks: noTrust })
    expect(result.failures).toEqual([])
    const after = await readFile(file, 'utf8')
    expect(after.startsWith('\uFEFF[features]\nhooks = true\n')).toBe(true)
    expect(after.match(/^\uFEFF?\[features\]/gm)).toHaveLength(1)
  })

  it('H-8 多行字符串里写着 [features] 示例：字符串原样，真正的 features.hooks 设上', async () => {
    const instructions = 'Example config:\n[features]\n  hooks = false\n'
    const { home, file } = await codexHome(`developer_instructions = """\n${instructions}"""\n`)
    const result = await loadSessionStatus(home).installSessionStatus({ trustHooks: noTrust })
    expect(result.failures).toEqual([])
    const doc = parse(await readFile(file, 'utf8'))
    expect(doc.developer_instructions).toBe(instructions)
    expect(doc.features.hooks).toBe(true)
  })
})

describe('写入前整体语义校验（Codex 审核反例）', () => {
  it('H-9 用户字符串里恰好有「# CodePal session status hooks」这一行：拒绝写入，原文不动', async () => {
    const config = 'developer_instructions = """\nKeep this example verbatim:\n# CodePal session status hooks\nEND\n"""\n["features"]\nhooks = false\n'
    const { home, file } = await codexHome(config)
    const result = await loadSessionStatus(home).installSessionStatus({ trustHooks: noTrust })
    expect(await readFile(file, 'utf8')).toBe(config)
    expect(result.failures.map((f) => f.tool)).toContain('codex')
  })
})

describe('一次性 MCP 清理与只读文件', () => {
  it('H-5 带 BOM 的 config.toml 也能清掉 provider_registry，BOM 保留', async () => {
    const script = '/Apps/CodePal.app/Contents/Resources/app/mcp/provider_registry_mcp.js'
    const { home, file } = await codexHome(`\uFEFFmodel = "gpt-5"\n\n[mcp_servers.provider_registry]\ncommand = "node"\nargs = ["${script}"]\n\n[mcp_servers.other]\ncommand = "keep"\n`)
    const data = new Map()
    const store = { get: (k) => data.get(k), set: (k, v) => data.set(k, v) }
    const result = await runLegacyProviderRegistryCleanup({ homeDir: home, store })
    expect(result.codex).toBe('removed')
    expect(await readFile(file, 'utf8')).toBe('\uFEFFmodel = "gpt-5"\n\n[mcp_servers.other]\ncommand = "keep"\n')
  })

  it.skipIf(process.getuid?.() === 0)('H-6 只读的 config.toml 不被改写，Codex 失败如实上报', async () => {
    const { home, file } = await codexHome(USER_CONFIG)
    await chmod(file, 0o444)
    const result = await loadSessionStatus(home).installSessionStatus({ trustHooks: noTrust })
    expect(await readFile(file, 'utf8')).toBe(USER_CONFIG)
    expect(result.failures.map((f) => f.tool)).toContain('codex')
  })
})
