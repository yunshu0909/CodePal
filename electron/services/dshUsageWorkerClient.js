/**
 * DSH 扫描 worker 客户端
 *
 * 负责：
 * - 懒启动并复用 Electron utilityProcess
 * - 请求/响应配对、超时与崩溃兜底
 * - 任何失败都 fail-soft 返回空数组，绝不让调用方感知到崩溃
 *
 * @module electron/services/dshUsageWorkerClient
 */

const path = require('path')

/** 默认单次扫描超时：整窗口最坏情况约数十秒，留足余量 */
const DEFAULT_TIMEOUT_MS = 120000

/**
 * 创建一个「隔离进程里跑 DSH 扫描」的执行器
 *
 * @param {object} [options] - 配置
 * @param {string} [options.homeDir] - 用户主目录
 * @param {number} [options.timeoutMs] - 单次超时
 * @param {() => object} [options.forkFn] - 启动子进程的工厂（测试注入）
 * @param {object} [options.logger] - 日志器
 * @returns {(start: Date, end: Date) => Promise<Array<object>>} 扫描执行器
 */
function createDshWorkerRunner(options = {}) {
  const homeDir = options.homeDir
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS
  const logger = options.logger || console
  const forkFn = options.forkFn || (() => {
    const { utilityProcess } = require('electron')
    return utilityProcess.fork(path.join(__dirname, 'dshUsageWorker.js'), [], {
      serviceName: 'dsh-usage-scan',
    })
  })

  let child = null
  let nextId = 1
  const pending = new Map()

  /**
   * 结束所有等待中的请求
   * @param {string} reason - 失败原因
   */
  function failAllPending(reason) {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer)
      entry.resolve([])
    }
    pending.clear()

    if (pending.size === 0 && reason) {
      logger.warn(`DSH usage worker unavailable (${reason}); DSH data omitted for this window`)
    }
  }

  /**
   * 确保子进程存活
   * @returns {object} 子进程句柄
   */
  function ensureChild() {
    if (child) return child

    child = forkFn()

    child.on('message', (message) => {
      const entry = pending.get(message?.id)
      if (!entry) return

      pending.delete(message.id)
      clearTimeout(entry.timer)

      if (!message.ok) {
        logger.warn(`DSH usage worker returned error: ${message.error}`)
        entry.resolve([])
        return
      }

      entry.resolve(
        (message.records || []).map((record) => ({
          ...record,
          timestamp: record.timestamp instanceof Date ? record.timestamp : new Date(record.timestamp),
        })),
      )
    })

    // 子进程崩溃/退出：本次请求降级为空，主进程继续运行
    child.on('exit', () => {
      child = null
      failAllPending('worker exited')
    })

    return child
  }

  /**
   * 在隔离进程中扫描一个时间窗口
   * @param {Date} start - 窗口开始（含）
   * @param {Date} end - 窗口结束（不含）
   * @returns {Promise<Array<object>>} 用量记录；隔离进程不可用时为空数组
   */
  return function runDshScanInWorker(start, end) {
    return new Promise((resolve) => {
      let requestChild
      try {
        requestChild = ensureChild()
      } catch (error) {
        logger.warn(`DSH usage worker failed to start: ${error?.message || error}`)
        resolve([])
        return
      }

      const id = nextId
      nextId += 1

      const timer = setTimeout(() => {
        pending.delete(id)
        logger.warn(`DSH usage worker timed out after ${timeoutMs}ms; restarting worker`)
        try {
          requestChild.kill()
        } catch {
          // 已被回收
        }
        if (child === requestChild) child = null
        resolve([])
      }, timeoutMs)

      pending.set(id, { resolve, timer })

      try {
        requestChild.postMessage({
          id,
          start: start.toISOString(),
          end: end.toISOString(),
          homeDir,
        })
      } catch (error) {
        pending.delete(id)
        clearTimeout(timer)
        logger.warn(`DSH usage worker postMessage failed: ${error?.message || error}`)
        resolve([])
      }
    })
  }
}

module.exports = { createDshWorkerRunner, DEFAULT_TIMEOUT_MS }
