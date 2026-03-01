/**
 * 中央仓库文件监听服务
 *
 * 负责：
 * - 监听中央仓库目录的文件变更（方向 1：中央→工具）
 * - 防抖合并变更事件，批量回调
 * - 同步锁机制，避免方向 2 写入触发循环
 *
 * @module electron/services/repoWatcherService
 */

const path = require('path')

/**
 * 创建中央仓库文件监听实例
 * @param {Object} options - 配置项
 * @param {number} options.debounceMs - 防抖时间（毫秒），默认 1500
 * @param {number} options.syncLockCooldownMs - 同步锁释放后冷却时间（毫秒），默认 1000
 * @returns {{
 *   startWatching: Function,
 *   stopWatching: Function,
 *   restartWatching: Function,
 *   acquireSyncLock: Function,
 *   releaseSyncLock: Function,
 *   isWatching: Function,
 * }}
 */
function createRepoWatcher({ debounceMs = 1500, syncLockCooldownMs = 1000 } = {}) {
  let watcher = null
  let currentRepoPath = null
  let onChangedCallback = null

  // 防抖相关
  let debounceTimer = null
  let pendingSkillNames = new Set()

  // 同步锁：锁定期间忽略所有变更事件
  let isSyncing = false
  let syncLockCooldownTimer = null

  /**
   * 从文件路径提取技能名
   * @param {string} filePath - 变更文件的绝对路径
   * @returns {string|null} 技能名，无效路径返回 null
   */
  function extractSkillName(filePath) {
    if (!currentRepoPath) return null
    const relative = path.relative(currentRepoPath, filePath)
    const parts = relative.split(path.sep)
    // 忽略隐藏目录和根目录文件
    if (parts.length < 1 || parts[0].startsWith('.')) return null
    return parts[0]
  }

  /**
   * 处理文件变更事件（带防抖）
   * @param {string} filePath - 变更文件路径
   */
  function handleFileChange(filePath) {
    // 同步锁期间静默丢弃
    if (isSyncing) return

    const skillName = extractSkillName(filePath)
    if (!skillName) return

    pendingSkillNames.add(skillName)

    // 重置防抖定时器
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      const names = Array.from(pendingSkillNames)
      pendingSkillNames = new Set()
      debounceTimer = null

      if (names.length > 0 && onChangedCallback) {
        onChangedCallback(names)
      }
    }, debounceMs)
  }

  /**
   * 启动文件监听
   * @param {string} repoPath - 中央仓库路径（已展开）
   * @param {(skillNames: string[]) => void} onChanged - 变更回调
   */
  async function startWatching(repoPath, onChanged) {
    if (watcher) {
      await stopWatching()
    }

    currentRepoPath = repoPath
    onChangedCallback = onChanged

    try {
      // chokidar v4 使用 ESM，需要动态 import
      const { watch } = await import('chokidar')

      watcher = watch(repoPath, {
        ignoreInitial: true,
        depth: 3,
        awaitWriteFinish: { stabilityThreshold: 500 },
        ignored: [
          // 隐藏文件和目录
          /(^|[/\\])\../,
          // 原子写入临时文件
          /\.tmp\./,
        ],
      })

      watcher.on('add', handleFileChange)
      watcher.on('change', handleFileChange)

      console.log('[repo-watcher] Started watching:', repoPath)
    } catch (error) {
      console.error('[repo-watcher] Failed to start watching:', error)
      watcher = null
    }
  }

  /**
   * 停止文件监听并清理资源
   */
  async function stopWatching() {
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    if (syncLockCooldownTimer) {
      clearTimeout(syncLockCooldownTimer)
      syncLockCooldownTimer = null
    }
    pendingSkillNames = new Set()
    isSyncing = false

    if (watcher) {
      try {
        await watcher.close()
      } catch (error) {
        console.error('[repo-watcher] Error closing watcher:', error)
      }
      watcher = null
    }

    currentRepoPath = null
    onChangedCallback = null
    console.log('[repo-watcher] Stopped watching')
  }

  /**
   * 重启监听（仓库路径变更时使用）
   * @param {string} newRepoPath - 新仓库路径（已展开）
   * @param {(skillNames: string[]) => void} onChanged - 变更回调
   */
  async function restartWatching(newRepoPath, onChanged) {
    await stopWatching()
    await startWatching(newRepoPath, onChanged)
  }

  /**
   * 获取同步锁（方向 2 写入前调用）
   * 锁定后所有文件变更事件将被静默丢弃
   */
  function acquireSyncLock() {
    isSyncing = true
    // 清理挂起的事件，避免锁定前积累的事件在解锁后触发
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    pendingSkillNames = new Set()
    if (syncLockCooldownTimer) {
      clearTimeout(syncLockCooldownTimer)
      syncLockCooldownTimer = null
    }
  }

  /**
   * 释放同步锁（方向 2 写入后调用）
   * 延迟冷却后解锁，避免文件系统事件延迟触发
   */
  function releaseSyncLock() {
    if (syncLockCooldownTimer) {
      clearTimeout(syncLockCooldownTimer)
    }
    syncLockCooldownTimer = setTimeout(() => {
      isSyncing = false
      syncLockCooldownTimer = null
    }, syncLockCooldownMs)
  }

  /**
   * 是否正在监听
   * @returns {boolean}
   */
  function isWatching() {
    return watcher !== null
  }

  return {
    startWatching,
    stopWatching,
    restartWatching,
    acquireSyncLock,
    releaseSyncLock,
    isWatching,
  }
}

module.exports = { createRepoWatcher }
