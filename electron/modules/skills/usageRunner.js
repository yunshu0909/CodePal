/** One worker per user store. Aggregate and detail batches remain in the same execution owner. */
const path = require('path')
const { Worker } = require('worker_threads')
const workers = new Map()
let sequence = 0
function stateFor(deps) {
  const key = deps.homeDir + ':' + (deps.storeDir || '')
  if (workers.has(key)) return workers.get(key)
  const worker = new Worker(path.join(__dirname, 'usageWorker.js'))
  const state = { worker, pending: new Map() }
  workers.set(key, state)
  worker.on('message', ({ id, data, error }) => {
    const request = state.pending.get(id)
    if (!request) return
    state.pending.delete(id)
    if (error) request.reject(new Error(error))
    else request.resolve(data)
    if (!state.pending.size) worker.unref()
  })
  const fail = () => {
    workers.delete(key)
    for (const request of state.pending.values())
      request.reject(new Error('SKILL_USAGE_WORKER_FAILED'))
    state.pending.clear()
  }
  worker.on('error', fail)
  worker.on('exit', fail)
  worker.unref()
  return state
}
/**
 * @param {object} deps - 主进程 homeDir、可选 env/storeDir/nowFn。
 * @param {'aggregate'|'records'} action - 已校验动作。
 * @param {object} options - IPC 白名单选择参数。
 * @returns {Promise<object>} 同一存储的 worker 聚合或同批记录；真实失败继续抛出。
 * 只传工具目录环境，不复制凭证；重计算在 worker，空闲时允许主进程退出。
 */
function runUsage(deps, action, options) {
  const state = stateFor(deps)
  const id = ++sequence
  state.worker.ref()
  return new Promise((resolve, reject) => {
    state.pending.set(id, { resolve, reject })
    const env = deps.env || process.env
    state.worker.postMessage({
      id,
      action,
      options,
      deps: {
        homeDir: deps.homeDir,
        env: { CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR, CODEX_HOME: env.CODEX_HOME },
        storeDir: deps.storeDir,
        now: deps.nowFn ? deps.nowFn().toISOString() : undefined,
      },
    })
  })
}
module.exports = { runUsage }
