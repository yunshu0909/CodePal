/**
 * V1.7 保活调度器
 *
 * 负责：
 * - 算所有 inactive 账号的下次 keepalive 时刻（基于 JWT iat + 7d）
 * - 取最近时刻 setTimeout 到那一刻、到时调 sweepAllSlotsV17
 * - 1h 保守兜底定时器（防 setTimeout 漏触发）
 * - powerMonitor.resume（系统唤醒）+10s 延迟触发 sweep
 * - net.online（网络恢复）触发 sweep + paused 账号重新入堆
 * - 用户切换账号后 reschedule（因为 active 不再是旧账号）
 *
 * 依据：
 * - 设计稿 §4 保活调度
 * - PRD US-05 业务规则 + 异常处理
 * - K6 网络复活 + K16 active vs inactive + K17/18 周期与 iat
 *
 * Electron 依赖（可选注入）：
 * - powerMonitor: from require('electron')，在测试中可传 null
 * - net: from require('electron')，同上
 *
 * @module electron/services/codexSchedulerV17
 */

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')

const accountService = require('./codexAccountService')
const refresherV17 = require('./codexTokenRefresherV17')
const { decodeJwtPayload } = require('./codexJwtUtils')

const FALLBACK_INTERVAL_MS = 60 * 60 * 1000   // 1h 兜底
const RESUME_DELAY_MS = 10 * 1000             // 唤醒后等 10s 再 sweep
const KEEPALIVE_INTERVAL_MS = 7 * 24 * 3600 * 1000

const MIN_TIMEOUT_MS = 30 * 1000              // 防 setTimeout(0) 的退化为忙循环
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000    // setTimeout 数值上限保护

class CodexSchedulerV17 {
  /**
   * @param {{
   *   powerMonitor?: { on: Function, removeListener?: Function } | null,
   *   net?: { isOnline?: () => boolean, on?: Function, removeListener?: Function } | null,
   *   logger?: { warn?: Function, info?: Function, error?: Function },
   *   now?: () => number,
   *   setTimeoutFn?: typeof setTimeout,
   *   clearTimeoutFn?: typeof clearTimeout,
   *   keepaliveIntervalMs?: number,
   *   fallbackIntervalMs?: number,
   *   resumeDelayMs?: number,
   *   onSweepDone?: (report: object) => void,
   * }} [opts]
   */
  constructor(opts = {}) {
    this.powerMonitor = opts.powerMonitor ?? null
    this.net = opts.net ?? null
    this.logger = opts.logger ?? console
    this.now = opts.now ?? (() => Date.now())
    this.setTimeoutFn = opts.setTimeoutFn ?? setTimeout
    this.clearTimeoutFn = opts.clearTimeoutFn ?? clearTimeout
    this.keepaliveIntervalMs = opts.keepaliveIntervalMs ?? KEEPALIVE_INTERVAL_MS
    this.fallbackIntervalMs = opts.fallbackIntervalMs ?? FALLBACK_INTERVAL_MS
    this.resumeDelayMs = opts.resumeDelayMs ?? RESUME_DELAY_MS
    this.onSweepDone = opts.onSweepDone

    this._nextTimer = null      // setTimeout-to-next 句柄
    this._fallbackTimer = null  // 1h 兜底句柄
    this._resumeTimer = null    // resume +10s 句柄
    this._stopped = false
    this._sweepInflight = null  // sweep 进行中的 Promise（保证不并发）
    this._disabled = false      // iCloud 检测命中时禁用主动 sweep（仅保留 lazy）
    this._listeners = []        // 用于解绑 powerMonitor / net 监听
  }

  /**
   * 启动调度（main.js whenReady 后调一次）
   */
  start() {
    if (this._stopped) return
    this._installPowerListener()
    this._installNetListener()
    this._scheduleNext()
    this._scheduleFallback()
    this.logger.info?.('[codexSchedulerV17] started')
  }

  /**
   * 停止（before-quit 时调，等 inflight 清空）
   * @returns {Promise<void>}
   */
  async stop() {
    this._stopped = true
    if (this._nextTimer) { this.clearTimeoutFn(this._nextTimer); this._nextTimer = null }
    if (this._fallbackTimer) { this.clearTimeoutFn(this._fallbackTimer); this._fallbackTimer = null }
    if (this._resumeTimer) { this.clearTimeoutFn(this._resumeTimer); this._resumeTimer = null }
    for (const fn of this._listeners) {
      try { fn() } catch {}
    }
    this._listeners = []
    if (this._sweepInflight) {
      try { await this._sweepInflight } catch {}
    }
  }

  /**
   * 禁用主动 sweep（iCloud 检测命中时调用，US-08 操作流程 3）
   */
  disableActiveSweep(reason = 'cloud-sync-detected') {
    this._disabled = true
    this.logger.warn?.(`[codexSchedulerV17] disabled active sweep: ${reason}`)
    // V1.7 P1-4 修复：连同 _resumeTimer 一起 clear——保证彻底停
    if (this._nextTimer) { this.clearTimeoutFn(this._nextTimer); this._nextTimer = null }
    if (this._fallbackTimer) { this.clearTimeoutFn(this._fallbackTimer); this._fallbackTimer = null }
    if (this._resumeTimer) { this.clearTimeoutFn(this._resumeTimer); this._resumeTimer = null }
  }

  isDisabled() { return this._disabled }

  /**
   * 是否有 sweep 进行中（before-quit drain 用）
   */
  isInflight() { return this._sweepInflight != null }

  /**
   * 强制重新调度（用户切换账号 / 新增账号 / 删除账号 后调）
   */
  reschedule() {
    if (this._disabled || this._stopped) return
    this._scheduleNext()
  }

  // ---------- 内部 ----------

  async _runSweep(triggerSource) {
    if (this._disabled || this._stopped) return
    if (this._sweepInflight) {
      // 已有 sweep 在跑 → 等它完，再决定要不要再跑一次
      return this._sweepInflight
    }
    const task = (async () => {
      try {
        const report = await refresherV17.sweepAllSlotsV17({ logger: this.logger })
        this.logger.info?.(`[codexSchedulerV17] sweep done (${triggerSource}): processed=${report.processed.length}`)
        this.onSweepDone?.(report)
        return report
      } catch (err) {
        this.logger.error?.(`[codexSchedulerV17] sweep failed (${triggerSource}): ${err.message}`)
      } finally {
        this._sweepInflight = null
        // 跑完一轮立即重新调度下次
        // V1.7 P1-5 修复：catch async 异常避免 unhandled promise rejection 把下次调度搞没
        if (!this._stopped && !this._disabled) {
          this._scheduleNext().catch((err) => {
            this.logger.error?.(`[codexSchedulerV17] _scheduleNext threw: ${err.message}`)
          })
        }
      }
    })()
    this._sweepInflight = task
    return task
  }

  async _scheduleNext() {
    if (this._disabled || this._stopped) return
    if (this._nextTimer) { this.clearTimeoutFn(this._nextTimer); this._nextTimer = null }

    let nextAt = await this._computeNextKeepaliveAt()
    if (nextAt === null) {
      // 没有 inactive 账号 → 不安排，等 reschedule
      this.logger.info?.('[codexSchedulerV17] no inactive accounts, skipping next schedule')
      return
    }
    const now = this.now()
    let delay = nextAt - now
    if (delay < MIN_TIMEOUT_MS) delay = MIN_TIMEOUT_MS
    if (delay > MAX_TIMEOUT_MS) delay = MAX_TIMEOUT_MS

    this._nextTimer = this.setTimeoutFn(() => {
      this._nextTimer = null
      this._runSweep('next-timer')
    }, delay)
    this.logger.info?.(`[codexSchedulerV17] next sweep in ${Math.round(delay / 1000)}s`)
  }

  _scheduleFallback() {
    if (this._disabled || this._stopped) return
    if (this._fallbackTimer) this.clearTimeoutFn(this._fallbackTimer)
    this._fallbackTimer = this.setTimeoutFn(() => {
      this._fallbackTimer = null
      this._runSweep('fallback-1h').finally(() => this._scheduleFallback())
    }, this.fallbackIntervalMs)
  }

  _installPowerListener() {
    if (!this.powerMonitor || typeof this.powerMonitor.on !== 'function') return
    const handler = () => {
      this.logger.info?.('[codexSchedulerV17] system resume, sweep in 10s')
      if (this._resumeTimer) this.clearTimeoutFn(this._resumeTimer)
      this._resumeTimer = this.setTimeoutFn(() => {
        this._resumeTimer = null
        this._runSweep('resume')
      }, this.resumeDelayMs)
    }
    this.powerMonitor.on('resume', handler)
    this._listeners.push(() => {
      this.powerMonitor.removeListener?.('resume', handler)
    })
  }

  _installNetListener() {
    if (!this.net || typeof this.net.on !== 'function') return
    const handler = () => {
      this.logger.info?.('[codexSchedulerV17] net online, sweep + reset paused')
      this._runSweep('net-online')
    }
    // Electron net 模块没有 'online' 事件，需要 window.online polyfill；这里走可注入
    this.net.on('online', handler)
    this._listeners.push(() => { this.net.removeListener?.('online', handler) })
  }

  /**
   * 算所有 inactive 账号下一次 keepalive 时刻，取最小
   * @returns {Promise<number | null>}
   */
  async _computeNextKeepaliveAt() {
    const I = accountService.__INTERNAL__
    const accountsDir = I.getAccountsDir()
    if (!fs.existsSync(accountsDir)) return null
    const active = (await accountService.readActiveJsonV17())?.currentAccount ?? null
    const entries = await fsp.readdir(accountsDir, { withFileTypes: true })
    let minNext = null
    for (const ent of entries) {
      if (!ent.isDirectory()) continue
      // V1.7 P0-2 修复：anon-* 是未完成登录的临时目录，不进 keepalive 调度
      if (ent.name.startsWith('anon-')) continue
      if (ent.name === active) continue
      const home = path.join(accountsDir, ent.name, '.codex')
      const authPath = path.join(home, 'auth.json')
      if (!fs.existsSync(authPath)) continue
      let auth = null
      try { auth = JSON.parse(await fsp.readFile(authPath, 'utf8')) } catch { continue }
      const state = await accountService.readAccountStateV17(ent.name)
      const next = refresherV17.nextKeepaliveAt(ent.name, state, auth, this.now(), this.keepaliveIntervalMs)
      if (next === null || next === undefined) continue
      if (minNext === null || next < minNext) minNext = next
    }
    return minNext
  }
}

module.exports = {
  CodexSchedulerV17,
  FALLBACK_INTERVAL_MS,
  RESUME_DELAY_MS,
  KEEPALIVE_INTERVAL_MS,
}
