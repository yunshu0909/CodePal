/**
 * 测试链自检（防"游离"）
 *
 * 存在意义：2026-09-13 发现旧 `自动化测试/` 里 3 套 + 根目录 9 个测试文件从未被任何
 * npm script 跑到 —— 付了维护费却没拿到保护，而且没人发现。这个文件把那条规矩变成
 * 机器检查：
 *   1. `tests/**` 下每个测试文件都必须被某个 npm script 覆盖（直接列文件，或落在某个
 *      被 `--config` 引用的配置目录里）
 *   2. vitest 类 script 里显式写出的 `tests/...` 路径必须真实存在（防手写路径打错）
 *
 * 它自己被 `test:root` 引用，所以规则对规则本身也成立。
 *
 * @module tests/testWiring
 */

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
const scripts = pkg.scripts || {}
const scriptsText = Object.values(scripts).join(' ')

/** 被 npm script 用 --config 引用的 vitest 配置的所在目录 */
function configDirs() {
  const dirs = []
  for (const m of scriptsText.matchAll(/--config\s+(\S+\.(?:js|mjs))/g)) {
    dirs.push(path.dirname(path.resolve(repoRoot, m[1])))
  }
  return dirs
}

/** 收集 tests/ 下所有测试文件（跳过生成物目录） */
function collectTestFiles() {
  const found = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'report' || entry.name === 'coverage' || entry.name === 'node_modules') continue
        walk(full)
      } else if (/\.(test|spec)\.(js|jsx)$/.test(entry.name)) {
        found.push(full)
      }
    }
  }
  walk(path.join(repoRoot, 'tests'))
  return found.sort()
}

describe('测试链自检', () => {
  it('tests/ 下每个测试文件都被某个 npm script 跑到（没有游离文件）', () => {
    const dirs = [...configDirs(), ...Array.from(scriptsText.matchAll(/(?:^|\s)(tests\/[^\s]+)/g), m => path.resolve(repoRoot, m[1])).filter(p => fs.existsSync(p) && fs.statSync(p).isDirectory())]
    const orphans = collectTestFiles().filter((file) => {
      if (scriptsText.includes(path.basename(file))) return false
      return !dirs.some((dir) => file === dir || file.startsWith(dir + path.sep))
    })

    expect(
      orphans.map((f) => path.relative(repoRoot, f)),
      '这些测试文件没有任何 npm script 会执行到（要么加进某个 script，要么放进被 --config 覆盖的目录）'
    ).toEqual([])
  })

  it('vitest 类 script 里写出的 tests/ 路径都真实存在', () => {
    const missing = []
    for (const [name, cmd] of Object.entries(scripts)) {
      if (!cmd.includes('vitest run')) continue
      for (const m of cmd.matchAll(/(?:^|\s)(tests\/\S+)/g)) {
        const rel = m[1]
        if (!fs.existsSync(path.join(repoRoot, rel))) missing.push(`${name} → ${rel}`)
      }
    }

    expect(missing, 'npm script 指向了不存在的测试路径（手写路径打错）').toEqual([])
  })

  it('tests/ 下确实有测试（防止自检本身在空集合上永远通过）', () => {
    expect(collectTestFiles().length).toBeGreaterThan(15)
  })
})
