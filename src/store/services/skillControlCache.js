/**
 * Skills 本次运行的共享状态
 * - 按资产库隔离快照、浏览位置与待完成操作；订阅者卸载不取消已经发起的任务
 * - 合并重叠读取，串行写入，阻止写入前的旧读取覆盖实时核对结果
 * @module store/services/skillControlCache
 */

const contexts = new WeakMap()
const offlineContext = {}

/**
 * 创建一个运行上下文的内存缓存，无磁盘与定时器副作用。
 * @returns {object} 状态订阅与读取、写入协调器
 */
export function createSkillControlCache() {
  const entries = new Map()

  const publish = (entry, patch) => {
    entry.state = { ...entry.state, ...patch }
    entry.listeners.forEach((listener) => listener())
  }

  const applySnapshot = (entry, snapshot) => {
    publish(entry, { snapshot, status: 'ready', error: null, refreshState: 'idle' })
  }

  /**
   * 每个资产库保留独立状态；未知路径不能借用其它资产库。
   * @param {string|null} repoPath
   * @returns {object} 稳定的缓存条目
   */
  function entry(repoPath) {
    if (!entries.has(repoPath)) {
      entries.set(repoPath, {
        state: { snapshot: null, status: 'loading', error: null, refreshState: 'idle', pendingKeys: new Set(), query: '', selectedId: '__overview' },
        listeners: new Set(), epoch: 0, read: null, queuedRead: null, writeTail: Promise.resolve(), interruptedLoader: null,
      })
    }
    return entries.get(repoPath)
  }

  /**
   * 合并正在进行的读取；写入期间发起的核对要等写入结束后再启动。
   * @param {object} target
   * @param {Function} loader
   * @returns {Promise<object>} 实际读取结果
   */
  function refresh(target, loader, { acceptWriteSnapshot = false } = {}) {
    if (target.state.pendingKeys.size) {
      if (!target.queuedRead) {
        let resolve
        const promise = new Promise((done) => { resolve = done })
        target.queuedRead = { loader, promise, resolve, acceptWriteSnapshot }
      }
      // 显式重新读取不能被一次命令的快照代替。
      if (!acceptWriteSnapshot) target.queuedRead.acceptWriteSnapshot = false
      publish(target, { refreshState: 'busy' })
      return target.queuedRead.promise
    }
    if (target.read) return target.read.promise
    const stamp = target.epoch
    const task = { loader }
    target.read = task
    publish(target, { refreshState: 'busy', status: target.state.snapshot ? 'ready' : 'loading' })
    task.promise = (async () => {
      let result
      try {
        result = await loader()
      } catch (error) {
        result = { success: false, error: error?.message || 'SKILL_CONTROL_SCAN_FAILED' }
      }
      if (stamp !== target.epoch) return { success: false, error: 'STALE_REQUEST' }
      if (result?.success && result.data) {
        applySnapshot(target, result.data)
        return result
      }
      const error = result?.error || 'SKILL_CONTROL_SCAN_FAILED'
      publish(target, { error, status: 'error', refreshState: 'error' })
      return { success: false, error }
    })().finally(() => {
      if (target.read === task) target.read = null
    })
    return task.promise
  }

  /**
   * 发布主进程写后核对的快照，同一项阻止重复写入。
   * 不同项也串行执行，因为每次命令返回的是整个资产库快照。
   * @param {object} target
   * @param {string} operationKey
   * @param {Function} runner
   * @returns {Promise<object>} 命令结果
   */
  function execute(target, operationKey, runner) {
    if (target.state.pendingKeys.has(operationKey)) return Promise.resolve({ success: false, error: 'OPERATION_PENDING' })
    target.epoch += 1
    if (target.read) target.interruptedLoader = target.read.loader
    target.read = null
    publish(target, { pendingKeys: new Set(target.state.pendingKeys).add(operationKey), refreshState: 'idle' })
    const operation = target.writeTail.then(async () => {
      let result
      try {
        result = await runner()
        if (result?.snapshot) {
          target.interruptedLoader = null
          applySnapshot(target, result.snapshot)
        }
        return result || { success: false, error: 'SKILL_CONTROL_COMMAND_FAILED' }
      } catch (error) {
        return { success: false, error: error?.message || 'SKILL_CONTROL_COMMAND_FAILED' }
      } finally {
        target.epoch += 1
        const pendingKeys = new Set(target.state.pendingKeys)
        pendingKeys.delete(operationKey)
        publish(target, { pendingKeys })
        if (!pendingKeys.size && target.queuedRead) {
          const queued = target.queuedRead
          target.queuedRead = null
          target.interruptedLoader = null
          if (queued.acceptWriteSnapshot && result?.snapshot) {
            // 操作中切回时，主进程刚核对的整份快照就是这次回访的新结果。
            queued.resolve({ success: true, data: result.snapshot })
          } else {
            refresh(target, queued.loader).then(queued.resolve)
          }
        } else if (!pendingKeys.size && target.interruptedLoader) {
          // 命令失败且没有实时快照时，补回被它打断的后台核对。
          const loader = target.interruptedLoader
          target.interruptedLoader = null
          refresh(target, loader)
        }
      }
    })
    target.writeTail = operation.then(() => undefined)
    return operation
  }

  /**
   * #101 放进上次关应用前的快照：这一格还没有任何快照、也没有进行中的操作才放；之后实时结果一到整份换掉。
   * @param {object} target
   * @param {object} snapshot
   * @returns {boolean} 放进去了没有
   */
  function seed(target, snapshot) {
    if (!snapshot || target.state.snapshot || target.state.pendingKeys.size) return false
    publish(target, { snapshot, status: 'ready', error: null })
    return true
  }

  let lastView = null
  /**
   * 本次运行只向主进程要一次「上次的」（之后都有本次运行的快照了）。
   * @param {Function} loader
   * @returns {Promise<object|null>}
   */
  function loadLastView(loader) {
    if (!lastView) {
      lastView = Promise.resolve()
        .then(loader)
        .then((result) => (result?.success ? result.data || null : null), () => null)
    }
    return lastView
  }

  return {
    entry, refresh, execute, seed, loadLastView,
    subscribe(target, listener) {
      target.listeners.add(listener)
      return () => target.listeners.delete(listener)
    },
    setBrowsing(target, patch) { publish(target, patch) },
    lastRepoPath: null,
  }
}

/**
 * IPC bridge 身份限定运行配置上下文，隔离不同窗口和测试运行环境。
 * @param {object|null} api
 * @returns {object} 该上下文的缓存
 */
export function getSkillControlCache(api) {
  const context = api || offlineContext
  if (!contexts.has(context)) contexts.set(context, createSkillControlCache())
  return contexts.get(context)
}
