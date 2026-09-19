/**
 * 会话状态监听与系统通知（#41）
 *
 * 负责：
 * - 监听 states/ 目录，状态文件一变就重算可见会话并推给页面（不用手动刷新）
 * - 每分钟再算一次：Codex 30 分钟、24 小时这类按时间消失的规则要靠它生效
 * - 某个会话进入「等你确认」「完成了」的那一刻发一次系统通知；同一会话同一状态不重复
 * - 不发的时候：功能关着；CodePal 窗口在前台且正停在会话状态页
 * - 启动时的第一份快照只记下来不通知，避免一打开 CodePal 就补发一堆旧状态
 * - 每次状态变化发没发、为什么，写进通知日志（不给用户看，方便事后排查）
 *
 * @module electron/services/sessionStatusMonitor
 */

const fs = require('fs')
const path = require('path')

// 状态文件连写几次（txt / task / ask）合并成一次重算
const DEBOUNCE_MS = 250
const TICK_MS = 60 * 1000

// 通知右边的彩色小图 + 两种提示音：绿对勾 = 完成了，橙问号 = 等你确认
const NOTIFY_STYLE = {
  done: { label: '完成了', icon: 'done.png', sound: 'Glass' },
  attention: { label: '等你确认', icon: 'ask.png', sound: 'Ping' },
}

/**
 * 拼一条通知的内容
 * @param {{state: string, name: string, source: string, task?: string, ask?: string}} session
 * @param {string} iconDir - 彩色小图所在目录
 * @returns {{title: string, body: string, icon: string, sound: string}|null}
 */
function buildSessionNotification(session, iconDir) {
  const style = NOTIFY_STYLE[session?.state]
  if (!style) return null
  const body = session.state === 'attention' ? (session.ask || session.task || '') : (session.task || '')
  return {
    title: `${session.name} · ${session.source} ${style.label}`,
    body,
    icon: path.join(iconDir, style.icon),
    sound: style.sound,
  }
}

/**
 * 创建监听器
 * @param {object} deps
 * @param {string} deps.statesDir - 状态目录
 * @param {() => Promise<{sessions: Array<object>, total: number}>} deps.listSessions
 * @param {() => boolean} deps.isEnabled - 功能是否开着
 * @param {() => boolean} deps.isPageInFront - 窗口在前台且正停在会话状态页
 * @param {(payload: object) => void} deps.onChange - 推给页面
 * @param {(n: {title: string, body: string, icon: string, sound: string}) => void} deps.notify
 * @param {string} deps.iconDir
 * @param {(message: string) => void} [deps.log] - 通知日志
 * @param {typeof fs.watch} [deps.watchFn]
 * @returns {{start: () => Promise<void>, stop: () => void, refresh: () => Promise<object>, reset: () => void}}
 */
function createSessionStatusMonitor({
  statesDir,
  listSessions,
  isEnabled,
  isPageInFront,
  onChange,
  notify,
  iconDir,
  log = () => {},
  watchFn = fs.watch,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}) {
  let watcher = null
  let ticker = null
  let timer = null
  // 每个会话上次通知过的状态；null 表示还没拿到第一份快照
  let seen = null

  // 串行：监听、定时、页面读取可能同时触发重算，并发会让同一次变化弹两条通知
  let chain = Promise.resolve()
  function refresh() {
    const run = chain.then(doRefresh, doRefresh)
    chain = run.catch(() => {})
    return run
  }

  async function doRefresh() {
    let result
    try {
      result = { ...(await listSessions()), error: null }
    } catch (error) {
      result = { sessions: [], total: 0, error: error.message }
    }
    if (!isEnabled()) result = { sessions: [], total: 0, error: null }

    const next = new Map(result.sessions.map((s) => [s.key, s.state]))
    if (seen) {
      for (const session of result.sessions) {
        const before = seen.get(session.key)
        if (before === session.state) continue
        const line = `${session.name} · ${session.source} [${session.key.slice(0, 8)}] ${before || '新'} → ${session.state}`
        if (!NOTIFY_STYLE[session.state]) {
          log(`${line}：不发（这个状态不通知）`)
          continue
        }
        if (isPageInFront()) {
          log(`${line}：不发（正停在会话状态页）`)
          continue
        }
        const n = buildSessionNotification(session, iconDir)
        try {
          notify(n)
          log(`${line}：已发`)
        } catch (error) {
          log(`${line}：发送失败 ${error?.message || error}`)
          console.warn('[session-status] notify failed:', error?.message || error)
        }
      }
      for (const [key, state] of seen) {
        if (!next.has(key)) log(`[${key.slice(0, 8)}] ${state} → 消失`)
      }
    } else {
      log(`第一份快照（不通知）：${result.sessions.length} 个会话${result.error ? `，读取失败 ${result.error}` : ''}`)
    }
    seen = next
    onChange(result)
    return result
  }

  function schedule() {
    clearTimeout(timer)
    timer = setTimeout(() => { refresh() }, DEBOUNCE_MS)
  }

  async function start() {
    try {
      fs.mkdirSync(statesDir, { recursive: true })
      watcher = watchFn(statesDir, () => schedule())
      watcher.on?.('error', (error) => console.warn('[session-status] watch error:', error?.message || error))
    } catch (error) {
      console.warn('[session-status] watch unavailable:', error?.message || error)
    }
    ticker = setIntervalFn(() => { refresh() }, TICK_MS)
    await refresh()
  }

  function stop() {
    clearTimeout(timer)
    if (ticker) clearIntervalFn(ticker)
    watcher?.close?.()
    watcher = null
    ticker = null
  }

  // 开关切换后重新记快照：刚打开时已有的状态不补发通知
  function reset() {
    seen = null
  }

  return { start, stop, refresh, reset }
}

module.exports = { createSessionStatusMonitor, buildSessionNotification, NOTIFY_STYLE }
