/** @vitest-environment node */
import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const source = fs.readFileSync(require.resolve('../../electron/modules/models/claudeCli.js'), 'utf8')
const roots = []

// Run the production module with isolated OS/process dependencies; never consult real shell profiles.
function fixture({ accountShell = '/bin/zsh', shellResult, accountThrows = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude discovery '))
  roots.push(home)
  const systemFiles = new Set()
  const spawnSync = vi.fn(() => shellResult || { status: 1, stdout: '' })
  const module = { exports: {} }
  const env = { HOME: home, PATH: '/empty-path', SHELL: '/bin/bash' }
  const deps = {
    fs: {
      ...fs,
      statSync: (file) => systemFiles.has(file) ? { isFile: () => true } : fs.statSync(file),
      accessSync: (file, mode) => systemFiles.has(file) ? undefined : fs.accessSync(file, mode),
    },
    os: { ...os, homedir: () => home, userInfo: () => {
      if (accountThrows) throw new Error('account unavailable')
      return { shell: accountShell }
    } },
    child_process: { spawnSync },
  }
  vm.runInNewContext(source, { module, require: (id) => deps[id] || require(id), process: { env } })
  const executable = (relative, mode = 0o755) => {
    const file = path.join(home, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode })
    return file
  }
  return { ...module.exports, home, env, spawnSync, executable, systemFiles }
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

it('TC-001 finds native symlinks and common install directories with a minimal PATH', () => {
  const f = fixture()
  const native = f.executable('.local/share/claude/versions/2.1.310')
  const link = path.join(f.home, '.local/bin/claude')
  fs.mkdirSync(path.dirname(link), { recursive: true })
  fs.symlinkSync(native, link)
  expect(f.locateClaude(f.env)).toBe(link)
  expect(f.spawnSync).not.toHaveBeenCalled()
  fs.unlinkSync(link)
  const npm = f.executable('.npm-global/bin/claude')
  expect(f.locateClaude(f.env)).toBe(npm)
  fs.unlinkSync(npm)
  f.systemFiles.add('/opt/homebrew/bin/claude')
  f.systemFiles.add('/usr/local/bin/claude')
  expect(f.locateClaude(f.env)).toBe('/opt/homebrew/bin/claude')
  f.systemFiles.delete('/opt/homebrew/bin/claude')
  expect(f.locateClaude(f.env)).toBe('/usr/local/bin/claude')
})

it('#86-1 旧版本地安装（claude migrate-installer 装到 ~/.claude/local/claude）从精简 PATH 也找得到，不用问 shell', () => {
  const f = fixture()
  // 只有目录、里面没有可执行的 claude：不算装了，照旧去问 shell
  fs.mkdirSync(path.join(f.home, '.claude/local'), { recursive: true })
  expect(f.locateClaude(f.env)).toBeNull()
  expect(f.spawnSync).toHaveBeenCalledTimes(1)
  const local = f.executable('.claude/local/claude')
  expect(f.locateClaude(f.env)).toBe(local)
  expect(f.spawnSync).toHaveBeenCalledTimes(1)
  // 新旧两种都在时用新的（~/.local/bin），旧的只是兜底
  const native = f.executable('.local/bin/claude')
  expect(f.locateClaude(f.env)).toBe(native)
  // 不可执行的旧文件不算
  fs.unlinkSync(native)
  fs.chmodSync(local, 0o644)
  expect(f.locateClaude(f.env)).toBeNull()
})

it('TC-002 queries the account shell with supplied environment and ignores startup noise', () => {
  const f = fixture()
  const custom = f.executable('custom bin/claude')
  f.spawnSync.mockReturnValue({ status: 0, stdout: `welcome\n__CODEPAL_CLAUDE_BEGIN__${custom}\n__CODEPAL_CLAUDE_END__\nbye\n` })
  expect(f.locateClaude(f.env)).toBe(custom)
  expect(f.spawnSync).toHaveBeenCalledWith('/bin/zsh', ['-ilc', expect.any(String)], expect.objectContaining({ env: f.env, timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
  const fallback = fixture({ accountThrows: true })
  fallback.env.SHELL = '/usr/local/bin/fish'
  fallback.locateClaude(fallback.env)
  expect(fallback.spawnSync.mock.calls[0][0]).toBe('/usr/local/bin/fish')
  const noShell = fixture({ accountShell: null })
  delete noShell.env.SHELL
  noShell.locateClaude(noShell.env)
  expect(noShell.spawnSync.mock.calls[0][0]).toBe('/bin/bash')
  f.spawnSync.mockReturnValue({ status: 0, stdout: `${custom}\n` })
  expect(f.locateClaude(f.env)).toBeNull()
})

it('TC-003 preserves explicit override and PATH precedence and rejects unusable candidates', () => {
  const f = fixture()
  const first = f.executable('first/claude')
  const second = f.executable('second/claude')
  const override = f.executable('override/claude')
  f.env.PATH = [path.dirname(first), path.dirname(second)].join(path.delimiter)
  expect(f.locateClaude(f.env)).toBe(first)
  expect(f.locateClaude({ ...f.env, CODEPAL_CLAUDE_BIN: override })).toBe(override)
  expect(f.locateClaude({ ...f.env, CODEPAL_CLAUDE_BIN: '/missing-override' })).toBeNull()
  fs.chmodSync(first, 0o644)
  expect(f.locateClaude(f.env)).toBe(second)
  fs.unlinkSync(second)
  fs.symlinkSync('/missing-target', second)
  expect(f.locateClaude(f.env)).toBeNull()
  f.executable('.local/bin/claude', 0o644)
  expect(f.locateClaude(f.env)).toBeNull()
  f.spawnSync.mockReturnValue({ status: null, error: new Error('timeout'), stdout: '' })
  expect(f.locateClaude(f.env)).toBeNull()
  f.spawnSync.mockImplementation(() => { throw new Error('spawn failed') })
  expect(f.locateClaude(f.env)).toBeNull()
})
