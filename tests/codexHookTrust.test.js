/**
 * 自动信任 Codex 钩子测试（#41）
 *
 * 负责：用一个假的 codex app-server（node 脚本，按行收发 JSON-RPC）确认
 * - 只信任命令指向 CodePal 脚本、且来自给定 config.toml 的未信任钩子
 * - 写入的是 hooks.state."<key>" = { enabled, trusted_hash = Codex 给的 currentHash }
 * - 已信任的不重复写；找不到程序时报错
 *
 * @module tests/codexHookTrust
 */

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { trustCodePalCodexHooks } = require('../electron/services/codexHookTrust.js')

function fakeCodex(hooks) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-codex-'))
  const log = path.join(dir, 'writes.json')
  const bin = path.join(dir, 'codex')
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs'); let buf = ''
const hooks = ${JSON.stringify(hooks)}
process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1)
  if (m.id == null) continue
  let result = {}
  if (m.method === 'hooks/list') result = { data: [{ cwd: '/x', hooks, warnings: [], errors: [] }] }
  if (m.method === 'config/batchWrite') { fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(m.params)); result = { status: 'ok' } }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n') } })
`, { mode: 0o755 })
  return { bin, log }
}

const CFG = '/home/u/.codex/config.toml'
const hook = (event, command, trustStatus, sourcePath = CFG) => ({ key: `${sourcePath}:${event}:0:0`, eventName: event, command, sourcePath, currentHash: `sha256:${event}`, trustStatus })

describe('trustCodePalCodexHooks', () => {
  it('只信任我们的、未信任的钩子；别人的钩子和已信任的不动', async () => {
    const { bin, log } = fakeCodex([
      hook('interrupt', 'bash /home/u/.claude/k28-status-light/codex-hook.sh stopped', 'untrusted'),
      hook('stop', 'bash /home/u/.claude/k28-status-light/codex-hook.sh done', 'trusted'),
      hook('session_start', 'python3 someone-else.py', 'untrusted'),
      hook('post_tool_use', 'bash /home/u/.claude/k28-status-light/codex-hook.sh busy', 'untrusted', '/home/u/.codex/hooks.json'),
    ])
    const result = await trustCodePalCodexHooks({ configPath: CFG, codexBin: bin })
    expect(result).toEqual({ trusted: 1, alreadyTrusted: 1 })
    expect(JSON.parse(fs.readFileSync(log, 'utf8'))).toEqual({
      edits: [{ keyPath: `hooks.state.${JSON.stringify(`${CFG}:interrupt:0:0`)}`, value: { enabled: true, trusted_hash: 'sha256:interrupt' }, mergeStrategy: 'upsert' }],
    })
  })

  it('都已信任时不写', async () => {
    const { bin, log } = fakeCodex([hook('stop', 'bash /x/k28-status-light/codex-hook.sh done', 'trusted')])
    expect(await trustCodePalCodexHooks({ configPath: CFG, codexBin: bin })).toEqual({ trusted: 0, alreadyTrusted: 1 })
    expect(fs.existsSync(log)).toBe(false)
  })

  it('找不到 Codex 程序时报错', async () => {
    await expect(trustCodePalCodexHooks({ configPath: CFG, codexBin: null })).rejects.toThrow('没找到 Codex 程序')
  })
})
