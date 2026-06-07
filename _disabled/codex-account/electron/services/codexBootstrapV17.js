/**
 * V1.7 启动流程编排
 *
 * 按这个顺序在 app.whenReady 后调一次：
 *   1. 检测 ~/.codex-switcher/ 是否在云盘同步路径下（cloudSyncDetector）
 *      命中 → 后续 scheduler 启动时调 disableActiveSweep
 *   2. 检测 V1.7 是否需要迁移（codexMigrator.shouldMigrate）
 *      需要 → 调 runMigration；失败 → 抛或返回降级信号
 *   3. 崩溃恢复（codexTokenRefresherV17.recoverFromCrashV17）
 *      重放 10 分钟内的 .recovery-<ts>
 *   4. symlink 完整性自愈（codexSymlinkIntegrity.verifyAllAccounts）
 *   5. 启动 scheduler（codexSchedulerV17.start）
 *
 * 失败处理：
 * - 迁移失败 → 返回 { ok: false, stage: 'migrate', error }，让 main.js 决定是否拒绝启动
 * - recover / integrity / scheduler 失败 → 记日志但继续启动（不阻塞应用使用）
 *
 * @module electron/services/codexBootstrapV17
 */

const accountService = require('./codexAccountService')
const codexMigrator = require('./codexMigrator')
const codexSymlinkIntegrity = require('./codexSymlinkIntegrity')
const codexTokenRefresherV17 = require('./codexTokenRefresherV17')
const cloudSyncDetector = require('./cloudSyncDetector')
const codexHomeSymlinkFarm = require('./codexHomeSymlinkFarm')
const { CodexSchedulerV17 } = require('./codexSchedulerV17')

/**
 * @param {{
 *   powerMonitor?: object | null,
 *   net?: object | null,
 *   logger?: { warn?: Function, info?: Function, error?: Function },
 *   appVersion?: string,
 *   onCloudSyncDetected?: (info: { vendor: string }) => void,
 *   onMigrationStarted?: () => void,
 *   onMigrationDone?: (result: object) => void,
 * }} [opts]
 * @returns {Promise<{
 *   ok: boolean,
 *   stage: 'cloud-detect' | 'migrate' | 'recover' | 'integrity' | 'scheduler' | 'done',
 *   scheduler: CodexSchedulerV17 | null,
 *   migration?: object,
 *   recovery?: object[],
 *   integrity?: object,
 *   cloudSync?: object,
 *   error?: object,
 * }>}
 */
async function bootstrapV17(opts = {}) {
  const logger = opts.logger ?? console
  const result = {
    ok: true,
    stage: 'done',
    scheduler: null,
  }

  // Step 1: cloud sync 检测
  result.stage = 'cloud-detect'
  try {
    const I = accountService.__INTERNAL__
    const switcherDir = I.getStoreDir()
    const detection = cloudSyncDetector.detectCloudSync(switcherDir)
    result.cloudSync = detection
    if (detection.sync) {
      logger.warn?.(`[codexBootstrapV17] cloud sync detected: vendor=${detection.vendor}`)
      opts.onCloudSyncDetected?.(detection)
    }
  } catch (err) {
    logger.warn?.(`[codexBootstrapV17] cloud-detect failed: ${err.message}`)
  }

  // Step 2: 迁移
  result.stage = 'migrate'
  if (codexMigrator.shouldMigrate()) {
    opts.onMigrationStarted?.()
    try {
      const migration = await codexMigrator.runMigration({ logger })
      result.migration = migration
      opts.onMigrationDone?.(migration)
      if (!migration.ok) {
        result.ok = false
        result.error = migration.error
        return result
      }
    } catch (err) {
      logger.error?.(`[codexBootstrapV17] migration threw: ${err.message}`)
      result.ok = false
      result.error = { code: err.code ?? 'UNKNOWN', message: err.message }
      return result
    }
  } else {
    logger.info?.('[codexBootstrapV17] V1.7 already migrated, skipping')
  }

  // Step 2.5（V1.7.3）：扫 accounts/ 顶层的 V1.6 .json 残留，自动升级成目录格式
  // 不影响 ok：失败只报警告，不阻塞 app 启动
  result.stage = 'residue-cleanup'
  try {
    result.residueCleanup = await codexMigrator.upgradeV16ResidueAccounts({ logger })
    const { upgraded, conflicts } = result.residueCleanup
    if (upgraded.length || conflicts.length) {
      logger.info?.(`[codexBootstrapV17] residue cleanup: upgraded=${upgraded.length} conflicts=${conflicts.length}`)
    }
  } catch (err) {
    logger.warn?.(`[codexBootstrapV17] residue cleanup threw: ${err.message}`)
  }

  // Step 3: 崩溃恢复
  result.stage = 'recover'
  try {
    if (opts.appVersion) codexTokenRefresherV17.setUserAgent(opts.appVersion)
    result.recovery = await codexTokenRefresherV17.recoverFromCrashV17({ logger })
  } catch (err) {
    logger.warn?.(`[codexBootstrapV17] recover failed: ${err.message}`)
  }

  // Step 4: symlink 完整性自愈
  result.stage = 'integrity'
  try {
    result.integrity = await codexSymlinkIntegrity.verifyAllAccounts({ logger })
  } catch (err) {
    logger.warn?.(`[codexBootstrapV17] integrity check failed: ${err.message}`)
  }

  // Step 4.5（V1.7.1）：~/.codex/ symlink farm 验证 + 自愈
  // 让终端 codex 和 CodePal 启动的 codex 共享一套数据 + auth.json symlink 跟随激活账号
  result.stage = 'home-symlink-farm'
  try {
    result.homeSymlinkFarm = await codexHomeSymlinkFarm.verifyHomeSymlinkFarm({ logger })
    if (result.homeSymlinkFarm?.repaired?.length) {
      logger.info?.(`[codexBootstrapV17] home symlink farm repaired: ${result.homeSymlinkFarm.repaired.join(', ')}`)
    }
  } catch (err) {
    logger.warn?.(`[codexBootstrapV17] home symlink farm verify failed: ${err.message}`)
  }

  // Step 5: 启动 scheduler
  // V1.7 P0-8 修复：scheduler 启动失败时翻 result.ok=false，让 main.js 感知保活停掉
  result.stage = 'scheduler'
  try {
    const scheduler = new CodexSchedulerV17({
      powerMonitor: opts.powerMonitor,
      net: opts.net,
      logger,
    })
    if (result.cloudSync?.sync) {
      scheduler.disableActiveSweep(`cloud-${result.cloudSync.vendor}`)
    }
    scheduler.start()
    result.scheduler = scheduler
  } catch (err) {
    logger.error?.(`[codexBootstrapV17] scheduler start failed: ${err.message}`)
    result.ok = false
    result.error = { code: 'SCHEDULER_START_FAILED', message: err.message }
    // 注意：不 return result——继续把 stage 设为 done，让 UI 能区分"scheduler 起不来"和"migrate 失败"
  }

  result.stage = 'done'
  return result
}

module.exports = {
  bootstrapV17,
}
