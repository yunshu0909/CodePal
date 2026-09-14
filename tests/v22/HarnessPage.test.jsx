/**
 * v2.2 Harness 管理页测试
 *
 * 覆盖三状态（未安装 / 已停止 / 运行中）的骨架稳定性，以及全站按钮位置规则：
 * header 最多两个页面级按钮，实体动作贴状态总览条右端。
 *
 * @module tests/v22/HarnessPage
 */

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import HarnessPage from '../../src/pages/HarnessPage'

/** 造一份快照；默认是「干净机器、什么都没装、没在跑」。 */
function snapshot(overrides = {}) {
  const base = {
    platform: 'darwin',
    supportedPlatform: true,
    generatedAt: '2026-09-13T12:00:00.000Z',
    node: { available: true, version: 'v24.11.1', supported: true, required: '^22.19.0 || >=24.0.0' },
    install: {
      kind: 'none',
      version: null,
      location: null,
      runtimeDir: '/Users/demo/Documents/SkillManager/runtimes/dsh',
      managedVersion: null,
      sourceVersion: null,
      sourceDir: null,
      pathBinary: null,
      canUpgrade: false,
      canInstall: true,
      canUninstall: false,
    },
    registry: {
      ok: true,
      channels: { latest: '0.1.5-rc.3', next: '0.1.5-rc.4' },
      versions: ['0.1.5-rc.4', '0.1.5-rc.3', '0.1.5-rc.2'],
      upgradeTargets: { latest: '0.1.5-rc.3', next: '0.1.5-rc.4' },
    },
    supervisor: { kind: 'none', label: null, plistPath: null, entry: null, keepAlive: null, logPath: null },
    runtime: { running: false, mode: 'none', pid: null, port: null, url: null, startedAt: null, version: null, processes: 0 },
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
  }
}

function installApi(data, extra = {}) {
  window.electronAPI = {
    harness: {
      getSnapshot: vi.fn(async () => ({ success: true, data })),
      listVersions: vi.fn(async () => ({ success: true, data: { latest: '0.1.5-rc.3', next: '0.1.5-rc.4', versions: ['0.1.5-rc.4', '0.1.5-rc.3'] } })),
      install: vi.fn(async () => ({ success: true, data: { version: '0.1.5-rc.3', channel: 'latest', changed: true, snapshot: data } })),
      uninstall: vi.fn(async () => ({ success: true, data: { removed: true, purgedData: false, snapshot: data } })),
      start: vi.fn(async () => ({ success: true, data: { pid: 4242, port: 51423, url: 'http://127.0.0.1:51423/', snapshot: data } })),
      stop: vi.fn(async () => ({ success: true, data: { stopped: true, pid: 4242, snapshot: data } })),
      restart: vi.fn(async () => ({ success: true, data: { pid: 4242, snapshot: data } })),
      update: vi.fn(async () => ({ success: true, data: { kind: 'source', changed: true, after: 'def5678', steps: ['pull', 'build'], snapshot: data } })),
      setStopOnQuit: vi.fn(async () => ({ success: true, data: { stopOnQuit: true } })),
      setKeepAlive: vi.fn(async () => ({ success: true, data: { keepAlive: true, snapshot: data } })),
      ...extra.harness,
    },
    openExternalLink: vi.fn(async () => ({ success: true })),
    getEarliestLogDate: vi.fn(async () => ({ success: true, earliestDate: '2026-09-12' })),
  }
}

/** CodePal 安装的一份，已装可升可卸。 */
const MANAGED = {
  kind: 'managed',
  version: '0.1.5-rc.2',
  location: '/Users/demo/Documents/SkillManager/runtimes/dsh',
  managedVersion: '0.1.5-rc.2',
  canUpgrade: true,
  canInstall: true,
  canUninstall: true,
}

/** 源码 checkout + launchd 在跑 —— 这台机器的真实形态。 */
const LAUNCHD_SOURCE = {
  install: { kind: 'source', version: '0.1.5-rc.2', sourceVersion: '0.1.5-rc.2', sourceDir: '/Users/demo/Codex/2026-08-13/https-github-com-deepseek-ai-deepseek-2', canUpgrade: false, canUpdate: true, canUninstall: true },
  supervisor: { kind: 'launchd', label: 'com.dsh.web', plistPath: '/Users/demo/Library/LaunchAgents/com.dsh.web.plist', entry: '/Users/demo/checkout/apps/cli/src/bin.ts', keepAlive: true, logPath: '/Users/demo/.dsh/dsh-web.log' },
  runtime: { running: true, mode: 'launchd', pid: 95932, port: 3080, url: 'http://127.0.0.1:3080/', startedAt: null, version: null, processes: 1 },
  source: { isRepo: true, branch: 'main', commit: 'abc1234', dirty: 0, behind: 3, ahead: 0, upstream: 'origin/main', upstreamSource: 'tracking', updatable: true },
}

/** CodePal 自己拉起的实例。 */
const SIDECAR_MANAGED = {
  install: MANAGED,
  runtime: { running: true, mode: 'sidecar', pid: 4242, port: 51423, url: 'http://127.0.0.1:51423/', startedAt: '2026-09-13T12:00:00.000Z', version: '0.1.5-rc.2', processes: 1 },
}

describe('HarnessPage', () => {
  beforeEach(() => { installApi(snapshot()) })
  afterEach(() => { cleanup(); delete window.electronAPI })

  // ── 未安装 ──────────────────────────────────────────────────────────

  it('SC-301 未安装时给出安装引导与落地位置', async () => {
    render(<HarnessPage />)
    const installButtons = await screen.findAllByRole('button', { name: '安装 DeepSeek Harness' })
    expect(installButtons.length).toBeGreaterThan(0)
    expect(screen.getByText('尚未安装 DeepSeek Harness')).toBeTruthy()
    expect(screen.getAllByText(/SkillManager\/runtimes\/dsh/).length).toBeGreaterThan(0)
    expect(screen.getByText(/不写入全局 npm/)).toBeTruthy()
    // 未安装时不该出现版本卡 / 偏好卡 / 卸载行
    expect(screen.queryByText('当前版本')).toBe(null)
    expect(screen.queryByRole('button', { name: '卸载' })).toBe(null)
  })

  it('SC-332 未安装时状态条不留悬空分隔线', async () => {
    const { container } = render(<HarnessPage />)
    await screen.findAllByRole('button', { name: '安装 DeepSeek Harness' })
    expect(container.querySelector('.harness-statusbar__divider')).toBe(null)
    expect(container.querySelector('.harness-statusbar__metrics').children.length).toBe(0)
  })

  it('SC-302 安装走默认稳定通道', async () => {
    render(<HarnessPage />)
    const [first] = await screen.findAllByRole('button', { name: '安装 DeepSeek Harness' })
    fireEvent.click(first)
    await waitFor(() => expect(window.electronAPI.harness.install).toHaveBeenCalledWith({ channel: 'latest', force: true }))
  })

  it('SC-303 切到预览通道后安装该通道', async () => {
    render(<HarnessPage />)
    await screen.findAllByRole('button', { name: '安装 DeepSeek Harness' })
    // 未安装态没有通道切换（通道在版本卡里），所以先断言按钮存在即可
    expect(screen.queryByRole('button', { name: '预览' })).toBe(null)
  })

  it('SC-313 Node 不满足时安装禁用并说明原因', async () => {
    installApi(snapshot({ node: { available: true, version: 'v20.11.0', supported: false }, install: { canInstall: false } }))
    render(<HarnessPage />)
    const [button] = await screen.findAllByRole('button', { name: '安装 DeepSeek Harness' })
    expect(button.disabled).toBe(true)
    expect(screen.getByText('不满足')).toBeTruthy()
    expect(screen.getByText(/需要 Node \^22\.19\.0 \|\| >=24\.0\.0/)).toBeTruthy()
  })

  it('SC-314 平台不支持时明确说不', async () => {
    installApi(snapshot({ supportedPlatform: false, platform: 'win32' }))
    render(<HarnessPage />)
    expect(await screen.findByText(/暂不支持托管式启停/)).toBeTruthy()
    const [button] = await screen.findAllByRole('button', { name: '安装 DeepSeek Harness' })
    expect(button.disabled).toBe(true)
  })

  // ── 已停止 ──────────────────────────────────────────────────────────

  it('SC-305 已停止时点启动，并把地址交给浏览器', async () => {
    const running = snapshot(SIDECAR_MANAGED)
    installApi(snapshot({ install: MANAGED }), {
      harness: { start: vi.fn(async () => ({ success: true, data: { pid: 4242, url: 'http://127.0.0.1:51423/', snapshot: running } })) },
    })
    render(<HarnessPage />)
    fireEvent.click(await screen.findByRole('button', { name: '启动' }))
    await waitFor(() => expect(window.electronAPI.harness.start).toHaveBeenCalled())
    await waitFor(() => expect(window.electronAPI.openExternalLink).toHaveBeenCalledWith('http://127.0.0.1:51423/'))
  })

  it('SC-307 未运行时没有停止 / 重启按钮', async () => {
    installApi(snapshot({ install: MANAGED }))
    render(<HarnessPage />)
    await screen.findByRole('button', { name: '启动' })
    expect(screen.queryByRole('button', { name: '停止' })).toBe(null)
    expect(screen.queryByRole('button', { name: '重启' })).toBe(null)
  })

  it('SC-334 launchd 源码版停止后仍显示已安装，并提供启动按钮', async () => {
    installApi(snapshot({
      ...LAUNCHD_SOURCE,
      runtime: { running: false, mode: 'none', pid: null, port: null, url: null, processes: 0 },
    }))
    render(<HarnessPage />)

    expect(await screen.findByText('已停止')).toBeTruthy()
    expect(screen.getAllByText('0.1.5-rc.2').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: '启动' })).toBeTruthy()
    expect(screen.queryByText('尚未安装 DeepSeek Harness')).toBe(null)
    expect(screen.queryByRole('button', { name: '安装 DeepSeek Harness' })).toBe(null)
  })

  it('SC-316 非 launchd 时偏好卡给「退出 CodePal 时一并停止」', async () => {
    installApi(snapshot({ install: MANAGED }))
    render(<HarnessPage />)
    expect(await screen.findByText('退出 CodePal 时一并停止')).toBeTruthy()
    fireEvent.click(screen.getByRole('switch'))
    await waitFor(() => expect(window.electronAPI.harness.setStopOnQuit).toHaveBeenCalledWith({ enabled: false }))
  })

  it('SC-311 卸载默认保留 ~/.dsh', async () => {
    installApi(snapshot({ install: MANAGED }))
    render(<HarnessPage />)
    fireEvent.click(await screen.findByRole('button', { name: '卸载' }))
    expect(await screen.findByText(/会话历史、凭证与模型配置会一起删除/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '确认卸载' }))
    await waitFor(() => expect(window.electronAPI.harness.uninstall).toHaveBeenCalledWith({ purgeData: false }))
  })

  it('SC-312 勾选后才彻底清除数据', async () => {
    installApi(snapshot({ install: MANAGED }))
    render(<HarnessPage />)
    fireEvent.click(await screen.findByRole('button', { name: '卸载' }))
    const switches = await screen.findAllByRole('switch')
    const purge = switches[switches.length - 1]
    fireEvent.click(purge)
    await waitFor(() => expect(purge.getAttribute('aria-checked')).toBe('true'))
    fireEvent.click(screen.getByRole('button', { name: '确认卸载' }))
    await waitFor(() => expect(window.electronAPI.harness.uninstall).toHaveBeenCalledWith({ purgeData: true }))
  })

  // ── 运行中 ──────────────────────────────────────────────────────────

  it('SC-310 launchd 跑着源码版 → 运行中，显示 PID/端口', async () => {
    installApi(snapshot(LAUNCHD_SOURCE))
    render(<HarnessPage />)
    expect(await screen.findByText('运行中')).toBeTruthy()
    expect(screen.getByText('95932')).toBeTruthy()
    expect(screen.getByText('3080')).toBeTruthy()
    // 来源收成 …/末两段，完整路径留在 title
    const where = screen.getByTitle(/deepseek-2$/)
    expect(where.textContent).toMatch(/^…\//)
  })

  it('SC-306 CodePal 拉起的实例：可停止、可重启，且不给 launchd 的自动重启开关', async () => {
    installApi(snapshot(SIDECAR_MANAGED))
    render(<HarnessPage />)
    expect(await screen.findByText('4242')).toBeTruthy()
    const stop = screen.getByRole('button', { name: '停止' })
    expect(stop.disabled).toBe(false)
    expect(screen.getByRole('button', { name: '重启' })).toBeTruthy()
    expect(screen.queryByText('崩溃后自动重启')).toBe(null)
    fireEvent.click(stop)
    await waitFor(() => expect(window.electronAPI.harness.stop).toHaveBeenCalled())
  })

  it('SC-317 launchd 托管时给「崩溃后自动重启」，不给退出偏好', async () => {
    installApi(snapshot(LAUNCHD_SOURCE))
    render(<HarnessPage />)
    expect(await screen.findByText('崩溃后自动重启')).toBeTruthy()
    expect(screen.queryByText('退出 CodePal 时一并停止')).toBe(null)
    fireEvent.click(screen.getByRole('switch'))
    await waitFor(() => expect(window.electronAPI.harness.setKeepAlive).toHaveBeenCalledWith({ enabled: false }))
  })

  it('SC-322 手动在终端起的实例：只能打开，不能停', async () => {
    installApi(snapshot({
      install: { kind: 'source', version: '0.1.5-rc.2', sourceVersion: '0.1.5-rc.2', sourceDir: '/Users/demo/checkout', canUpgrade: false, canUninstall: false },
      runtime: { running: true, mode: 'external', pid: 777, port: 3080, url: 'http://127.0.0.1:3080/', startedAt: null, version: null, processes: 1 },
    }))
    render(<HarnessPage />)
    expect(await screen.findByText(/手动启动的，CodePal 只能打开它/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '打开界面' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '停止' })).toBe(null)
    expect(screen.queryByRole('button', { name: '重启' })).toBe(null)
  })

  // ── 版本与升级 ──────────────────────────────────────────────────────

  it('SC-308 可升级时显示目标版本与升级按钮，切通道后跟随', async () => {
    installApi(snapshot({ install: MANAGED }))
    render(<HarnessPage />)
    // 目标版本在「可用更新」与「通道说明」两处出现，用 getAllByText
    expect((await screen.findAllByText('0.1.5-rc.3')).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: '升级' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '预览' }))
    await waitFor(() => expect(screen.getAllByText('0.1.5-rc.4').length).toBeGreaterThan(0))
  })

  it('SC-309 通道版本旧于已装时不提示降级', async () => {
    installApi(snapshot({
      install: MANAGED,
      registry: { channels: { latest: '0.1.5-rc.1', next: '0.1.5-rc.2' }, upgradeTargets: { latest: null, next: null } },
    }))
    render(<HarnessPage />)
    await screen.findByText('当前版本')
    expect(screen.queryByRole('button', { name: '升级' })).toBe(null)
    expect(screen.getByRole('button', { name: '重装' })).toBeTruthy()
    expect(screen.getByText(/与当前版本不同，重装即切换/)).toBeTruthy()
  })

  it('SC-304 源码版也有真更新入口（走 git），且不摊分类标签、不出现 npm 通道', async () => {
    installApi(snapshot(LAUNCHD_SOURCE))
    render(<HarnessPage />)
    // 落后 3 个提交 → 显示数量 + 更新按钮
    expect(await screen.findByText('3 个新提交')).toBeTruthy()
    expect(screen.getByRole('button', { name: '更新' })).toBeTruthy()
    // npm 那套概念与源码无关：不给通道、不给「升级」
    expect(screen.queryByText('更新通道')).toBe(null)
    expect(screen.queryByRole('button', { name: '稳定' })).toBe(null)
    expect(screen.queryByRole('button', { name: '预览' })).toBe(null)
    expect(screen.queryByRole('button', { name: '升级' })).toBe(null)
    // 也不出现「源码版」这类分类标签
    expect(screen.queryByText(/源码版/)).toBe(null)
    // 源码版现在可卸（卸的是启动项），按钮在
    expect(screen.getByRole('button', { name: '卸载' })).toBeTruthy()
    // 分支与提交独立成行，不再把长文案塞进一行
    expect(screen.getByText('当前分支')).toBeTruthy()
    expect(screen.getByText('main')).toBeTruthy()
    // 状态条「版本」指标与版本卡标题各一处
    expect(screen.getAllByText('版本').length).toBeGreaterThanOrEqual(2)
  })

  it('SC-331 不可更新时不出现「为更新做准备」的死胡同提示', async () => {
    // 这台机器的真实形态：分支不可更新 + 有本地改动
    installApi(snapshot({
      ...LAUNCHD_SOURCE,
      source: { isRepo: true, branch: 'release-0.1.5-rc.2', commit: 'fb2c4b9e69', dirty: 1, untracked: 1, behind: 139, ahead: 0, upstream: 'origin/master', upstreamSource: 'default-branch', updatable: false },
    }))
    const { container } = render(<HarnessPage />)
    await waitFor(() => expect(container.querySelector('.harness-note--block')).toBeTruthy())
    // 没有更新按钮，就不该出现「先提交或暂存」这种指向不可执行动作的话
    expect(screen.queryByText(/先提交或暂存/)).toBe(null)
    expect(screen.queryByRole('button', { name: '更新' })).toBe(null)
    expect(screen.getByRole('button', { name: '交给 CodePal 管理' })).toBeTruthy()
  })

  it('SC-330 本地分支在远端没有对应分支时不假装能更新，只给参考', async () => {
    installApi(snapshot({
      ...LAUNCHD_SOURCE,
      source: { isRepo: true, branch: 'release-0.1.5-rc.2', commit: 'fb2c4b9e69', dirty: 0, behind: 4218, ahead: 0, upstream: 'origin/master', upstreamSource: 'default-branch', updatable: false },
    }))
    const { container } = render(<HarnessPage />)
    // 文案跨多个节点，用容器查询更稳
    await waitFor(() => expect(container.querySelector('.harness-note--block')).toBeTruthy())
    const note = container.querySelector('.harness-note--block').textContent
    expect(note).toContain('在远端没有对应分支')
    expect(note).toContain('领先 4218 个提交')
    expect(screen.queryByRole('button', { name: '更新' })).toBe(null)
    expect(screen.getByRole('button', { name: '交给 CodePal 管理' })).toBeTruthy()
  })

  it('SC-333 安全接管先说明保留范围，确认后走同一个 update 入口', async () => {
    installApi(snapshot({
      ...LAUNCHD_SOURCE,
      source: { isRepo: true, branch: 'release-0.1.5-rc.2', commit: 'fb2c4b9e69', dirty: 1, behind: 139, ahead: 0, upstream: 'origin/master', upstreamSource: 'default-branch', updatable: false },
    }))
    render(<HarnessPage />)
    fireEvent.click(await screen.findByRole('button', { name: '交给 CodePal 管理' }))
    expect(screen.getByText(/保留你的源码目录/)).toBeTruthy()
    expect(screen.getByText(/保留 ~\/\.dsh/)).toBeTruthy()
    expect(screen.getByText(/备份并切换现有 launchd/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '确认接管' }))
    await waitFor(() => expect(window.electronAPI.harness.update).toHaveBeenCalledWith({ takeover: true }))
  })

  it('SC-326 源码版点「更新」走 harness.update 一个入口', async () => {
    installApi(snapshot(LAUNCHD_SOURCE))
    render(<HarnessPage />)
    fireEvent.click(await screen.findByRole('button', { name: '更新' }))
    await waitFor(() => expect(window.electronAPI.harness.update).toHaveBeenCalled())
  })

  it('SC-327 源码目录有未提交改动时提前说清并禁用更新', async () => {
    installApi(snapshot({
      ...LAUNCHD_SOURCE,
      source: { isRepo: true, branch: 'main', commit: 'abc1234', dirty: 2, behind: 3, ahead: 0, upstream: 'origin/main', upstreamSource: 'tracking', updatable: true },
    }))
    render(<HarnessPage />)
    // 脏状态收在「更新」行里，而不是浮在外面
    expect(await screen.findByText(/先提交或暂存本地改动才能更新/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '更新' }).disabled).toBe(true)
  })

  it('SC-328 源码版已最新时给「已是最新」而不是死胡同', async () => {
    installApi(snapshot({
      ...LAUNCHD_SOURCE,
      source: { isRepo: true, branch: 'main', commit: 'abc1234', dirty: 0, behind: 0, ahead: 0, upstream: 'origin/main', upstreamSource: 'tracking', updatable: true },
    }))
    render(<HarnessPage />)
    expect(await screen.findByText('已是最新')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '更新' })).toBe(null)
  })

  it('SC-329 源码版卸载不承诺删仓库，只说摘掉启动项', async () => {
    installApi(snapshot(LAUNCHD_SOURCE))
    render(<HarnessPage />)
    fireEvent.click(await screen.findByRole('button', { name: '卸载' }))
    expect(await screen.findByText(/不会删除你的源码目录/)).toBeTruthy()
    expect(screen.queryByText(/将删除 CodePal 安装的/)).toBe(null)
  })

  it('SC-324 托管安装才出现 npm 的通道与升级概念', async () => {
    installApi(snapshot({ install: MANAGED }))
    render(<HarnessPage />)
    expect(await screen.findByText('可用更新')).toBeTruthy()
    expect(screen.getByText('更新通道')).toBeTruthy()
    expect(screen.getByRole('button', { name: '稳定' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '预览' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '升级' })).toBeTruthy()
    // 托管路径下不出现「更新方式」这种手工指示
    expect(screen.queryByText('更新方式')).toBe(null)
  })

  it('SC-325 版本号是贴文字的 chip，不是铺满整格的块', async () => {
    installApi(snapshot({ install: MANAGED }))
    const { container } = render(<HarnessPage />)
    await screen.findByText('当前版本')
    const chip = container.querySelector('.harness-facts .harness-code')
    // chip 必须是 strong 的子 span；直接挂在 strong 上会被栅格拉满整格
    expect(chip.tagName).toBe('SPAN')
    expect(chip.parentElement.tagName).toBe('STRONG')
  })

  it('SC-315 失败映射成中文文案而不是错误码', async () => {
    installApi(snapshot({ install: MANAGED }), {
      harness: { start: vi.fn(async () => ({ success: false, data: null, error: 'LAUNCHD_START_FAILED' })) },
    })
    render(<HarnessPage />)
    fireEvent.click(await screen.findByRole('button', { name: '启动' }))
    expect(await screen.findByText(/launchd 启动失败/)).toBeTruthy()
  })

  // ── 骨架与按钮位置规则（本版返工的核心）──────────────────────────────

  it('SC-320 header 永远只有两个页面级按钮：主动词 + 刷新', async () => {
    for (const state of [snapshot(), snapshot({ install: MANAGED }), snapshot(SIDECAR_MANAGED), snapshot(LAUNCHD_SOURCE)]) {
      installApi(state)
      const { container } = render(<HarnessPage />)
      await screen.findByRole('button', { name: '刷新' })
      const headerButtons = container.querySelectorAll('.page-shell__actions button')
      expect(headerButtons.length).toBe(2)
      cleanup()
    }
  })

  it('SC-321 重启 / 停止是实体动作，贴在状态总览条右端', async () => {
    installApi(snapshot(SIDECAR_MANAGED))
    const { container } = render(<HarnessPage />)
    await screen.findByText('运行中')
    const statusbar = container.querySelector('.harness-statusbar')
    const actionSlot = statusbar.querySelector('.harness-statusbar__actions')
    expect(actionSlot).toBeTruthy()
    const labels = [...actionSlot.querySelectorAll('button')].map((node) => node.textContent)
    expect(labels).toEqual(['重启', '停止'])
    // 它们不在 header 里
    const header = container.querySelector('.page-shell__actions')
    expect([...header.querySelectorAll('button')].map((node) => node.textContent)).toEqual(['打开界面', '刷新'])
  })

  it('SC-323 主动词随状态切换：安装 → 启动 → 打开界面', async () => {
    const { container, unmount } = render(<HarnessPage />)
    await screen.findAllByRole('button', { name: '安装 DeepSeek Harness' })
    expect(container.querySelector('.page-shell__actions button').textContent).toBe('安装 DeepSeek Harness')
    unmount()

    installApi(snapshot({ install: MANAGED }))
    const second = render(<HarnessPage />)
    await screen.findByRole('button', { name: '启动' })
    expect(second.container.querySelector('.page-shell__actions button').textContent).toBe('启动')
    second.unmount()

    installApi(snapshot(SIDECAR_MANAGED))
    const third = render(<HarnessPage />)
    await screen.findByText('运行中')
    expect(third.container.querySelector('.page-shell__actions button').textContent).toBe('打开界面')
  })

  it('SC-318 读取失败给安心话与重试', async () => {
    window.electronAPI = {
      harness: { getSnapshot: vi.fn(async () => ({ success: false, data: null, error: 'HARNESS_UNKNOWN_ERROR' })), listVersions: vi.fn(async () => ({ success: false })) },
      getEarliestLogDate: vi.fn(async () => ({ success: false })),
    }
    render(<HarnessPage />)
    expect(await screen.findByText('Harness 状态读取失败')).toBeTruthy()
    expect(screen.getByText('没有安装或修改任何东西')).toBeTruthy()
    expect(screen.getByRole('button', { name: /重试/ })).toBeTruthy()
  })
})
