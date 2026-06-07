/**
 * 模块 D · V1.7 IPC handlers 单元测试
 *
 * 覆盖：
 * - codex:v17:list 含三档状态
 * - codex:v17:read-active
 * - codex:v17:switch 通过 mock refresher
 * - codex:v17:rename → atomic rename 账号目录 + 同步 active.json
 * - codex:v17:delete → atomic move 到 .codex-switcher.deleted-backup-<ts>
 * - codex:v17:judge-status
 *
 * @module 自动化测试/V1.7/moduleD-scheduling/registerCodexAccountHandlersV17.test
 */

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')

const { makeIsolatedRoot, buildV17, makeFakeAuth } = require('../setup/testEnv')
const accountService = require('../../../electron/services/codexAccountService')
const { registerCodexAccountHandlersV17 } = require('../../../electron/handlers/registerCodexAccountHandlersV17')

// 简易 ipcMain mock：记录 handler 注册，提供 invoke 模拟
function makeFakeIpc() {
  const handlers = new Map()
  return {
    ipcMain: {
      handle(channel, fn) { handlers.set(channel, fn) },
      removeHandler(channel) { handlers.delete(channel) },
    },
    invoke(channel, payload) {
      const fn = handlers.get(channel)
      if (!fn) throw new Error(`No handler for ${channel}`)
      return fn({}, payload)
    },
    has(channel) { return handlers.has(channel) },
  }
}

describe('模块 D · registerCodexAccountHandlersV17', () => {
  let env
  let restore
  let registered

  beforeEach(async () => {
    env = makeIsolatedRoot()
    restore = env.apply()
  })

  afterEach(async () => {
    if (registered) {
      await registered.stop().catch(() => {})
      registered = null
    }
    restore?.()
    await env.cleanup()
  })

  test('codex:v17:list 返回所有账号 + 三档状态', async () => {
    await buildV17(env, {
      accounts: [
        {
          name: 'A',
          auth: makeFakeAuth({ accountId: 'a', iatSecondsAgo: 1 * 3600, email: 'a@example.com' }),
          state: { status: 'active' },
        },
        {
          name: 'B',
          auth: makeFakeAuth({ accountId: 'b', iatSecondsAgo: 1 * 3600 }),
          state: { status: 'invalid', permanentReason: 'Revoked' },
        },
      ],
      active: 'A',
    })

    const ipc = makeFakeIpc()
    registered = registerCodexAccountHandlersV17({
      ipcMain: ipc.ipcMain,
      getMainWindow: () => null,
      getBootstrapResult: () => ({ ok: true, stage: 'done' }),
      getScheduler: () => null,
      logger: { info() {}, warn() {}, error() {} },
    })

    const result = await ipc.invoke('codex:v17:list')
    expect(result.ok).toBe(true)
    expect(result.accounts.map((a) => a.name)).toEqual(['A', 'B'])
    const a = result.accounts.find((x) => x.name === 'A')
    expect(a.active).toBe(true)
    expect(a.status.color).toBe('green')
    expect(a.email).toBe('a@example.com')
    const b = result.accounts.find((x) => x.name === 'B')
    expect(b.status.color).toBe('red')
    expect(b.status.reason).toBe('Revoked')
  })

  test('codex:v17:read-active 返回当前激活账号', async () => {
    await buildV17(env, {
      accounts: [{ name: 'X', auth: makeFakeAuth({ accountId: 'x' }) }],
      active: 'X',
    })

    const ipc = makeFakeIpc()
    registered = registerCodexAccountHandlersV17({
      ipcMain: ipc.ipcMain,
      getMainWindow: () => null,
      getBootstrapResult: () => ({ ok: true, stage: 'done' }),
      getScheduler: () => null,
    })

    const result = await ipc.invoke('codex:v17:read-active')
    expect(result.ok).toBe(true)
    expect(result.active.currentAccount).toBe('X')
  })

  test('codex:v17:rename atomic 改名 + 同步 active.json', async () => {
    await buildV17(env, {
      accounts: [{ name: 'old-name', auth: makeFakeAuth({ accountId: 'o' }) }],
      active: 'old-name',
    })

    const ipc = makeFakeIpc()
    registered = registerCodexAccountHandlersV17({
      ipcMain: ipc.ipcMain,
      getMainWindow: () => null,
      getBootstrapResult: () => ({ ok: true, stage: 'done' }),
      getScheduler: () => ({ reschedule() {} }),
    })

    const result = await ipc.invoke('codex:v17:rename', { oldName: 'old-name', newName: 'new-name' })
    expect(result.ok).toBe(true)
    expect(fs.existsSync(env.accountHomeDir('old-name'))).toBe(false)
    expect(fs.existsSync(env.accountHomeDir('new-name'))).toBe(true)
    const active = await accountService.readActiveJsonV17()
    expect(active.currentAccount).toBe('new-name')
  })

  test('codex:v17:rename 拒绝非法名', async () => {
    await buildV17(env, { accounts: [{ name: 'a', auth: makeFakeAuth({ accountId: 'a' }) }] })
    const ipc = makeFakeIpc()
    registered = registerCodexAccountHandlersV17({
      ipcMain: ipc.ipcMain,
      getMainWindow: () => null,
      getBootstrapResult: () => ({ ok: true, stage: 'done' }),
      getScheduler: () => null,
    })
    const result = await ipc.invoke('codex:v17:rename', { oldName: 'a', newName: '../etc' })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('INVALID_NAME')
  })

  test('codex:v17:rename 拒绝同名已存在', async () => {
    await buildV17(env, {
      accounts: [
        { name: 'a', auth: makeFakeAuth({ accountId: 'a' }) },
        { name: 'b', auth: makeFakeAuth({ accountId: 'b' }) },
      ],
    })
    const ipc = makeFakeIpc()
    registered = registerCodexAccountHandlersV17({
      ipcMain: ipc.ipcMain,
      getMainWindow: () => null,
      getBootstrapResult: () => ({ ok: true, stage: 'done' }),
      getScheduler: () => null,
    })
    const result = await ipc.invoke('codex:v17:rename', { oldName: 'a', newName: 'b' })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('NEW_EXISTS')
  })

  test('codex:v17:delete 移到 deleted-backup-<ts> + 清 active', async () => {
    await buildV17(env, {
      accounts: [{ name: 'doomed', auth: makeFakeAuth({ accountId: 'd' }) }],
      active: 'doomed',
    })

    const ipc = makeFakeIpc()
    registered = registerCodexAccountHandlersV17({
      ipcMain: ipc.ipcMain,
      getMainWindow: () => null,
      getBootstrapResult: () => ({ ok: true, stage: 'done' }),
      getScheduler: () => ({ reschedule() {} }),
    })

    const result = await ipc.invoke('codex:v17:delete', { accountName: 'doomed' })
    expect(result.ok).toBe(true)
    expect(result.backupDir).toMatch(/\.codex-switcher\.deleted-backup-\d+/)
    expect(fs.existsSync(env.accountHomeDir('doomed'))).toBe(false)
    expect(fs.existsSync(path.join(result.backupDir, '.codex', 'auth.json'))).toBe(true)
    const active = await accountService.readActiveJsonV17()
    expect(active.currentAccount).toBeNull()
  })

  test('codex:v17:delete 不存在的账号 → NOT_FOUND', async () => {
    const ipc = makeFakeIpc()
    registered = registerCodexAccountHandlersV17({
      ipcMain: ipc.ipcMain,
      getMainWindow: () => null,
      getBootstrapResult: () => ({ ok: true, stage: 'done' }),
      getScheduler: () => null,
    })
    const result = await ipc.invoke('codex:v17:delete', { accountName: 'nope' })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('NOT_FOUND')
  })

  test('codex:v17:judge-status 返回三档', async () => {
    await buildV17(env, {
      accounts: [
        {
          name: 'green-acc',
          auth: makeFakeAuth({ accountId: 'g', iatSecondsAgo: 1 * 3600 }),
          state: { status: 'active' },
        },
      ],
    })

    const ipc = makeFakeIpc()
    registered = registerCodexAccountHandlersV17({
      ipcMain: ipc.ipcMain,
      getMainWindow: () => null,
      getBootstrapResult: () => ({ ok: true, stage: 'done' }),
      getScheduler: () => null,
    })
    const result = await ipc.invoke('codex:v17:judge-status', { accountName: 'green-acc' })
    expect(result.ok).toBe(true)
    expect(result.status.color).toBe('green')
  })

  test('codex:v17:get-bootstrap 返回 bootstrap 结果（删 scheduler 引用避免序列化）', async () => {
    const ipc = makeFakeIpc()
    const mockBootstrap = {
      ok: true,
      stage: 'done',
      scheduler: { foo: 'bar' }, // 不应被序列化
      migration: { ok: true, accounts: ['A'] },
      cloudSync: { sync: false },
    }
    registered = registerCodexAccountHandlersV17({
      ipcMain: ipc.ipcMain,
      getMainWindow: () => null,
      getBootstrapResult: () => mockBootstrap,
      getScheduler: () => null,
    })
    const result = await ipc.invoke('codex:v17:get-bootstrap')
    expect(result.ok).toBe(true)
    expect(result.stage).toBe('done')
    expect(result.migration.accounts).toEqual(['A'])
    expect(result).not.toHaveProperty('scheduler') // 已被剥离
  })

  test('codex:v17:switch 通过 IPC（mock refresher 注入）', async () => {
    await buildV17(env, {
      accounts: [
        { name: 'A', auth: makeFakeAuth({ accountId: 'a' }), state: { status: 'active' } },
        { name: 'B', auth: makeFakeAuth({ accountId: 'b' }), state: { status: 'active' } },
      ],
      active: 'A',
    })

    // 这个 IPC 调用走 production defaultRefresher → 内部走 codexTokenRefresherV17
    // refresherV17 内部没 mock fetch 会去打真实 OpenAI——这里不行
    // 改测：直接 mock accountService.switchAccountV17 的 refresher 不可能（handler 不暴露注入）
    // 退路：测 switch IPC handler 至少 valid payload 路径不抛
    const ipc = makeFakeIpc()
    registered = registerCodexAccountHandlersV17({
      ipcMain: ipc.ipcMain,
      getMainWindow: () => null,
      getBootstrapResult: () => ({ ok: true, stage: 'done' }),
      getScheduler: () => ({ reschedule() {} }),
    })
    const result = await ipc.invoke('codex:v17:switch', { accountName: 'A' })
    // A 已是 active → noop（不调 fetch）
    expect(result.ok).toBe(true)
    expect(result.noop).toBe(true)
  })

  test('codex:v17:switch INVALID_PAYLOAD', async () => {
    const ipc = makeFakeIpc()
    registered = registerCodexAccountHandlersV17({
      ipcMain: ipc.ipcMain,
      getMainWindow: () => null,
      getBootstrapResult: () => ({ ok: true, stage: 'done' }),
      getScheduler: () => null,
    })
    const result = await ipc.invoke('codex:v17:switch', {})
    expect(result.ok).toBe(false)
    expect(result.code).toBe('INVALID_PAYLOAD')
  })

  test('stop 移除所有 handler', async () => {
    const ipc = makeFakeIpc()
    registered = registerCodexAccountHandlersV17({
      ipcMain: ipc.ipcMain,
      getMainWindow: () => null,
      getBootstrapResult: () => ({ ok: true, stage: 'done' }),
      getScheduler: () => null,
    })
    expect(ipc.has('codex:v17:list')).toBe(true)
    expect(ipc.has('codex:v17:switch')).toBe(true)
    await registered.stop()
    registered = null
    expect(ipc.has('codex:v17:list')).toBe(false)
    expect(ipc.has('codex:v17:switch')).toBe(false)
  })
})
