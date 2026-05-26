/**
 * 模块 D · US-02 新账号登录闭环 单元测试
 *
 * 覆盖：
 * - beginLogin 创建 anon-<ts> 目录 + 5 个 symlinks
 * - watcher 监听到 auth.json 出现时 emit 'auth-captured'
 * - finalizeLogin 把 anon-<ts> atomic rename 为用户输入的名字
 * - cancelLogin 清理 anon 目录
 * - 边界：非法名 / 重名 / auth 未就位 / login-timeout
 *
 * @module 自动化测试/V1.7/moduleD-scheduling/codexLoginCaptureV17.test
 */

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')

const { makeIsolatedRoot, buildV17, makeFakeAuth } = require('../setup/testEnv')
const accountService = require('../../../electron/services/codexAccountService')
const { CodexLoginCaptureV17 } = require('../../../electron/services/codexLoginCaptureV17')

describe('模块 D · US-02 codexLoginCaptureV17', () => {
  let env
  let restore
  let capture

  beforeEach(async () => {
    env = makeIsolatedRoot()
    restore = env.apply()
    // 准备 shared/.codex/ 让 buildAccountDir 能建必建 symlinks
    await fsp.mkdir(env.sharedCodexDir, { recursive: true })
    for (const d of ['skills', 'sessions', 'logs']) {
      await fsp.mkdir(path.join(env.sharedCodexDir, d), { recursive: true })
    }
  })

  afterEach(async () => {
    if (capture) {
      // 关掉所有 watcher / 子进程
      for (const sid of Array.from(capture._sessions.keys())) {
        await capture.cancelLogin(sid).catch(() => {})
      }
      capture = null
    }
    restore?.()
    await env.cleanup()
  })

  test('beginLogin 创建 anon-<ts> 目录 + 必建 symlinks + 暂无 auth.json', async () => {
    capture = new CodexLoginCaptureV17({
      // 测试注入：替换 spawn 不真启动 codex
      spawnFn: () => ({ on() {}, kill() {} }),
      // 测试注入：替换 watcher，不依赖 chokidar/fs.watch
      watchFn: () => ({ close() {} }),
      timeoutMs: 60_000,
      logger: { info() {}, warn() {} },
    })
    const result = await capture.beginLogin()
    expect(result.ok).toBe(true)
    expect(result.sessionId).toMatch(/^s\d+/)
    expect(result.anonName).toMatch(/^anon-\d+/)
    expect(result.codexHome).toBe(path.join(env.switcherDir, 'accounts', result.anonName, '.codex'))

    expect(fs.statSync(result.codexHome).isDirectory()).toBe(true)
    // 必建 symlinks 都建好
    for (const name of ['skills', 'sessions', 'logs']) {
      expect(fs.lstatSync(path.join(result.codexHome, name)).isSymbolicLink()).toBe(true)
    }
    // auth.json 应该不存在（占位 auth 已被删，等 codex login 写入）
    expect(fs.existsSync(path.join(result.codexHome, 'auth.json'))).toBe(false)
  })

  test('watcher 触发 → emit auth-captured', async () => {
    let watcherCallback = null
    capture = new CodexLoginCaptureV17({
      spawnFn: () => ({ on() {}, kill() {} }),
      watchFn: (authPath, onAdd) => {
        watcherCallback = onAdd
        return { close() {} }
      },
      timeoutMs: 60_000,
      logger: { info() {}, warn() {} },
    })
    const captured = []
    capture.on('auth-captured', (payload) => captured.push(payload))

    const { sessionId, anonName, codexHome } = await capture.beginLogin()

    // 模拟 codex login 写出 auth.json
    await fsp.writeFile(path.join(codexHome, 'auth.json'), JSON.stringify(makeFakeAuth({ accountId: 'fresh' })))

    // 触发 watcher
    watcherCallback()

    expect(captured.length).toBe(1)
    expect(captured[0].sessionId).toBe(sessionId)
    expect(captured[0].anonName).toBe(anonName)
  })

  test('finalizeLogin 把 anon-<ts> atomic rename 为指定名字 + 不动 active.json（D12）', async () => {
    capture = new CodexLoginCaptureV17({
      spawnFn: () => ({ on() {}, kill() {} }),
      watchFn: () => ({ close() {} }),
      timeoutMs: 60_000,
      logger: { info() {}, warn() {} },
    })
    const { sessionId, anonName, codexHome } = await capture.beginLogin()
    // 模拟 auth.json 已就位
    await fsp.writeFile(path.join(codexHome, 'auth.json'), JSON.stringify(makeFakeAuth({ accountId: 'fresh' })))

    // D12：记录 finalize 前 active.json 状态，断言 finalize 不改它
    const activeBefore = await accountService.readActiveJsonV17()

    const result = await capture.finalizeLogin(sessionId, 'my-work')
    expect(result.ok).toBe(true)
    expect(result.name).toBe('my-work')

    // anon 目录已不存在
    expect(fs.existsSync(path.join(env.switcherDir, 'accounts', anonName))).toBe(false)
    // my-work 目录就位
    expect(fs.existsSync(path.join(env.switcherDir, 'accounts', 'my-work', '.codex', 'auth.json'))).toBe(true)
    // D12：active.json 指针保持不变（新增 ≠ 切换）
    const activeAfter = await accountService.readActiveJsonV17()
    expect(activeAfter.currentAccount).toBe(activeBefore.currentAccount)
  })

  test('finalizeLogin 非法名 → INVALID_NAME，不动 anon', async () => {
    capture = new CodexLoginCaptureV17({
      spawnFn: () => ({ on() {}, kill() {} }),
      watchFn: () => ({ close() {} }),
      timeoutMs: 60_000,
      logger: { info() {}, warn() {} },
    })
    const { sessionId, anonName, codexHome } = await capture.beginLogin()
    await fsp.writeFile(path.join(codexHome, 'auth.json'), JSON.stringify(makeFakeAuth({ accountId: 'a' })))

    const result = await capture.finalizeLogin(sessionId, '../../etc/passwd')
    expect(result.ok).toBe(false)
    expect(result.code).toBe('INVALID_NAME')
    expect(fs.existsSync(path.join(env.switcherDir, 'accounts', anonName))).toBe(true)
  })

  test('finalizeLogin 同名已存在 → NAME_EXISTS', async () => {
    capture = new CodexLoginCaptureV17({
      spawnFn: () => ({ on() {}, kill() {} }),
      watchFn: () => ({ close() {} }),
      timeoutMs: 60_000,
      logger: { info() {}, warn() {} },
    })
    // 预先建一个 my-work 账号
    await buildV17(env, {
      accounts: [{ name: 'my-work', auth: makeFakeAuth({ accountId: 'existing' }) }],
    })

    const { sessionId, codexHome } = await capture.beginLogin()
    await fsp.writeFile(path.join(codexHome, 'auth.json'), JSON.stringify(makeFakeAuth({ accountId: 'a' })))

    const result = await capture.finalizeLogin(sessionId, 'my-work')
    expect(result.ok).toBe(false)
    expect(result.code).toBe('NAME_EXISTS')
  })

  test('finalizeLogin auth.json 未就位 → AUTH_MISSING', async () => {
    capture = new CodexLoginCaptureV17({
      spawnFn: () => ({ on() {}, kill() {} }),
      watchFn: () => ({ close() {} }),
      timeoutMs: 60_000,
      logger: { info() {}, warn() {} },
    })
    const { sessionId } = await capture.beginLogin()
    // 故意不写 auth.json
    const result = await capture.finalizeLogin(sessionId, 'no-auth')
    expect(result.ok).toBe(false)
    expect(result.code).toBe('AUTH_MISSING')
  })

  test('cancelLogin 清理 anon 目录', async () => {
    capture = new CodexLoginCaptureV17({
      spawnFn: () => ({ on() {}, kill() {} }),
      watchFn: () => ({ close() {} }),
      timeoutMs: 60_000,
      logger: { info() {}, warn() {} },
    })
    const { sessionId, anonName } = await capture.beginLogin()
    expect(fs.existsSync(path.join(env.switcherDir, 'accounts', anonName))).toBe(true)

    await capture.cancelLogin(sessionId)
    // 给 rm 一些时间
    await new Promise((r) => setTimeout(r, 50))
    expect(fs.existsSync(path.join(env.switcherDir, 'accounts', anonName))).toBe(false)
  })

  test('login-timeout：5min（这里 100ms）未捕获 auth.json → 自动 abort + 清理', async () => {
    capture = new CodexLoginCaptureV17({
      spawnFn: () => ({ on() {}, kill() {} }),
      watchFn: () => ({ close() {} }),
      timeoutMs: 100,
      logger: { info() {}, warn() {} },
    })
    const events = []
    capture.on('login-aborted', (payload) => events.push(payload))

    const { sessionId, anonName } = await capture.beginLogin()
    // 故意不模拟 auth.json 出现
    await new Promise((r) => setTimeout(r, 200))
    expect(events.length).toBe(1)
    expect(events[0].sessionId).toBe(sessionId)
    expect(events[0].reason).toBe('login-timeout')
    // 清理掉 anon
    await new Promise((r) => setTimeout(r, 50))
    expect(fs.existsSync(path.join(env.switcherDir, 'accounts', anonName))).toBe(false)
  }, 3000)
})
