/**
 * 应用退出清理登记处
 *
 * 负责：
 * - 各模块把自己的停止动作登记进来（定时器、文件监听、子进程、排队中的配置写入）
 * - 退出时并发执行全部停止动作：单项出错不影响其他，整体最多等 timeoutMs，卡住的不阻塞退出
 * - 只执行一次，重复调用返回同一个结果
 *
 * 为什么需要：原来 before-quit 只停了用量调度和会话监控，网络监控、DSH 子进程、仓库监听、
 * 正在写的 Codex 配置都没人管（架构优化路线 3 第二步）。
 *
 * @module electron/services/appLifecycle
 */

/**
 * @param {{timeoutMs?: number}} [options]
 * @returns {{register: (name: string, stop: () => any) => void, shutdown: () => Promise<Array<{name: string, status: 'done'|'failed'|'timeout'}>>}}
 */
function createShutdownRegistry({ timeoutMs = 3000 } = {}) {
  const stoppers = []
  let running = null

  function register(name, stop) {
    stoppers.push({ name, stop })
  }

  function shutdown() {
    if (running) return running
    running = (async () => {
      const report = stoppers.map(({ name }) => ({ name, status: 'timeout' }))
      const tasks = stoppers.map(({ stop }, index) => Promise.resolve()
        .then(() => stop())
        .then(() => { report[index].status = 'done' }, () => { report[index].status = 'failed' }))
      let timer
      const deadline = new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs) })
      await Promise.race([Promise.allSettled(tasks), deadline])
      clearTimeout(timer)
      return report.map((item) => ({ ...item }))
    })()
    return running
  }

  return { register, shutdown }
}

module.exports = { createShutdownRegistry }
