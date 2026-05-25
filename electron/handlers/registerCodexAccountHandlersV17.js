/**
 * V1.7 Codex 账户 IPC handlers
 *
 * 提供给渲染层的接口（与旧 V1.6 IPC 并存，名字加 :v17 后缀）：
 *
 *   codex:v17:list             → listSavedAccountsV17
 *   codex:v17:read-active      → readActiveJsonV17
 *   codex:v17:switch           → switchAccountV17（含 force refresh）
 *   codex:v17:force-refresh    → ensureFreshCodexTokenV17（force=true）
 *   codex:v17:judge-status     → codexStatusJudge.judge(name)
 *   codex:v17:login-begin      → loginCapture.beginLogin
 *   codex:v17:login-finalize   → loginCapture.finalizeLogin
 *   codex:v17:login-cancel     → loginCapture.cancelLogin
 *   codex:v17:rename           → atomic rename accounts/{old} → accounts/{new}
 *   codex:v17:delete           → atomic move 到 deleted-backup-<ts> 冷备份
 *   codex:v17:open-codex       → spawnCodex
 *   codex:v17:get-bootstrap    → 返回 bootstrap 结果（迁移状态/cloud detect/integrity）
 *
 * @module electron/handlers/registerCodexAccountHandlersV17
 */

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')

const accountService = require('../services/codexAccountService')
const refresherV17 = require('../services/codexTokenRefresherV17')
const codexStatusJudge = require('../services/codexStatusJudge')
const codexProcessLauncher = require('../services/codexProcessLauncher')
const codexProcessService = require('../services/codexProcessService')
const codexHomeSymlinkFarm = require('../services/codexHomeSymlinkFarm')
const { CodexLoginCaptureV17 } = require('../services/codexLoginCaptureV17')

/**
 * @param {{
 *   ipcMain: import('electron').IpcMain,
 *   getMainWindow: () => Electron.BrowserWindow | null,
 *   getBootstrapResult: () => object | null,
 *   getScheduler: () => import('../services/codexSchedulerV17').CodexSchedulerV17 | null,
 *   logger?: object,
 * }} deps
 * @returns {{ stop: () => Promise<void>, loginCapture: CodexLoginCaptureV17 }}
 */
function registerCodexAccountHandlersV17(deps) {
  const { ipcMain, getMainWindow, getBootstrapResult, getScheduler } = deps
  const logger = deps.logger ?? console

  // V1.7 P0-5 修复：UI 在 bootstrap 完成前不能读到迁移中间态
  // 所有"读"类 IPC 在 bootstrap.ok=true 之前返回 BOOTSTRAPPING；UI 渲染骨架屏
  // 例外：get-bootstrap 必须能在任何时候被调（UI 用它判断状态）
  function requireBootstrap() {
    const r = getBootstrapResult()
    if (!r) return { ok: false, code: 'BOOTSTRAPPING' }
    if (!r.ok) return { ok: false, code: 'BOOTSTRAP_FAILED', stage: r.stage, error: r.error }
    return null // 通过
  }

  // 单实例 login capture（V1.7 一次只允许一个登录闭环）
  const loginCapture = new CodexLoginCaptureV17({ logger })

  // 把 capture 事件推给渲染层
  loginCapture.on('auth-captured', (payload) => {
    const win = getMainWindow()
    win?.webContents?.send('codex:v17:login-event', { type: 'auth-captured', ...payload })
  })
  loginCapture.on('login-finalized', (payload) => {
    const win = getMainWindow()
    win?.webContents?.send('codex:v17:login-event', { type: 'finalized', ...payload })
  })
  loginCapture.on('login-aborted', (payload) => {
    const win = getMainWindow()
    win?.webContents?.send('codex:v17:login-event', { type: 'aborted', ...payload })
  })

  ipcMain.handle('codex:v17:list', async () => {
    const gate = requireBootstrap(); if (gate) return gate
    try {
      const accounts = await accountService.listSavedAccountsV17()
      // 顺手算三档状态
      const enriched = await Promise.all(accounts.map(async (acc) => {
        const status = await codexStatusJudge.judge(acc.name)
        return { ...acc, status }
      }))
      return { ok: true, accounts: enriched }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle('codex:v17:read-active', async () => {
    const gate = requireBootstrap(); if (gate) return gate
    try {
      const active = await accountService.readActiveJsonV17()
      return { ok: true, active }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle('codex:v17:switch', async (_event, payload) => {
    const gate = requireBootstrap(); if (gate) return gate
    if (!payload || typeof payload.accountName !== 'string') {
      logger.warn?.(`[ipc:v17:switch] invalid-payload payload=${JSON.stringify(payload)}`)
      return { ok: false, code: 'INVALID_PAYLOAD' }
    }
    try {
      const result = await accountService.switchAccountV17(payload.accountName, {
        forceOnTransient: !!payload.forceOnTransient,
      })
      // 切换后让 scheduler reschedule（新 active 不应被刷）
      try { getScheduler()?.reschedule() } catch {}
      return result
    } catch (err) {
      logger.error?.(`[ipc:v17:switch] threw account=${payload.accountName} message=${err?.message} stack=${err?.stack?.split('\n').slice(0, 3).join(' | ')}`)
      return { ok: false, code: 'SWITCH_THREW', error: err.message }
    }
  })

  ipcMain.handle('codex:v17:force-refresh', async (_event, payload) => {
    const gate = requireBootstrap(); if (gate) return gate
    if (!payload || typeof payload.accountName !== 'string') {
      logger.warn?.(`[ipc:v17:force-refresh] invalid-payload payload=${JSON.stringify(payload)}`)
      return { ok: false, code: 'INVALID_PAYLOAD' }
    }
    logger.info?.(`[ipc:v17:force-refresh] begin account=${payload.accountName} source=ui-button`)
    try {
      const result = await refresherV17.ensureFreshCodexTokenV17({
        accountName: payload.accountName,
        force: true,
        logger,
      })
      return result
    } catch (err) {
      logger.error?.(`[ipc:v17:force-refresh] threw account=${payload.accountName} message=${err?.message}`)
      return { ok: false, classification: 'Transient', reason: 'Threw', error: err.message }
    }
  })

  ipcMain.handle('codex:v17:judge-status', async (_event, payload) => {
    const gate = requireBootstrap(); if (gate) return gate
    if (!payload || typeof payload.accountName !== 'string') {
      return { ok: false, code: 'INVALID_PAYLOAD' }
    }
    try {
      const status = await codexStatusJudge.judge(payload.accountName)
      return { ok: true, status }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle('codex:v17:login-begin', async () => {
    const gate = requireBootstrap(); if (gate) return gate
    try {
      const session = await loginCapture.beginLogin()
      return { ok: true, ...session }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle('codex:v17:login-finalize', async (_event, payload) => {
    if (!payload || typeof payload.sessionId !== 'string') {
      return { ok: false, code: 'INVALID_PAYLOAD' }
    }
    const result = await loginCapture.finalizeLogin(payload.sessionId, payload.name)
    try { getScheduler()?.reschedule() } catch {}
    return result
  })

  ipcMain.handle('codex:v17:login-cancel', async (_event, payload) => {
    if (!payload || typeof payload.sessionId !== 'string') {
      return { ok: false, code: 'INVALID_PAYLOAD' }
    }
    return loginCapture.cancelLogin(payload.sessionId)
  })

  ipcMain.handle('codex:v17:rename', async (_event, payload) => {
    const gate = requireBootstrap(); if (gate) return gate
    if (!payload || typeof payload.oldName !== 'string' || typeof payload.newName !== 'string') {
      return { ok: false, code: 'INVALID_PAYLOAD' }
    }
    const I = accountService.__INTERNAL__
    const SAFE_NAME_REGEX = I.SAFE_NAME_REGEX
    if (!SAFE_NAME_REGEX.test(payload.newName)) return { ok: false, code: 'INVALID_NAME' }
    const oldDir = path.dirname(I.getAccountHomeDir(payload.oldName))
    const newDir = path.dirname(I.getAccountHomeDir(payload.newName))
    if (!fs.existsSync(oldDir)) return { ok: false, code: 'OLD_NOT_FOUND' }
    if (fs.existsSync(newDir)) return { ok: false, code: 'NEW_EXISTS' }
    // V1.7.1.2 P0-3：rename + writeActive + farm 三步带回滚——任一失败回滚到 rename 前
    try {
      await fsp.rename(oldDir, newDir)
    } catch (err) {
      logger.warn?.(`[codex:v17:rename] step1-rename failed oldName=${payload.oldName} message=${err.message}`)
      return { ok: false, code: 'RENAME_FAILED', error: err.message }
    }
    const active = await accountService.readActiveJsonV17()
    const wasActive = active?.currentAccount === payload.oldName
    if (wasActive) {
      try {
        await accountService.writeActiveJsonV17({ currentAccount: payload.newName })
      } catch (err) {
        // 回滚：把 dir 改回去
        logger.error?.(`[codex:v17:rename] step2-writeActive failed, rolling back rename: ${err.message}`)
        try { await fsp.rename(newDir, oldDir) } catch (rollbackErr) {
          logger.error?.(`[codex:v17:rename] rollback failed: ${rollbackErr.message}; 用户数据停留在 ${newDir}`)
          return { ok: false, code: 'RENAME_PARTIAL_AND_ROLLBACK_FAILED', error: `${err.message}; rollback: ${rollbackErr.message}` }
        }
        return { ok: false, code: 'RENAME_FAILED_ACTIVE_WRITE', error: err.message }
      }
      try {
        await codexHomeSymlinkFarm.repointActiveAuthSymlink(payload.newName, { logger })
      } catch (err) {
        // farm 失败不回滚 rename + active.json（数据是对的，只是 farm symlink 没跟上）
        // 返回 ok=true 但带 farmDesynced flag 让 UI 警告
        logger.warn?.(`[codex:v17:rename] step3-farm-repoint failed: ${err.message}`)
        return { ok: true, farmDesynced: true, farmError: err.message }
      }
    }
    return { ok: true }
  })

  ipcMain.handle('codex:v17:delete', async (_event, payload) => {
    const gate = requireBootstrap(); if (gate) return gate
    if (!payload || typeof payload.accountName !== 'string') {
      return { ok: false, code: 'INVALID_PAYLOAD' }
    }
    const I = accountService.__INTERNAL__
    const accountDir = path.dirname(I.getAccountHomeDir(payload.accountName))
    if (!fs.existsSync(accountDir)) return { ok: false, code: 'NOT_FOUND' }
    const ts = Date.now()
    const switcherDir = I.getStoreDir()
    const fakeHome = I.getFakeHomeDir()
    const backupDir = path.join(fakeHome, `.codex-switcher.deleted-backup-${ts}`, payload.accountName)
    // V1.7.1.2 P0-3：rename + writeActive + unlink farm 三步带回滚
    try {
      await fsp.mkdir(path.dirname(backupDir), { recursive: true })
      await fsp.rename(accountDir, backupDir)
    } catch (err) {
      logger.warn?.(`[codex:v17:delete] step1-rename failed account=${payload.accountName} message=${err.message}`)
      return { ok: false, code: 'DELETE_FAILED', error: err.message }
    }
    const active = await accountService.readActiveJsonV17()
    const wasActive = active?.currentAccount === payload.accountName
    if (wasActive) {
      try {
        await accountService.writeActiveJsonV17({ currentAccount: null })
      } catch (err) {
        // 回滚：把 backup 改回 accounts/
        logger.error?.(`[codex:v17:delete] step2-writeActive failed, rolling back: ${err.message}`)
        try { await fsp.rename(backupDir, accountDir) } catch (rollbackErr) {
          logger.error?.(`[codex:v17:delete] rollback failed: ${rollbackErr.message}; 用户数据停留在 ${backupDir}`)
          return { ok: false, code: 'DELETE_PARTIAL_AND_ROLLBACK_FAILED', error: `${err.message}; rollback: ${rollbackErr.message}`, backupDir }
        }
        return { ok: false, code: 'DELETE_FAILED_ACTIVE_WRITE', error: err.message }
      }
      // 清 farm symlink（avoid dangling）；失败不阻塞——symlink dangling 不致命
      try {
        const I2 = accountService.__INTERNAL__
        const authLink = path.join(I2.getSharedCodexDir(), 'auth.json')
        if (fs.existsSync(authLink)) {
          await fsp.unlink(authLink)
          logger.info?.(`[codex:v17:delete] cleared dangling farm auth symlink (active was deleted)`)
        }
      } catch (err) {
        logger.warn?.(`[codex:v17:delete] clear farm symlink failed: ${err.message}`)
      }
    }
    try { getScheduler()?.reschedule() } catch {}
    return { ok: true, backupDir }
  })

  ipcMain.handle('codex:v17:open-codex', async (_event, payload) => {
    const gate = requireBootstrap(); if (gate) return gate
    // V1.7.1.2 修复：用户要的是 Codex.app 桌面 GUI（不是终端 CLI）
    // V1.7.1 farm 已经把 ~/.codex/auth.json symlink 到激活账号，Codex.app 启动会读到正确账号
    // 如果 Codex.app 已经在跑（持有旧 auth 缓存），用户得手动退出重开——也可以请求做 restartCodex
    const restart = !!payload?.restart
    try {
      // 先校验有激活账号（防止 Codex.app 启动看到 dangling symlink 报错）
      const active = await accountService.readActiveJsonV17()
      if (!active?.currentAccount) {
        logger.warn?.(`[ipc:v17:open-codex] no-active-account`)
        return { ok: false, code: 'NO_ACTIVE_ACCOUNT', error: '请先在 CodePal 内激活一个账号' }
      }
      logger.info?.(`[ipc:v17:open-codex] begin account=${active.currentAccount} restart=${restart}`)
      const result = restart
        ? await codexProcessService.restartCodex()
        : await codexProcessService.openCodex()
      if (!result.success) {
        logger.warn?.(`[ipc:v17:open-codex] open failed: ${result.error}`)
        return { ok: false, code: 'OPEN_FAILED', error: result.error }
      }
      logger.info?.(`[ipc:v17:open-codex] launched account=${active.currentAccount} opener=Codex.app`)
      return { ok: true, accountName: active.currentAccount, opener: 'Codex.app' }
    } catch (err) {
      logger.error?.(`[ipc:v17:open-codex] threw message=${err?.message}`)
      return { ok: false, code: err.code ?? 'OPEN_FAILED', error: err.message }
    }
  })

  ipcMain.handle('codex:v17:get-bootstrap', async () => {
    const r = getBootstrapResult()
    if (!r) return { ok: false, code: 'NO_BOOTSTRAP_RESULT' }
    // 删 scheduler 引用避免 IPC 序列化错误
    const { scheduler, ...rest } = r
    return { ok: true, ...rest }
  })

  return {
    loginCapture,
    async stop() {
      // 清掉所有进行中的 login session
      for (const sid of loginCapture._sessions.keys()) {
        await loginCapture.cancelLogin(sid).catch(() => {})
      }
      ipcMain.removeHandler('codex:v17:list')
      ipcMain.removeHandler('codex:v17:read-active')
      ipcMain.removeHandler('codex:v17:switch')
      ipcMain.removeHandler('codex:v17:force-refresh')
      ipcMain.removeHandler('codex:v17:judge-status')
      ipcMain.removeHandler('codex:v17:login-begin')
      ipcMain.removeHandler('codex:v17:login-finalize')
      ipcMain.removeHandler('codex:v17:login-cancel')
      ipcMain.removeHandler('codex:v17:rename')
      ipcMain.removeHandler('codex:v17:delete')
      ipcMain.removeHandler('codex:v17:open-codex')
      ipcMain.removeHandler('codex:v17:get-bootstrap')
    },
  }
}

module.exports = { registerCodexAccountHandlersV17 }
