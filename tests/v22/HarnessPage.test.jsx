/**
 * v2.2 Harness 管理页 v2 测试
 *
 * 30 个场景对应 specs/v2-2-Harness管理/feature-contract.json 的 SC-001…SC-030：
 * 页面按「运行」「安装」两张卡组织，快照数据与设计稿 v2 画面一致。
 * INV-001（harness.css 只用 token）随 SC-004 执行。
 *
 * @module tests/v22/HarnessPage
 */

import React from 'react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import HarnessPage from '../../src/pages/HarnessPage'

const HOME = '/Users/demo'
const RUNTIME_DIR = `${HOME}/Documents/SkillManager/runtimes/dsh`
const SRC_DIR = `${HOME}/Documents/Codex/2026-08-13/https-github-com-deepseek-ai-deepseek`
const STABLE = '0.1.5-rc.1'
const PREVIEW = '0.1.5-rc.2'

/** 造一份快照；默认是「未安装、没在跑」，字段形态与主进程 getHarnessSnapshot 一致。 */
function snapshot(overrides = {}) {
  const base = {
    platform: 'darwin',
    supportedPlatform: true,
    generatedAt: '2026-09-14T08:00:00.000Z',
    node: { available: true, version: 'v26.0.0', supported: true, required: '^22.19.0 || >=24.0.0' },
    install: {
      kind: 'none', version: null, location: null, runtimeDir: RUNTIME_DIR,
      managedVersion: null, sourceVersion: null, sourceDir: null, pathBinary: null,
      canUpgrade: false, canInstall: true, canTakeOver: false, canUninstall: false, canUpdate: false,
    },
    registry: { ok: true, channels: { latest: STABLE, next: PREVIEW }, upgradeTargets: { latest: null, next: null } },
    supervisor: { kind: 'none', label: null, plistPath: null, entry: null, keepAlive: null, logPath: null },
    runtime: { running: false, mode: 'none', pid: null, port: null, url: null, startedAt: null, version: null, processes: 0 },
    source: null,
    stopOnQuit: true,
  }
  return {
    ...base,
    ...overrides,
    node: { ...base.node, ...overrides.node },
    install: { ...base.install, ...overrides.install },
    registry: { ...base.registry, ...overrides.registry },
    supervisor: { ...base.supervisor, ...overrides.supervisor },
    runtime: { ...base.runtime, ...overrides.runtime },
    source: overrides.source === undefined ? base.source : overrides.source,
  }
}

const SOURCE_INSTALL = {
  kind: 'source', version: PREVIEW, sourceVersion: PREVIEW, sourceDir: SRC_DIR,
  canInstall: true, canTakeOver: true, canUninstall: true, canUpdate: true,
}
const LAUNCHD = { kind: 'launchd', label: 'com.dsh.web', plistPath: `${HOME}/Library/LaunchAgents/com.dsh.web.plist`, keepAlive: true }
const LAUNCHD_RUNNING = { running: true, mode: 'launchd', pid: 84384, port: 3080, url: 'http://127.0.0.1:3080/?token=secret-once', processes: 1 }
const SOURCE_BLOCKED = { isRepo: true, branch: 'release-0.1.5-rc.2', commit: 'fb2c4b9e69', dirty: 0, untracked: 0, upstream: 'origin/master', upstreamSource: 'default', updatable: false, behind: 139, ahead: 0 }
const SOURCE_MAIN = { isRepo: true, branch: 'main', commit: '3e1a9c2f40', dirty: 0, untracked: 0, upstream: 'origin/main', upstreamSource: 'tracking', updatable: true, behind: 12, ahead: 0 }

/** 源码目录 + launchd 系统服务运行中（本机真实形态，设计稿第 06 帧）。 */
const sourceRunning = (overrides = {}) => snapshot({
  install: SOURCE_INSTALL,
  supervisor: LAUNCHD,
  runtime: LAUNCHD_RUNNING,
  source: SOURCE_BLOCKED,
  ...overrides,
})

const MANAGED_INSTALL = {
  kind: 'managed', version: STABLE, managedVersion: STABLE, location: RUNTIME_DIR,
  canUpgrade: true, canInstall: true, canTakeOver: false, canUninstall: true, canUpdate: true,
}
const SIDECAR_RUNNING = { running: true, mode: 'sidecar', pid: 51208, port: 52931, url: 'http://127.0.0.1:52931/?token=secret-once', processes: 1 }

/** CodePal 托管版；默认运行中、稳定通道已是最新。 */
const managed = (overrides = {}) => snapshot({
  install: MANAGED_INSTALL,
  runtime: SIDECAR_RUNNING,
  ...overrides,
})

const PATH_INSTALL = { kind: 'path', version: null, pathBinary: '/opt/homebrew/bin/dsh', canInstall: true, canTakeOver: false, canUninstall: false, canUpdate: false }

function installApi(data, harness = {}) {
  window.electronAPI = {
    harness: {
      getSnapshot: vi.fn(async () => ({ success: true, data })),
      listVersions: vi.fn(async () => ({ success: true, data: {} })),
      install: vi.fn(async () => ({ success: true, data: { snapshot: data } })),
      uninstall: vi.fn(async () => ({ success: true, data: { removed: true, snapshot: data } })),
      start: vi.fn(async () => ({ success: true, data: { snapshot: data } })),
      stop: vi.fn(async () => ({ success: true, data: { stopped: true, snapshot: data } })),
      restart: vi.fn(async () => ({ success: true, data: { snapshot: data } })),
      update: vi.fn(async () => ({ success: true, data: { snapshot: data } })),
      setStopOnQuit: vi.fn(async () => ({ success: true, data: { stopOnQuit: false } })),
      setKeepAlive: vi.fn(async () => ({ success: true, data: { keepAlive: false, snapshot: data } })),
      ...harness,
    },
    openExternalLink: vi.fn(async () => ({ success: true })),
  }
  return window.electronAPI
}

/** 未决 Promise：让某个操作停在进行中。 */
function deferred() {
  let resolveFn
  const promise = new Promise((resolvePromise) => { resolveFn = resolvePromise })
  return { promise, resolve: resolveFn }
}

async function renderPage(data, harness) {
  const api = installApi(data, harness)
  const view = render(<HarnessPage />)
  await screen.findByRole('region', { name: '运行' })
  return { api, ...view }
}

const runCard = () => screen.getByRole('region', { name: '运行' })
const installCard = () => screen.getByRole('region', { name: '安装' })
const headerButtons = (container) => [...container.querySelectorAll('.page-shell__actions button')].map((button) => button.textContent)
const rowLabels = (card) => [...card.querySelectorAll('.harness-row__label')].map((label) => label.textContent)
const rowOf = (card, label) => within(card).getByText(label, { selector: '.harness-row__label' }).closest('.harness-row')
const button = (name, scope) => (scope ? within(scope) : screen).getByRole('button', { name })
const pageText = () => document.body.textContent

afterEach(() => {
  cleanup()
  delete window.electronAPI
  vi.useRealTimers()
})

describe('HarnessPage v2', () => {
  // ── F-001 页面骨架、加载与刷新 ─────────────────────────────────────

  it('SC-001 源码版系统服务运行中呈现运行卡与安装卡', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const { container } = await renderPage(sourceRunning())

    expect(headerButtons(container)).toEqual(['打开界面', '刷新'])
    expect(button('打开界面').className).toContain('btn--primary')
    expect(container.querySelector('.page-shell').className).not.toContain('page-shell--no-padding')
    expect(pageText()).not.toContain('检查更新')

    const run = runCard()
    expect(run.querySelector('.harness-dot--running')).toBeTruthy()
    expect(within(run).getByText('运行中')).toBeTruthy()
    expect(button('重启', run)).toBeTruthy()
    expect(button('停止', run)).toBeTruthy()
    expect(rowLabels(run)).toEqual(['访问地址', 'PID', '运行方式', '崩溃后自动重启'])
    expect(within(rowOf(run, '访问地址')).getByText('http://127.0.0.1:3080')).toBeTruthy()
    expect(within(rowOf(run, 'PID')).getByText('84384')).toBeTruthy()
    expect(rowOf(run, '运行方式').textContent).toContain('系统服务')
    expect(rowOf(run, '运行方式').textContent).toContain('com.dsh.web')
    expect(within(rowOf(run, '崩溃后自动重启')).getByRole('switch').getAttribute('aria-checked')).toBe('true')

    const install = installCard()
    expect(install.querySelector('.harness-panel__title').textContent).toBe('安装')
    expect(install.querySelector('.harness-panel__meta').textContent).toBe(PREVIEW)
    expect(pageText().match(/(?<!release-)0\.1\.5-rc\.2/g)).toHaveLength(1)
    expect(rowLabels(install)).toEqual(['位置', '分支', '更新', '卸载'])
    expect(within(rowOf(install, '位置')).getByText('源码目录')).toBeTruthy()
    expect(rowOf(install, '分支').textContent).toContain('release-0.1.5-rc.2')
    expect(rowOf(install, '分支').textContent).toContain('fb2c4b9e69')
    const update = rowOf(install, '更新')
    expect(within(update).getByText('无法自动更新')).toBeTruthy()
    expect(button('转为托管', update)).toBeTruthy()
    expect(update.textContent).toContain('本地分支在远端没有对应分支，origin/master 已领先 139 个提交')
    expect(rowOf(install, '卸载').textContent).toContain('只移除启动项，不删源码目录')

    expect(pageText()).not.toContain('token=')
    fireEvent.click(button('复制', run))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('http://127.0.0.1:3080/?token=secret-once'))
    expect(pageText()).not.toContain('token=')
  })

  it('SC-002 首次加载只显示加载视图与刷新', async () => {
    installApi(snapshot(), { getSnapshot: vi.fn(() => new Promise(() => {})) })
    const { container } = render(<HarnessPage />)

    expect(await screen.findByText('正在读取 DeepSeek Harness 状态')).toBeTruthy()
    expect(container.querySelector('.state-view--loading')).toBeTruthy()
    expect(headerButtons(container)).toEqual(['刷新'])
    expect(screen.queryByRole('region', { name: '运行' })).toBe(null)
    expect(screen.queryByRole('region', { name: '安装' })).toBe(null)
  })

  it('SC-003 读取失败显示错误视图与重试', async () => {
    const getSnapshot = vi.fn(async () => ({ success: false, error: 'HARNESS_UNKNOWN_ERROR' }))
    installApi(snapshot(), { getSnapshot })
    const { container } = render(<HarnessPage />)

    expect(await screen.findByText('Harness 状态读取失败')).toBeTruthy()
    expect(screen.getByText('没有安装或修改任何东西')).toBeTruthy()
    expect(headerButtons(container)).toEqual(['刷新'])
    expect(screen.queryByRole('region', { name: '运行' })).toBe(null)
    fireEvent.click(button('重试'))
    await waitFor(() => expect(getSnapshot).toHaveBeenCalledTimes(2))
  })

  it('SC-004 最小窗口长文本不撑破行', async () => {
    const longDir = `${HOME}/Documents/Codex/2026-08-13/workspaces/deepseek/harness/checkouts/https-github-com-deepseek-ai-deepseek-harness-monorepo`
    await renderPage(sourceRunning({
      install: { ...SOURCE_INSTALL, sourceDir: longDir },
      supervisor: { ...LAUNCHD, label: 'com.deepseek.harness.web.development-profile' },
      runtime: { ...LAUNCHD_RUNNING, port: 49152, pid: 1284093, url: 'http://127.0.0.1:49152/?token=secret-once' },
      source: { ...SOURCE_BLOCKED, branch: 'feature/web-profile-refactor-with-a-very-long-branch-name-2026-09' },
    }))

    const run = runCard()
    const install = installCard()
    expect(document.querySelectorAll('.harness > .harness-panel')).toHaveLength(2)
    for (const card of [run, install]) {
      for (const row of card.querySelectorAll('.harness-row')) {
        expect(row.querySelectorAll(':scope > .harness-row__label')).toHaveLength(1)
      }
    }
    expect(rowOf(run, '访问地址').textContent).toContain('http://127.0.0.1:49152')
    expect(rowOf(run, 'PID').textContent).toContain('1284093')
    expect(rowOf(run, '运行方式').querySelector('.harness-mono--muted').textContent).toBe('com.deepseek.harness.web.development-profile')
    expect(rowOf(install, '位置').querySelector('.harness-path__tail').textContent).toBe('/https-github-com-deepseek-ai-deepseek-harness-monorepo')
    expect(rowOf(install, '分支').querySelector('.harness-mono--keep').textContent).toBe('fb2c4b9e69')
    expect(button('重启', run).closest('.harness-panel__actions')).toBeTruthy()
    expect(button('转为托管', install).closest('.harness-row__action')).toBeTruthy()
    expect(button('卸载', install).closest('.harness-row__action')).toBeTruthy()
    expect(rowOf(install, '更新').querySelector('.harness-row__note')).toBeTruthy()

    // INV-001：只用 token，并保留长文本收缩规则
    const css = readFileSync(resolve(process.cwd(), 'src/styles/harness.css'), 'utf8')
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(css).not.toMatch(/box-shadow/)
    expect(css).toMatch(/grid-template-columns:\s*72px minmax\(0, 1fr\) auto/)
    expect(css).toMatch(/\.harness-path__tail\s*\{[^}]*flex-shrink:\s*0/)
    expect(css).toMatch(/\.harness-mono\s*\{[^}]*text-overflow:\s*ellipsis/)
  })

  it('SC-005 刷新保留内容只让刷新按钮转圈', async () => {
    const next = deferred()
    const { api, container } = await renderPage(sourceRunning())
    api.harness.getSnapshot.mockImplementationOnce(() => next.promise)

    fireEvent.click(button('刷新'))
    await waitFor(() => expect(button('刷新').disabled).toBe(true))
    expect(button('刷新').className).toContain('btn--loading')
    expect(container.querySelector('.state-view--loading')).toBe(null)
    expect(within(runCard()).getByText('84384')).toBeTruthy()
    expect(button('打开界面').disabled).toBe(false)

    await act(async () => {
      next.resolve({ success: true, data: sourceRunning({ runtime: { ...LAUNCHD_RUNNING, pid: 90210 } }) })
    })
    await waitFor(() => expect(within(runCard()).getByText('90210')).toBeTruthy())
    expect(button('刷新').disabled).toBe(false)
  })

  // ── F-002 首次安装 ──────────────────────────────────────────────────

  it('SC-006 未安装显示空心点与安装引导', async () => {
    const { container } = await renderPage(snapshot())

    expect(headerButtons(container)).toEqual(['安装', '刷新'])
    const run = runCard()
    expect(run.querySelector('.harness-dot--none')).toBeTruthy()
    expect(run.querySelector('.harness-dot--danger')).toBe(null)
    expect(within(run).getByText('未安装')).toBeTruthy()
    expect(within(run).getByText('装好后在这里启动、停止和打开界面')).toBeTruthy()
    expect(run.querySelectorAll('.harness-row')).toHaveLength(0)
    expect(within(run).queryByRole('button')).toBe(null)

    const install = installCard()
    expect(rowLabels(install)).toEqual(['安装到', '更新通道', 'Node'])
    expect(rowOf(install, '安装到').textContent).toBe('安装到~/Documents/SkillManager/runtimes/dsh')
    const channels = within(rowOf(install, '更新通道'))
    expect(channels.getByRole('button', { name: `稳定 ${STABLE}` }).className).toContain('is-active')
    expect(channels.getByRole('button', { name: `预览 ${PREVIEW}` }).className).not.toContain('is-active')
    expect(rowOf(install, 'Node').textContent).toContain('v26.0.0')
    expect(rowOf(install, 'Node').textContent).toContain('满足要求')
    expect(install.querySelector('.harness-panel__foot').textContent).toBe('不写全局 npm，不需要管理员权限；卸载时默认保留 ~/.dsh 里的会话数据')
  })

  it('SC-007 安装中只锁安装按钮并提示进度', async () => {
    const pending = deferred()
    const { api } = await renderPage(snapshot(), { install: vi.fn(() => pending.promise) })

    fireEvent.click(button('安装'))
    await waitFor(() => expect(button('安装').disabled).toBe(true))
    expect(api.harness.install).toHaveBeenCalledWith({ channel: 'latest', force: true })
    expect(button('安装').className).toContain('btn--loading')
    expect(within(runCard()).getByText(`正在安装稳定通道 ${STABLE}`)).toBeTruthy()
    expect(button('刷新').disabled).toBe(false)
    expect(rowOf(installCard(), 'Node')).toBeTruthy()
    await act(async () => { pending.resolve({ success: true, data: { snapshot: snapshot() } }) })
  })

  it('SC-008 未检测到 Node 时页面照常并禁用安装', async () => {
    const { container } = await renderPage(snapshot({
      node: { available: false, version: null, supported: false },
      install: { canInstall: false },
    }))

    expect(container.querySelector('.state-view--empty')).toBe(null)
    expect(installCard()).toBeTruthy()
    const node = rowOf(installCard(), 'Node')
    expect(within(node).getByText('未检测到')).toBeTruthy()
    expect(within(node).getByText('未满足').className).toContain('tag--warning')
    expect(node.textContent).toContain('先安装 Node 22.19 以上或 24 以上，再回到这里点「刷新」')
    expect(button('安装').disabled).toBe(true)
  })

  it('SC-009 平台不支持时禁用安装并说明', async () => {
    await renderPage(snapshot({ platform: 'win32', supportedPlatform: false }))

    expect(button('安装').disabled).toBe(true)
    expect(within(runCard()).getByText('暂不支持 Windows，目前只支持 macOS 和 Linux')).toBeTruthy()
    expect(rowLabels(installCard())).toEqual(['更新通道'])
    expect(installCard().querySelector('.harness-panel__foot')).toBe(null)
  })

  it('SC-010 Node 版本过低时标未满足并禁用安装', async () => {
    await renderPage(snapshot({
      node: { available: true, version: 'v20.11.1', supported: false },
      install: { canInstall: false },
    }))

    const node = rowOf(installCard(), 'Node')
    expect(within(node).getByText('v20.11.1')).toBeTruthy()
    expect(within(node).getByText('未满足').className).toContain('tag--warning')
    expect(node.textContent).toContain('需要 ^22.19.0 || >=24.0.0，升级 Node 后回到这里点「刷新」')
    expect(button('安装').disabled).toBe(true)
  })

  // ── F-003 CodePal 启动的实例 ────────────────────────────────────────

  it('SC-011 托管版运行中显示由 CodePal 启动与退出时停止开关', async () => {
    const { api, container } = await renderPage(managed())

    expect(headerButtons(container)).toEqual(['打开界面', '刷新'])
    const run = runCard()
    expect(within(run).getByText('运行中')).toBeTruthy()
    expect(button('重启', run)).toBeTruthy()
    expect(button('停止', run)).toBeTruthy()
    expect(rowLabels(run)).toEqual(['访问地址', 'PID', '运行方式', '退出 CodePal 时一并停止'])
    expect(rowOf(run, '访问地址').textContent).toContain('http://127.0.0.1:52931')
    expect(rowOf(run, 'PID').textContent).toContain('51208')
    expect(rowOf(run, '运行方式').textContent).toContain('由 CodePal 启动')
    const stopOnQuit = rowOf(run, '退出 CodePal 时一并停止')
    expect(stopOnQuit.textContent).toContain('关掉后 dsh 留在后台，下次打开 CodePal 会自动接上')

    const install = installCard()
    expect(install.querySelector('.harness-panel__meta').textContent).toBe(STABLE)
    expect(rowLabels(install)).toEqual(['位置', '更新通道', '更新', '卸载'])
    expect(rowOf(install, '位置').textContent).toContain('~/Documents/SkillManager/runtimes/dsh')
    expect(within(rowOf(install, '位置')).getByText('CodePal 托管')).toBeTruthy()
    expect(rowOf(install, '更新').textContent).toBe('更新已是最新')
    expect(rowOf(install, '卸载').textContent).toContain('删除托管副本，~/.dsh 默认保留')
    expect(pageText()).not.toContain('重装')
    expect(pageText()).not.toContain('token=')

    fireEvent.click(within(stopOnQuit).getByRole('switch'))
    await waitFor(() => expect(api.harness.setStopOnQuit).toHaveBeenCalledWith({ enabled: false }))
  })

  it('SC-012 启动中只锁启动按钮并提示进度', async () => {
    const pending = deferred()
    const { api } = await renderPage(managed({ runtime: { running: false, mode: 'none', pid: null, port: null, url: null } }), {
      start: vi.fn(() => pending.promise),
    })

    fireEvent.click(button('启动'))
    await waitFor(() => expect(button('启动').disabled).toBe(true))
    expect(api.harness.start).toHaveBeenCalledWith({})
    expect(button('启动').className).toContain('btn--loading')
    expect(within(runCard()).getByText('已停止')).toBeTruthy()
    expect(within(runCard()).getByText('正在启动，就绪后自动打开界面')).toBeTruthy()
    expect(button('刷新').disabled).toBe(false)

    await act(async () => { pending.resolve({ success: true, data: { snapshot: managed() } }) })
    await waitFor(() => expect(api.openExternalLink).toHaveBeenCalledWith('http://127.0.0.1:52931/?token=secret-once'))
  })

  it('SC-013 托管版已停止不显示地址与 PID', async () => {
    const { api } = await renderPage(managed({ runtime: { running: false, mode: 'none', pid: null, port: null, url: null } }))
    api.harness.getSnapshot.mockImplementation(async () => ({ success: false, error: 'HARNESS_UNKNOWN_ERROR' }))

    expect(button('启动').className).toContain('btn--primary')
    const run = runCard()
    expect(run.querySelector('.harness-dot--stopped')).toBeTruthy()
    expect(within(run).getByText('已停止')).toBeTruthy()
    expect(within(run).queryByRole('button', { name: '重启' })).toBe(null)
    expect(within(run).queryByRole('button', { name: '停止' })).toBe(null)
    expect(rowLabels(run)).toEqual(['运行方式', '退出 CodePal 时一并停止'])
    expect(rowOf(run, '运行方式').textContent).toContain('由 CodePal 启动')

    fireEvent.click(within(rowOf(run, '退出 CodePal 时一并停止')).getByRole('switch'))
    await waitFor(() => expect(api.harness.setStopOnQuit).toHaveBeenCalledWith({ enabled: false }))
    await waitFor(() => expect(within(rowOf(runCard(), '退出 CodePal 时一并停止')).getByRole('switch').getAttribute('aria-checked')).toBe('false'))
    expect(within(runCard()).getByText('已停止')).toBeTruthy()
  })

  it('SC-014 启动超时显示错误 Toast', async () => {
    const { api } = await renderPage(managed({ runtime: { running: false, mode: 'none', pid: null, port: null, url: null } }), {
      start: vi.fn(async () => ({ success: false, error: 'HARNESS_START_TIMEOUT' })),
    })

    fireEvent.click(button('启动'))
    expect(await screen.findByText('启动超时，已停止本次尝试')).toBeTruthy()
    expect(api.harness.start).toHaveBeenCalledWith({})
    expect(document.querySelector('.toast--error')).toBeTruthy()
    expect(within(runCard()).getByText('已停止')).toBeTruthy()
    await waitFor(() => expect(button('启动').disabled).toBe(false))
  })

  // ── F-004 系统服务托管的实例 ────────────────────────────────────────

  it('SC-015 重启成功显示成功 Toast', async () => {
    const { api } = await renderPage(sourceRunning())

    fireEvent.click(button('重启', runCard()))
    expect(await screen.findByText('已重启，界面稍后可用')).toBeTruthy()
    expect(api.harness.restart).toHaveBeenCalledWith({})
    expect(document.querySelector('.toast--success')).toBeTruthy()
    const run = runCard()
    expect(within(run).getByText('运行中')).toBeTruthy()
    expect(rowOf(run, '运行方式').textContent).toContain('com.dsh.web')

    fireEvent.click(within(rowOf(run, '崩溃后自动重启')).getByRole('switch'))
    await waitFor(() => expect(api.harness.setKeepAlive).toHaveBeenCalledWith({ enabled: false }))
  })

  it('SC-016 重启中只锁重启按钮', async () => {
    const pending = deferred()
    const { api } = await renderPage(sourceRunning(), { restart: vi.fn(() => pending.promise) })

    fireEvent.click(button('重启', runCard()))
    await waitFor(() => expect(button('重启', runCard()).disabled).toBe(true))
    expect(api.harness.restart).toHaveBeenCalledWith({})
    expect(button('重启', runCard()).className).toContain('btn--loading')
    expect(button('停止', runCard()).disabled).toBe(false)
    expect(button('打开界面').disabled).toBe(false)
    expect(button('刷新').disabled).toBe(false)
    expect(rowOf(installCard(), '更新')).toBeTruthy()
    fireEvent.click(button('停止', runCard()))
    await waitFor(() => expect(api.harness.stop).toHaveBeenCalledWith({}))
    await act(async () => { pending.resolve({ success: true, data: { snapshot: sourceRunning() } }) })
  })

  it('SC-017 系统服务已停止仍识别源码目录', async () => {
    const { api } = await renderPage(sourceRunning({ runtime: { running: false, mode: 'none', pid: null, port: null, url: null } }))

    expect(button('启动').className).toContain('btn--primary')
    const run = runCard()
    expect(within(run).getByText('已停止')).toBeTruthy()
    expect(within(run).queryByRole('button', { name: '重启' })).toBe(null)
    expect(rowLabels(run)).toEqual(['运行方式', '崩溃后自动重启'])
    expect(rowOf(run, '运行方式').textContent).toContain('com.dsh.web')
    expect(within(rowOf(installCard(), '位置')).getByText('源码目录')).toBeTruthy()
    expect(installCard().querySelector('.harness-panel__meta').textContent).toBe(PREVIEW)
    expect(pageText()).not.toContain('未安装')

    fireEvent.click(within(rowOf(run, '崩溃后自动重启')).getByRole('switch'))
    await waitFor(() => expect(api.harness.setKeepAlive).toHaveBeenCalledWith({ enabled: false }))
  })

  it('SC-018 长路径长分支名长服务名按规则省略', async () => {
    const longDir = `${HOME}/Documents/Codex/2026-08-13/workspaces/deepseek/harness/checkouts/https-github-com-deepseek-ai-deepseek-harness-monorepo`
    await renderPage(sourceRunning({
      install: { ...SOURCE_INSTALL, sourceDir: longDir },
      supervisor: { ...LAUNCHD, label: 'com.deepseek.harness.web.development-profile' },
      runtime: { ...LAUNCHD_RUNNING, port: 49152, pid: 1284093, url: 'http://127.0.0.1:49152/?token=secret-once' },
      source: { ...SOURCE_BLOCKED, branch: 'feature/web-profile-refactor-with-a-very-long-branch-name-2026-09' },
    }))

    const location = rowOf(installCard(), '位置').querySelector('.harness-path')
    const display = '~/Documents/Codex/2026-08-13/workspaces/deepseek/harness/checkouts/https-github-com-deepseek-ai-deepseek-harness-monorepo'
    expect(location.getAttribute('title')).toBe(display)
    expect(location.querySelector('.harness-path__head').textContent).toBe('~/Documents/Codex/2026-08-13/workspaces/deepseek/harness/checkouts')
    expect(location.querySelector('.harness-path__tail').textContent).toBe('/https-github-com-deepseek-ai-deepseek-harness-monorepo')
    const branch = rowOf(installCard(), '分支')
    expect(branch.querySelector('.harness-mono:not(.harness-mono--keep)').textContent).toBe('feature/web-profile-refactor-with-a-very-long-branch-name-2026-09')
    expect(branch.querySelector('.harness-mono--keep').textContent).toBe('fb2c4b9e69')
    expect(rowOf(runCard(), 'PID').querySelector('.harness-mono').textContent).toBe('1284093')
    expect(button('停止', runCard()).closest('.harness-panel__actions')).toBeTruthy()
  })

  // ── F-005 源码目录的更新 ────────────────────────────────────────────

  it('SC-019 源码版有新提交给出更新', async () => {
    const { api } = await renderPage(sourceRunning({ source: SOURCE_MAIN }))

    const update = rowOf(installCard(), '更新')
    expect(within(update).getByText('有 12 个新提交')).toBeTruthy()
    expect(update.textContent).toContain('快进合并后重新构建，失败会自动回滚')
    expect(within(update).queryByRole('button', { name: '转为托管' })).toBe(null)
    fireEvent.click(button('更新', update))
    await waitFor(() => expect(api.harness.update).toHaveBeenCalledWith({}))
  })

  it('SC-020 源码版已是最新', async () => {
    await renderPage(sourceRunning({ source: { ...SOURCE_MAIN, commit: '9b07d51e3a', behind: 0 } }))

    const update = rowOf(installCard(), '更新')
    expect(update.textContent).toBe('更新已是最新')
    expect(within(update).queryByRole('button')).toBe(null)
    expect(update.querySelector('.harness-row__note')).toBe(null)
  })

  it('SC-021 源码版无法检查远端', async () => {
    await renderPage(sourceRunning({ source: { ...SOURCE_MAIN, behind: null } }))

    const update = rowOf(installCard(), '更新')
    expect(within(update).getByText('暂时无法检查远端')).toBeTruthy()
    expect(update.textContent).toContain('拉取远端失败，网络恢复后点「刷新」重试')
    expect(within(update).queryByRole('button')).toBe(null)
  })

  it('SC-022 源码版本地有改动时更新禁用并给转为托管', async () => {
    await renderPage(sourceRunning({ source: { ...SOURCE_MAIN, dirty: 3 } }))

    const update = rowOf(installCard(), '更新')
    expect(within(update).getByText('有 12 个新提交')).toBeTruthy()
    expect(button('更新', update).disabled).toBe(true)
    expect(button('转为托管', update).disabled).toBe(false)
    expect(update.textContent).toContain('3 个文件有未提交的改动，先提交或暂存才能更新；也可以转为托管，源码保持原样')
  })

  // ── F-006 转为 CodePal 托管 ─────────────────────────────────────────

  it('SC-023 转为托管确认弹窗说清保留与恢复', async () => {
    const { api } = await renderPage(sourceRunning())

    fireEvent.click(button('转为托管', installCard()))
    let dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('交给 CodePal 管理')).toBeTruthy()
    expect(dialog.textContent).toContain('CodePal 会另装一份托管运行时，再把系统服务切换过去。源码目录保持原样，不会被提交、暂存或删除。')
    const items = [...dialog.querySelectorAll('li')].map((item) => item.textContent)
    expect(items).toEqual([
      '保留 ~/.dsh 里的会话、凭证和模型配置',
      `只安装不低于 ${PREVIEW} 的版本，不会降级`,
      '先备份 launchd 启动项，切换失败自动恢复原服务',
    ])
    expect(api.harness.update).not.toHaveBeenCalled()

    fireEvent.click(button('取消', dialog))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBe(null))

    fireEvent.click(button('转为托管', installCard()))
    dialog = await screen.findByRole('dialog')
    fireEvent.click(button('确认接管', dialog))
    await waitFor(() => expect(api.harness.update).toHaveBeenCalledWith({ takeover: true }))
  })

  // ── F-007 托管版更新与通道 ──────────────────────────────────────────

  it('SC-024 托管版预览通道有新版本给出升级', async () => {
    const { api } = await renderPage(managed({ registry: { upgradeTargets: { latest: null, next: PREVIEW } } }))

    fireEvent.click(within(rowOf(installCard(), '更新通道')).getByRole('button', { name: `预览 ${PREVIEW}` }))
    const channels = within(rowOf(installCard(), '更新通道'))
    await waitFor(() => expect(channels.getByRole('button', { name: `预览 ${PREVIEW}` }).className).toContain('is-active'))
    const update = rowOf(installCard(), '更新')
    expect(within(update).getByText(PREVIEW)).toBeTruthy()
    expect(within(update).getByText('新版本').className).toContain('tag--info')
    expect(button('升级', update).className).toContain('btn--secondary')
    expect(document.querySelectorAll('.btn--primary')).toHaveLength(1)
    expect(button('打开界面').className).toContain('btn--primary')

    fireEvent.click(button('升级', update))
    await waitFor(() => expect(api.harness.install).toHaveBeenCalledWith({ channel: 'next', force: true }))
  })

  it('SC-025 npm 不可达时说明查不到新版本', async () => {
    await renderPage(managed({ registry: { ok: false, channels: { latest: null, next: null }, upgradeTargets: { latest: null, next: null } } }))

    const channels = within(rowOf(installCard(), '更新通道'))
    expect(channels.getAllByRole('button').map((chip) => chip.textContent)).toEqual(['稳定', '预览'])
    const update = rowOf(installCard(), '更新')
    expect(within(update).getByText('暂时查不到新版本')).toBeTruthy()
    expect(update.textContent).toContain('连不上 npm，点「刷新」重试；启动和停止不受影响')
    expect(button('重启', runCard()).disabled).toBe(false)
    expect(button('停止', runCard()).disabled).toBe(false)
  })

  it('SC-026 选中通道比当前旧时不提供降级', async () => {
    await renderPage(managed({ install: { ...MANAGED_INSTALL, version: PREVIEW, managedVersion: PREVIEW } }))

    expect(installCard().querySelector('.harness-panel__meta').textContent).toBe(PREVIEW)
    const update = rowOf(installCard(), '更新')
    expect(within(update).getByText('已是最新')).toBeTruthy()
    expect(update.textContent).toContain(`稳定通道目前是 ${STABLE}，比当前版本旧，不提供降级`)
    expect(screen.queryByRole('button', { name: '重装' })).toBe(null)
    expect(screen.queryByRole('button', { name: '升级' })).toBe(null)
  })

  // ── F-008 不归 CodePal 管的实例 ────────────────────────────────────

  it('SC-027 PATH 版终端手动启动只能打开', async () => {
    const { container } = await renderPage(snapshot({
      install: PATH_INSTALL,
      runtime: { running: true, mode: 'external', pid: 51877, port: 3080, url: 'http://127.0.0.1:3080/?token=secret-once', processes: 1 },
    }))

    expect(headerButtons(container)).toEqual(['打开界面', '刷新'])
    const run = runCard()
    expect(within(run).queryByRole('button', { name: '重启' })).toBe(null)
    expect(within(run).queryByRole('button', { name: '停止' })).toBe(null)
    expect(rowOf(run, '运行方式').textContent).toContain('终端手动启动')
    expect(rowOf(run, '运行方式').textContent).toContain('CodePal 只能打开它，不能停止或重启')

    const install = installCard()
    expect(install.querySelector('.harness-panel__meta')).toBe(null)
    expect(rowLabels(install)).toEqual(['位置', '更新'])
    expect(rowOf(install, '位置').textContent).toContain('/opt/homebrew/bin/dsh')
    expect(within(rowOf(install, '位置')).getByText('PATH')).toBeTruthy()
    expect(rowOf(install, '更新').textContent).toContain('用你原来的安装方式更新')
    expect(rowOf(install, '更新').textContent).toContain('更新后回到这里点「刷新」')
  })

  it('SC-029 PATH 版无法启动时不提供启动', async () => {
    const { container } = await renderPage(snapshot({ install: PATH_INSTALL }))

    expect(headerButtons(container)).toEqual(['刷新'])
    const run = runCard()
    expect(run.querySelector('.harness-dot--stopped')).toBeTruthy()
    expect(within(run).getByText('已停止')).toBeTruthy()
    expect(within(run).queryByRole('button')).toBe(null)
    expect(rowLabels(run)).toEqual(['运行方式'])
    expect(rowOf(run, '运行方式').textContent).toContain('由你自己启动')
    expect(rowOf(run, '运行方式').textContent).toContain('CodePal 不能启动 PATH 上的 dsh，用你原来的方式启动后回到这里点「刷新」')

    const install = installCard()
    expect(install.querySelector('.harness-panel__meta')).toBe(null)
    expect(rowLabels(install)).toEqual(['位置', '更新'])
    expect(within(rowOf(install, '位置')).getByText('PATH')).toBeTruthy()
    expect(rowOf(install, '更新').textContent).toContain('用你原来的安装方式更新')
  })

  it('SC-030 终端运行的源码版只能打开', async () => {
    const { container } = await renderPage(sourceRunning({
      supervisor: { kind: 'none', label: null, keepAlive: null },
      runtime: { running: true, mode: 'external', pid: 51877, port: 3080, url: 'http://127.0.0.1:3080/?token=secret-once', processes: 1 },
    }))

    expect(headerButtons(container)).toEqual(['打开界面', '刷新'])
    const run = runCard()
    expect(within(run).getByText('运行中')).toBeTruthy()
    expect(within(run).queryByRole('button', { name: '重启' })).toBe(null)
    expect(within(run).queryByRole('button', { name: '停止' })).toBe(null)
    expect(rowLabels(run)).toEqual(['访问地址', 'PID', '运行方式'])
    expect(rowOf(run, '访问地址').textContent).toContain('http://127.0.0.1:3080')
    expect(rowOf(run, 'PID').textContent).toContain('51877')
    expect(rowOf(run, '运行方式').textContent).toContain('终端手动启动')
    expect(rowOf(run, '运行方式').textContent).toContain('CodePal 只能打开它，不能停止或重启')

    const install = installCard()
    expect(rowLabels(install)).toEqual(['位置', '分支', '更新'])
    expect(within(rowOf(install, '位置')).getByText('源码目录')).toBeTruthy()
    const update = rowOf(install, '更新')
    expect(within(update).getByText('无法自动更新')).toBeTruthy()
    expect(update.textContent).toContain('本地分支在远端没有对应分支，origin/master 已领先 139 个提交')
    expect(screen.queryByRole('button', { name: '转为托管' })).toBe(null)
    expect(screen.queryByRole('button', { name: '卸载' })).toBe(null)
  })

  // ── F-009 卸载 ──────────────────────────────────────────────────────

  it('SC-028 卸载确认弹窗默认不清除数据', async () => {
    const { api } = await renderPage(sourceRunning())

    fireEvent.click(button('卸载', installCard()))
    let dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('卸载 DeepSeek Harness')).toBeTruthy()
    expect(dialog.textContent).toContain('会先停止它，再移除 CodePal 识别到的启动项。')
    expect([...dialog.querySelectorAll('li')].map((item) => item.textContent)).toEqual([
      '启动项原文件先备份，需要时可以手动恢复',
      '源码目录不会删除',
    ])
    expect(dialog.textContent).toContain('同时清除 ~/.dsh')
    expect(dialog.textContent).toContain('会话历史、凭证和模型配置会一起删除，不可恢复')
    expect(dialog.querySelector('.checkbox').className).not.toContain('checked')
    expect(button('取消', dialog)).toBeTruthy()
    expect(button('确认卸载', dialog).className).toContain('btn--danger')

    fireEvent.click(button('确认卸载', dialog))
    await waitFor(() => expect(api.harness.uninstall).toHaveBeenCalledWith({ purgeData: false }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBe(null))

    fireEvent.click(button('卸载', installCard()))
    dialog = await screen.findByRole('dialog')
    const purge = within(dialog).getByRole('checkbox', { name: /同时清除/ })
    expect(purge.getAttribute('aria-checked')).toBe('false')
    expect(purge.tabIndex).toBe(0)
    fireEvent.keyDown(purge, { key: ' ' })
    expect(purge.getAttribute('aria-checked')).toBe('true')
    fireEvent.keyDown(purge, { key: 'Enter' })
    expect(purge.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(dialog.querySelector('.harness-purge'))
    expect(dialog.querySelector('.checkbox').className).toContain('checked')
    fireEvent.click(button('确认卸载', dialog))
    await waitFor(() => expect(api.harness.uninstall).toHaveBeenLastCalledWith({ purgeData: true }))

    cleanup()
    await renderPage(managed())
    fireEvent.click(button('卸载', installCard()))
    dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('将删除 CodePal 安装的 DeepSeek Harness，运行中的实例会先被停止。')
    expect(dialog.textContent).not.toContain('源码目录')
    expect(dialog.querySelector('.harness-purge')).toBeTruthy()
  })
})
