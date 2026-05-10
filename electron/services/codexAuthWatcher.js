/**
 * Codex auth.json 监听服务
 *
 * 负责：
 * - chokidar 监听 ~/.codex/auth.json 的变化
 * - 检测到 account_id 与已保存账户全不匹配时 → 触发"新账户检测"回调
 * - 检测到 account_id 与已保存账户匹配时 → 自动同步回原槽位（保 refresh_token 最新）
 * - debounce + awaitWriteFinish 防止半写文件误触发
 *
 * 架构：处理逻辑 `handleAuthChange` 是纯函数（可单测）；
 *      chokidar 是触发器（调用 handleAuthChange 的桥），
 *      这样 watcher 在生产中稳定，测试里也能绕开 chokidar 直测核心逻辑。
 *
 * @module electron/services/codexAuthWatcher
 */

const chokidar = require('chokidar')
const { extractEmail, extractPlan, extractAccountId } = require('./codexJwtUtils')
const accountService = require('./codexAccountService')

// V1.6.2: 懒加载 refresher，避免循环依赖
let _refresher = null
function getRefresher() {
  if (!_refresher) _refresher = require('./codexTokenRefresher')
  return _refresher
}

// 同一账户连续变化的 debounce（ms）
const DEBOUNCE_MS = 500

/**
 * 处理一次 auth.json 变化（纯业务逻辑，可单测）
 *
 * 执行步骤：
 *   1. 读当前 auth.json
 *   2. 不存在 / 解析失败 → 返回 `{ handled: false }`
 *   3. account_id 和上次处理过的一样 → 返回 `{ handled: false, skipped: 'same-id' }`
 *   4. 列表所有已保存账户，按 account_id 匹配
 *      - 匹配 → 原子同步当前 auth.json 到该槽（保 refresh_token 最新）
 *      - 不匹配且有未归属激活账户 → 触发 onNewAccountDetected
 *
 * @param {object} state - 持续状态容器 `{ lastProcessedId }`
 * @param {object} callbacks
 * @param {(payload) => void} callbacks.onNewAccountDetected
 * @returns {Promise<{handled: boolean, reason?: string}>}
 */
async function handleAuthChange(state, callbacks) {
  const onNewAccountDetected = callbacks?.onNewAccountDetected || (() => {})

  const current = await accountService.readCurrentAuth()
  if (!current.exists) return { handled: false, reason: 'no-auth-file' }
  if (!current.accountId) return { handled: false, reason: 'parse-failed' }

  if (current.accountId === state.lastProcessedId) {
    return { handled: false, reason: 'same-id' }
  }
  state.lastProcessedId = current.accountId

  const { accounts, activeName, hasUnsavedActive } = await accountService.listSavedAccounts()
  const match = accounts.find((a) => a.accountId && a.accountId === current.accountId)

  if (match) {
    // V1.6.2 修复 B1：refresher 正在写同 accountId 的 slot 时跳过，
    // 避免旧 auth.json 内容覆盖刚写入的新 token（refresh_token 是一次性的，覆盖会丢号）
    const inflight = getRefresher().__INTERNAL__.inflight
    const hasInflight = Array.from(inflight.keys()).some((key) => {
      // inflight key 是 `${accountId}:${force?'force':'normal'}`，按前缀匹配
      return key === current.accountId || key.startsWith(`${current.accountId}:`)
    })
    if (hasInflight) {
      // refresher 正在写，让 refresher 完成；watcher 不抢
      return { handled: false, reason: 'refresh-in-flight' }
    }

    // 已归属：Codex 刷了 token → 同步回槽位
    await accountService.__INTERNAL__.atomicCopy(
      accountService.__INTERNAL__.getAuthFile(),
      accountService.__INTERNAL__.accountPath(match.name)
    )
    return { handled: true, reason: 'synced-slot' }
  }

  if (hasUnsavedActive) {
    const existingNames = accounts.map((a) => a.name)
    const suggestedName = accountService.emailToDefaultName(current.email, existingNames)
    onNewAccountDetected({
      accountId: current.accountId,
      email: current.email,
      plan: current.plan,
      suggestedName,
      activeName,
    })
    return { handled: true, reason: 'new-account' }
  }

  return { handled: false, reason: 'no-change' }
}

/**
 * 启动 chokidar 监听（生产入口）
 *
 * @param {object} callbacks
 * @param {(payload: {accountId, email, plan, suggestedName}) => void} callbacks.onNewAccountDetected
 * @param {(err: Error) => void} [callbacks.onError]
 * @param {object} [chokidarOptions] - 可覆盖 chokidar 配置（测试注入 usePolling）
 * @returns {() => Promise<void>} stop 函数
 */
function startWatching(callbacks = {}, chokidarOptions = {}) {
  const onError = callbacks.onError || ((err) => console.warn('[codex-watcher]', err?.message || err))

  const authFile = accountService.__INTERNAL__.getAuthFile()

  const watcher = chokidar.watch(authFile, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 300,
      pollInterval: 100,
    },
    ...chokidarOptions,
  })

  const state = { lastProcessedId: '' }
  let timer = null

  const schedule = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(async () => {
      try {
        await handleAuthChange(state, callbacks)
      } catch (err) {
        onError(err)
      }
    }, DEBOUNCE_MS)
  }

  watcher.on('add', schedule)
  watcher.on('change', schedule)
  watcher.on('error', onError)

  return async function stop() {
    if (timer) clearTimeout(timer)
    await watcher.close()
  }
}

module.exports = {
  startWatching,
  handleAuthChange,
  __INTERNAL__: {
    DEBOUNCE_MS,
    // 暴露 watcher 闭包实际 require 的 accountService 实例，
    // 给测试用（ESM import 和 CommonJS require 在 vitest 里可能 cache 分离，
    // 不同实例的 _homeDir 是独立的，必须拿同一份才能注入 tmpHome）
    getLinkedAccountService() { return accountService },
    // V1.6.2: 同样暴露 watcher 内部用的 refresher 实例（B1 测试需要）
    getLinkedRefresher() { return getRefresher() },
  },
}
