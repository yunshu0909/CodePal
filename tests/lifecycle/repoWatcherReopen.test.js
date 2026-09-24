/**
 * 中央仓库监听：关窗再开后恢复 — 行为测试（架构优化路线 3 第一步）
 *
 * 负责：
 * - macOS 关掉最后一个窗口会停监听；再开窗口时要恢复，且用的是最新的仓库路径
 * - 快速关 / 开时启停串行，不会出现「开了又被旧的停掉」
 * - 已在监听时不重复启动
 *
 * @module tests/lifecycle/repoWatcherReopen.test
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { registerRepoWatcherHandlers } = require('../../electron/handlers/registerRepoWatcherHandlers')

/** 记录调用顺序的假 watcher；start / stop 故意异步，模拟真实启停耗时 */
function fakeWatcher(log) {
  let watching = false
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5))
  return {
    async startWatching(p) { await tick(); watching = true; log.push(`start:${p}`) },
    async stopWatching() { await tick(); watching = false; log.push('stop') },
    async restartWatching(p) { await this.stopWatching(); await this.startWatching(p) },
    isWatching: () => watching,
    acquireSyncLock() {},
    releaseSyncLock() {},
  }
}

function setup() {
  const log = []
  const handlers = new Map()
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) }
  const api = registerRepoWatcherHandlers({
    ipcMain,
    getMainWindow: () => null,
    expandHome: (p) => p.replace('~', '/home'),
    initialRepoPath: '~/repo',
    createWatcher: () => fakeWatcher(log),
  })
  return { log, handlers, api }
}

describe('关窗再开恢复中央仓库监听', () => {
  it('W-1 关窗停监听后，再开窗口恢复监听', async () => {
    const { log, api } = setup()
    await api.stopWatching()
    await api.ensureWatching()
    expect(log).toEqual(['start:/home/repo', 'stop', 'start:/home/repo'])
  })

  it('W-2 仓库路径改过之后，恢复时用新路径', async () => {
    const { log, handlers, api } = setup()
    await handlers.get('restart-repo-watcher')(null, '~/other')
    await api.stopWatching()
    await api.ensureWatching()
    expect(log.at(-1)).toBe('start:/home/other')
  })

  it('W-3 快速关 / 开：不等停完就开，最终仍在监听，且顺序是先停后开', async () => {
    const { log, api } = setup()
    const stopping = api.stopWatching()
    const ensuring = api.ensureWatching()
    await Promise.all([stopping, ensuring])
    expect(log).toEqual(['start:/home/repo', 'stop', 'start:/home/repo'])
  })

  it('W-4 已在监听时再开窗口不重复启动', async () => {
    const { log, api } = setup()
    await api.ensureWatching()
    await api.ensureWatching()
    expect(log).toEqual(['start:/home/repo'])
  })

  it('W-5 主进程每次建窗口都会调用 ensureWatching', () => {
    const main = readFileSync(path.resolve(__dirname, '..', '..', 'electron', 'main.js'), 'utf-8')
    const start = main.indexOf('function createWindow()')
    const body = main.slice(start, main.indexOf('\n}\n', start))
    expect(body).toMatch(/repoWatcherCleanup\?\.ensureWatching\(\)/)
  })
})
