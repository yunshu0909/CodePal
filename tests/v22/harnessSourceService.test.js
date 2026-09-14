/**
 * v2.2 源码 checkout 服务测试
 *
 * 全部命令由 fake runner 接管，不触碰真实仓库；重点验证「脏就拒绝」与「失败必回滚」。
 *
 * @module tests/v22/harnessSourceService
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

let service

beforeAll(async () => {
  const modulePath = '../../electron/services/harnessSourceService.js'
  try {
    const module = await import(/* @vite-ignore */ modulePath)
    service = module.default || module
  } catch (error) {
    throw new Error(`not implemented: ${error.message}`)
  }
})

/**
 * 造一个按命令前缀响应的假执行器，并记录所有调用。
 * @param {Record<string,string>} table 命令片段 → stdout
 */
function makeRunner(table = {}) {
  const calls = []
  const runner = vi.fn(async (binary, args = [], options = {}) => {
    const key = `${path.basename(binary)} ${args.join(' ')}`.trim()
    calls.push({ key, cwd: options.cwd })
    for (const [pattern, value] of Object.entries(table)) {
      if (key.includes(pattern)) {
        if (value instanceof Error) throw value
        return { stdout: value, stderr: '', exitCode: 0 }
      }
    }
    throw Object.assign(new Error(`unexpected command: ${key}`), { code: 'ENOENT' })
  })
  runner.calls = calls
  runner.keys = () => calls.map((call) => call.key)
  return runner
}

describe('v2.2 源码 checkout 服务', () => {
  let sandbox
  let repoDir

  beforeEach(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'codepal-src-'))
    repoDir = path.join(sandbox, 'checkout')
    await fs.mkdir(path.join(repoDir, '.git'), { recursive: true })
  })

  afterEach(async () => { await fs.rm(sandbox, { recursive: true, force: true }) })

  /** 常见 git 查询的默认应答 */
  const baseTable = {
    'git rev-parse --abbrev-ref HEAD': 'main\n',
    'git rev-parse --short HEAD': 'abc1234\n',
    'git status --porcelain': '',
    'git rev-parse --abbrev-ref --symbolic-full-name @{u}': 'origin/main\n',
    'git symbolic-ref --short refs/remotes/origin/HEAD': 'origin/master\n',
    'git fetch --quiet --prune': '',
    'git fetch --prune': '',
    'git rev-list --left-right --count HEAD...@{u}': '0\t3\n',
    'git rev-list --left-right --count HEAD...origin/main': '0\t3\n',
    'git merge --ff-only origin/main': '',
    'git diff --name-only abc1234 HEAD': 'apps/cli/src/index.ts\n',
    'git diff --name-only':
      'apps/cli/src/index.ts\n',
    'pnpm install --frozen-lockfile': '',
    'pnpm run build': '',
  }

  it('SC-501 不是 git 工作区就直接说不', async () => {
    const plain = path.join(sandbox, 'plain')
    await fs.mkdir(plain, { recursive: true })
    const state = await service.readSourceState({ sourceDir: plain }, { runCommand: makeRunner() })
    expect(state.isRepo).toBe(false)
  })

  it('SC-502 读出分支 / 提交 / 未提交改动 / 落后提交数', async () => {
    const runCommand = makeRunner(baseTable)
    const state = await service.readSourceState({ sourceDir: repoDir }, { runCommand })
    expect(state).toMatchObject({ isRepo: true, branch: 'main', commit: 'abc1234', dirty: 0, behind: 3, upstream: 'origin/main' })
    // 落后数要靠 fetch 之后的 rev-list 拿到
    expect(runCommand.keys().some((key) => key.includes('git fetch'))).toBe(true)
  })

  it('SC-503 只把已跟踪修改算脏，未跟踪文件放行', async () => {
    const runCommand = makeRunner({
      ...baseTable,
      'git status --porcelain': ' M tsconfig.client.json\n?? .local-plugins-pending-port/\n\n',
    })
    const state = await service.readSourceState({ sourceDir: repoDir }, { runCommand })
    // 这台机器的真实形态：一个已跟踪改动 + 一个未跟踪目录
    // 未跟踪不算脏——否则构建过一次（有 node_modules / 产物）就永远无法更新
    expect(state.dirty).toBe(1)
    expect(state.untracked).toBe(1)
  })

  it('SC-503b 只有未跟踪文件时不拦更新', async () => {
    const runCommand = makeRunner({
      ...baseTable,
      'git status --porcelain': '?? node_modules/\n?? built.txt\n',
    })
    const result = await service.updateSource({ sourceDir: repoDir }, { runCommand, pnpmBin: '/fake/pnpm' })
    expect(result.changed).toBe(true)
  })

  it('SC-504 有未提交改动时拒绝更新，且不动仓库', async () => {
    const runCommand = makeRunner({ ...baseTable, 'git status --porcelain': ' M tsconfig.client.json\n' })
    await expect(service.updateSource({ sourceDir: repoDir }, { runCommand, pnpmBin: '/fake/pnpm' }))
      .rejects.toMatchObject({ code: 'SOURCE_DIRTY' })
    // 关键：不能执行任何写操作
    expect(runCommand.keys().some((key) => key.includes('merge --ff-only'))).toBe(false)
    expect(runCommand.keys().some((key) => key.includes('reset --hard'))).toBe(false)
    expect(runCommand.keys().some((key) => key.includes('pnpm'))).toBe(false)
  })

  it('SC-505 更新走 fetch → ff-only 合并 → 构建', async () => {
    const runCommand = makeRunner(baseTable)
    const result = await service.updateSource({ sourceDir: repoDir }, { runCommand, pnpmBin: '/fake/pnpm' })
    expect(result.changed).toBe(true)
    expect(result.before).toBe('abc1234')
    const keys = runCommand.keys()
    expect(keys.some((key) => key.includes('git fetch --prune'))).toBe(true)
    expect(keys.some((key) => key.includes('git merge --ff-only origin/main'))).toBe(true)
    expect(keys.some((key) => key === 'pnpm run build')).toBe(true)
    // 依赖清单没变 → 不该装依赖（否则「点一下更新」变成几分钟等待）
    expect(keys.some((key) => key.includes('install'))).toBe(false)
  })

  it('SC-506 依赖清单变了才装依赖', async () => {
    const runCommand = makeRunner({
      ...baseTable,
      'git diff --name-only abc1234 HEAD': 'pnpm-lock.yaml\npackage.json\n',
    })
    const result = await service.updateSource({ sourceDir: repoDir }, { runCommand, pnpmBin: '/fake/pnpm' })
    expect(result.steps).toEqual(['pull', 'install', 'build'])
    expect(runCommand.keys().some((key) => key === 'pnpm install --frozen-lockfile')).toBe(true)
  })

  it('SC-507 构建失败必须回滚到更新前的提交', async () => {
    const runCommand = makeRunner({
      ...baseTable,
      'pnpm run build': new Error('build exploded'),
    })
    await expect(service.updateSource({ sourceDir: repoDir }, { runCommand, pnpmBin: '/fake/pnpm' }))
      .rejects.toMatchObject({ code: 'SOURCE_BUILD_FAILED' })
    const keys = runCommand.keys()
    expect(keys.some((key) => key.includes('git merge --abort'))).toBe(true)
    expect(keys.some((key) => key.includes('git reset --hard abc1234'))).toBe(true)
  })

  it('SC-508 合并失败（分叉）也回滚，并报可读原因', async () => {
    const runCommand = makeRunner({
      ...baseTable,
      'git merge --ff-only origin/main': new Error('not possible to fast-forward'),
    })
    await expect(service.updateSource({ sourceDir: repoDir }, { runCommand, pnpmBin: '/fake/pnpm' }))
      .rejects.toMatchObject({ code: 'SOURCE_PULL_FAILED' })
    expect(runCommand.keys().some((key) => key.includes('git reset --hard abc1234'))).toBe(true)
  })

  it('SC-509 拉取失败不回滚（还没动过），但要说清是网络问题', async () => {
    const runCommand = makeRunner({ ...baseTable, 'git fetch --prune': new Error('could not resolve host') })
    await expect(service.updateSource({ sourceDir: repoDir }, { runCommand, pnpmBin: '/fake/pnpm' }))
      .rejects.toMatchObject({ code: 'SOURCE_FETCH_FAILED' })
  })

  it('SC-510 连回退引用都没有时明确拒绝', async () => {
    const runCommand = makeRunner({
      ...baseTable,
      'git rev-parse --abbrev-ref --symbolic-full-name @{u}': new Error('no upstream'),
      'git rev-parse --verify --quiet refs/remotes/origin/main': new Error('missing'),
      'git symbolic-ref --short refs/remotes/origin/HEAD': new Error('no HEAD'),
    })
    await expect(service.updateSource({ sourceDir: repoDir }, { runCommand, pnpmBin: '/fake/pnpm' }))
      .rejects.toMatchObject({ code: 'SOURCE_NO_UPSTREAM' })
  })

  it('SC-511 缺 pnpm 时明确拒绝，而不是跑到一半失败', async () => {
    const runCommand = makeRunner(baseTable)
    // 不注入 pnpmBin，且静态候选都不存在 → 解析失败
    const statFn = async (target) => {
      if (String(target).endsWith('.git')) return { isDirectory: () => true }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }
    await expect(service.updateSource({ sourceDir: repoDir }, { runCommand, statFn }))
      .rejects.toMatchObject({ code: 'SOURCE_PNPM_MISSING' })
  })

  it('SC-513 没有 upstream 时回退到同名远端分支', async () => {
    const runCommand = makeRunner({
      ...baseTable,
      'git rev-parse --abbrev-ref --symbolic-full-name @{u}': new Error('no upstream'),
      'git rev-parse --verify --quiet refs/remotes/origin/main': 'ok\n',
    })
    const state = await service.readSourceState({ sourceDir: repoDir }, { runCommand })
    expect(state.upstream).toBe('origin/main')
    expect(state.upstreamSource).toBe('same-name')
    expect(state.updatable).toBe(true)
  })

  it('SC-514 同名远端分支也没有时，只把默认分支当参考，且拒绝自动更新', async () => {
    const runCommand = makeRunner({
      ...baseTable,
      'git rev-parse --abbrev-ref --symbolic-full-name @{u}': new Error('no upstream'),
      'git rev-parse --verify --quiet refs/remotes/origin/main': new Error('missing'),
    })
    const state = await service.readSourceState({ sourceDir: repoDir }, { runCommand })
    expect(state.upstream).toBe('origin/master')
    expect(state.upstreamSource).toBe('default-branch')
    expect(state.updatable).toBe(false)
    // 参考信息可以算，但不允许更新
    await expect(service.updateSource({ sourceDir: repoDir }, { runCommand, pnpmBin: '/fake/pnpm' }))
      .rejects.toMatchObject({ code: 'SOURCE_BRANCH_NOT_TRACKED' })
  })

  it('SC-512 远端不可达时 behind 留 null（未知），不把整个探测弄挂', async () => {
    const runCommand = makeRunner({
      ...baseTable,
      'git fetch --quiet --prune': new Error('offline'),
    })
    const state = await service.readSourceState({ sourceDir: repoDir }, { runCommand })
    expect(state.isRepo).toBe(true)
    expect(state.fetched).toBe(false)
  })
})
