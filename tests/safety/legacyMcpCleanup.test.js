/**
 * 隐藏 MCP 下线：一次性清理已写入的 provider_registry — 行为测试（架构优化 B2-1）
 *
 * 负责：
 * - 只移除确认属于 CodePal 的条目（args 指向 …/mcp/provider_registry_mcp.js），其余字节不变
 * - ~/.claude.json 只有能无损重写时才改；冲突 / 出错不动、下次再试；成功后只跑一次；改前留备份
 * - MCP 代码移出打包范围，主进程启动时调用清理
 *
 * 所有写入只发生在 mkdtemp 创建的临时 HOME。
 *
 * @module tests/safety/legacyMcpCleanup.test
 */

import fs from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { runLegacyProviderRegistryCleanup } = require('../../electron/services/legacyMcpCleanup')

const SCRIPT = '/Apps/CodePal.app/Contents/Resources/app/mcp/provider_registry_mcp.js'
let sandbox
let homeDir
let store

const tomlPath = () => path.join(homeDir, '.codex', 'config.toml')
const jsonPath = () => path.join(homeDir, '.claude.json')

function memoryStore() {
  const data = new Map()
  return { get: (k) => data.get(k), set: (k, v) => data.set(k, v) }
}

const OWNED_TOML = `# user note
model = "x"

[mcp_servers.other]
command = "keep"

[mcp_servers.provider_registry]
command = "node"
args = [
  "${SCRIPT}"
]

  [mcp_servers.provider_registry.env]
  SKILL_MANAGER_PROVIDER_REGISTRY_PATH = "/x/.provider-manifests.json"

[features]
hooks = true
`
const EXPECTED_TOML = `# user note
model = "x"

[mcp_servers.other]
command = "keep"

[features]
hooks = true
`
const ownedJson = () => JSON.stringify({ numStartups: 3, mcpServers: { other: { command: 'keep' }, provider_registry: { command: 'node', args: [SCRIPT], env: { A: '1' } } }, projects: {} }, null, 2)
const expectedJson = () => JSON.stringify({ numStartups: 3, mcpServers: { other: { command: 'keep' } }, projects: {} }, null, 2)

async function write(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text)
}

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'codepal-mcp-cleanup-'))
  homeDir = path.join(sandbox, 'home')
  store = memoryStore()
})

afterEach(async () => {
  await fs.rm(sandbox, { recursive: true, force: true })
})

describe('B2-1 清理已写入的 provider_registry', () => {
  it('L-1 两处属于 CodePal 的条目被移除（含 env 子表），其余字节不变，并留备份', async () => {
    await write(tomlPath(), OWNED_TOML)
    await write(jsonPath(), ownedJson())
    const result = await runLegacyProviderRegistryCleanup({ homeDir, store })
    expect(result).toMatchObject({ codex: 'removed', claude: 'removed', done: true })
    expect(await fs.readFile(tomlPath(), 'utf8')).toBe(EXPECTED_TOML)
    expect(await fs.readFile(jsonPath(), 'utf8')).toBe(expectedJson())
    expect(await fs.readFile(`${tomlPath()}.codepal.bak`, 'utf8')).toBe(OWNED_TOML)
    expect(await fs.readFile(`${jsonPath()}.codepal.bak`, 'utf8')).toBe(ownedJson())
  })

  it('L-2 同名但不属于 CodePal（args 指向别处）→ 不动', async () => {
    const toml = OWNED_TOML.replace(SCRIPT, '/elsewhere/server.js')
    const json = ownedJson().replace(SCRIPT, '/elsewhere/server.js')
    await write(tomlPath(), toml)
    await write(jsonPath(), json)
    const result = await runLegacyProviderRegistryCleanup({ homeDir, store })
    expect(result).toMatchObject({ codex: 'not-owned', claude: 'not-owned', done: true })
    expect(await fs.readFile(tomlPath(), 'utf8')).toBe(toml)
    expect(await fs.readFile(jsonPath(), 'utf8')).toBe(json)
  })

  it('L-3 没有条目 / 文件不存在 → 不写，标记完成', async () => {
    await write(tomlPath(), EXPECTED_TOML)
    const before = await fs.stat(tomlPath())
    const result = await runLegacyProviderRegistryCleanup({ homeDir, store })
    expect(result).toMatchObject({ codex: 'absent', claude: 'absent', done: true })
    expect((await fs.stat(tomlPath())).mtimeMs).toBe(before.mtimeMs)
  })

  it('L-4 ~/.claude.json 无法无损重写（4 空格缩进）→ 跳过不动，下次再试', async () => {
    const json = JSON.stringify(JSON.parse(ownedJson()), null, 4)
    await write(jsonPath(), json)
    const result = await runLegacyProviderRegistryCleanup({ homeDir, store })
    expect(result).toMatchObject({ claude: 'skipped-format', done: false })
    expect(await fs.readFile(jsonPath(), 'utf8')).toBe(json)
  })

  it('L-5 提交前被外部改动 → 不动，下次再试', async () => {
    await write(jsonPath(), ownedJson())
    const external = ownedJson().replace('"numStartups": 3', '"numStartups": 4')
    const result = await runLegacyProviderRegistryCleanup({ homeDir, store }, {
      beforeClaudeJsonCommit: () => fs.writeFile(jsonPath(), external),
      maxAttempts: 1,
    })
    expect(result).toMatchObject({ claude: 'conflict', done: false })
    expect(await fs.readFile(jsonPath(), 'utf8')).toBe(external)
  })

  it('L-6 完成后只跑一次', async () => {
    await write(tomlPath(), OWNED_TOML)
    await runLegacyProviderRegistryCleanup({ homeDir, store })
    await write(tomlPath(), OWNED_TOML)
    const second = await runLegacyProviderRegistryCleanup({ homeDir, store })
    expect(second).toMatchObject({ skipped: 'already-done' })
    expect(await fs.readFile(tomlPath(), 'utf8')).toBe(OWNED_TOML)
  })
})

describe('B2-1 MCP 代码下线', () => {
  const root = path.resolve(__dirname, '..', '..')
  it('M-1 MCP 代码不在打包范围，搬进 _disabled/mcp-manager 并有恢复说明', () => {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf-8'))
    expect(pkg.build.files).not.toContain('mcp/**/*')
    expect(Object.keys(pkg.scripts).filter((k) => k.startsWith('mcp:'))).toEqual([])
    for (const gone of ['mcp', 'scripts/mcp', 'src/pages/McpPage.jsx', 'electron/handlers/registerMcpHandlers.js', 'electron/services/builtinMcpInstallerService.js']) {
      expect(existsSync(path.join(root, gone))).toBe(false)
    }
    expect(existsSync(path.join(root, '_disabled/mcp-manager/README.md'))).toBe(true)
  })

  it('M-2 主进程启动时调用一次性清理', () => {
    const main = readFileSync(path.join(root, 'electron', 'main.js'), 'utf-8')
    expect(main).toMatch(/runLegacyProviderRegistryCleanup\(/)
  })
})
