/**
 * 会话状态通知日志（#41）
 *
 * 负责：
 * - 把「状态变了 → 发没发通知、为什么」逐行记到本地文件，方便事后查「这条怎么没弹」
 * - 不给用户看；只留最近 24 小时，写入时顺手清掉更早的行（最多每小时清一次）
 * - 写日志失败不影响通知本身
 *
 * @module electron/services/notifyLog
 */

const fs = require('fs')
const path = require('path')

const KEEP_MS = 24 * 60 * 60 * 1000
const PRUNE_EVERY_MS = 60 * 60 * 1000

/**
 * 本地时间 YYYY-MM-DD HH:MM:SS（行首时间也用来判断过期）
 * @param {Date} date
 * @returns {string}
 */
function formatTime(date) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * 创建日志写入器
 * @param {string} file - 日志文件路径
 * @param {{now?: () => number}} [options]
 * @returns {(message: string) => void}
 */
function createNotifyLog(file, { now = Date.now } = {}) {
  let lastPrune = 0

  function prune(nowMs) {
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      return
    }
    const cutoff = nowMs - KEEP_MS
    const kept = text.split('\n').filter((line) => {
      if (!line) return false
      // 行首时间解析不出来的行一并清掉
      const time = new Date(line.slice(0, 19).replace(' ', 'T')).getTime()
      return Number.isFinite(time) && time >= cutoff
    })
    fs.writeFileSync(file, kept.length ? `${kept.join('\n')}\n` : '')
  }

  return function log(message) {
    try {
      const nowMs = now()
      fs.mkdirSync(path.dirname(file), { recursive: true })
      if (nowMs - lastPrune >= PRUNE_EVERY_MS) {
        prune(nowMs)
        lastPrune = nowMs
      }
      fs.appendFileSync(file, `${formatTime(new Date(nowMs))} ${message}\n`)
    } catch (error) {
      console.warn('[session-status] notify log failed:', error?.message || error)
    }
  }
}

module.exports = { createNotifyLog, KEEP_MS }
