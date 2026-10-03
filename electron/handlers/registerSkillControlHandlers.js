/**
 * Skill 控制中心 IPC 注册器
 *
 * IPC 只做参数收敛、服务调用与稳定错误返回；每次写操作完成后重新读取原生状态。
 * 读就是读：读快照不改任何配置。Codex 旧写法的补关挂在 Codex 写操作上，由服务在来源检查通过之后、
 * 真正写入之前调用（被拒绝的操作不补关）；补关失败自己恢复备份，不挡这次写操作。
 * 写操作失败时也尽量带回一份新快照，让页面按实际状态显示。
 * 资产库路径一律由主进程按配置解析（skillRepoPath），页面传来的路径不用（#61 延后项，v2.1.11 起）。
 *
 * Skills 要处理（v2.1.11）：
 * - 同一个名字的写操作排队，一次只做一个（定稿状态清单 C14）
 * - 写完只重读动到的名字和相关工具，其余沿用上次读到的结果（B4）；「重新读取」仍全量读
 * - 结果带真实 outcome：done / done-unverified（做完了但随后状态没读出来）/ not-run / rolled-back / partial / needs-confirm
 *
 * @module electron/handlers/registerSkillControlHandlers
 */

const { getSkillControlSnapshot, executeSkillCommand } = require('../services/skillControlService')
const { migrateLegacyCodexDisables } = require('../services/skillAdapters/codexSkillAdapter')
const { resolveSkillRepoPath } = require('../services/skillRepoPath')
const journal = require('../modules/skills/operationJournal')
const { readIgnores } = require('../modules/skills/ignoreStore')
const { slotPaths, isLibraryLink } = require('../modules/skills/slotGuard')
const fs = require('fs/promises')

// 页面能传的字段；其余（包括资产库路径、项目列表）一律不收
const COMMAND_FIELDS = ['skillName', 'toolId', 'action', 'sourceId', 'source', 'keep', 'expect', 'operationId', 'ignoreId', 'confirmed', 'enabled', 'overrideState']
const BOTH_TOOLS = ['claude-code', 'codex']

function errorCode(error, fallback) {
  return error?.code || error?.message || fallback
}

function pickCommand(params) {
  const out = {}
  for (const key of COMMAND_FIELDS) {
    if (params && params[key] !== undefined) out[key] = params[key]
  }
  return out
}

/** Codex 写入前后核对时拿到的列表，留给写完后的刷新用 */
function createListMemo() {
  let value = null
  return {
    set(next) { value = next },
    take() { const out = value; value = null; return out },
  }
}

function registerSkillControlHandlers({ ipcMain, homeDir }, deps = {}) {
  const getSnapshot = deps.getSkillControlSnapshotFn || getSkillControlSnapshot
  const execute = deps.executeSkillCommandFn || executeSkillCommand
  const migrate = deps.migrateLegacyCodexDisablesFn || migrateLegacyCodexDisables
  const resolveRepoPath = deps.resolveSkillRepoPathFn || resolveSkillRepoPath
  // 上次读到的完整结果：单个操作后只重读动到的那一部分，其余从这里沿用
  const discoveryCache = {}
  const locks = new Map()

  const readSnapshot = async (extra = {}, overrides = {}) => getSnapshot({
    repoPath: await resolveRepoPath({ homeDir }, deps),
    homeDir,
    ...extra,
  }, { ...deps, discoveryCache, ...overrides })

  /** 这个命令动的是哪个名字（同名排队用） */
  async function nameOf(command) {
    if (command.skillName) return command.skillName
    if (command.operationId) {
      const op = await journal.readOperation(homeDir, command.operationId).catch(() => null)
      if (op) return op.name
    }
    if (command.ignoreId) {
      const entry = (await readIgnores(homeDir)).find((item) => item.ignoreId === command.ignoreId)
      if (entry) return entry.name
    }
    return `__${command.action || 'unknown'}`
  }

  /** 哪些工具的全局位置上有这个名字（删除前算：删完就看不出来了） */
  async function toolsHolding(name) {
    const out = []
    for (const toolId of BOTH_TOOLS) {
      for (const slot of slotPaths(homeDir, toolId, name)) {
        if (await fs.lstat(slot).then(() => true, () => false)) {
          out.push(toolId)
          break
        }
      }
    }
    return out
  }

  /** 哪些工具链着资产库里这一份（「换成这一份」时它们也跟着变） */
  async function toolsLinkedTo(name, libraryPath) {
    const out = []
    for (const toolId of BOTH_TOOLS) {
      for (const slot of slotPaths(homeDir, toolId, name)) {
        if (await isLibraryLink(slot, libraryPath)) {
          out.push(toolId)
          break
        }
      }
    }
    return out
  }

  /**
   * 写完要重读哪些工具：只算真正动到的（B4）
   * @param {object} command
   * @param {string|null} operationId
   * @param {object|null} data - 命令返回
   * @param {{holding?: string[]}} before - 动手前算好的（删除用）
   */
  async function toolsFor(command, operationId, data, before = {}) {
    if (['enable', 'disable', 'set-enabled', 'set-override', 'clear-override', 'remove-tool', 'adopt'].includes(command.action)) {
      return command.toolId ? [command.toolId] : BOTH_TOOLS
    }
    if (command.action === 'delete') return before.holding || BOTH_TOOLS
    if (['collect', 'undo', 'resume'].includes(command.action)) {
      if (data?.needsConfirm) return []
      const op = operationId ? await journal.readOperation(homeDir, operationId).catch(() => null) : null
      if (!op) return []
      const tools = new Set([op.toolId])
      if (op.libraryMode === 'replace') for (const toolId of await toolsLinkedTo(op.name, op.library.path)) tools.add(toolId)
      for (const dependent of op.undoPlan?.dependents || []) tools.add(dependent.toolId)
      return BOTH_TOOLS.filter((toolId) => tools.has(toolId))
    }
    return []
  }

  function withLock(name, task) {
    const previous = locks.get(name) || Promise.resolve()
    const run = previous.then(task, task)
    locks.set(name, run.catch(() => {}))
    return run
  }

  ipcMain.handle('skill-control:get-repo-path', async () => {
    try {
      return { success: true, data: await resolveRepoPath({ homeDir }, deps), error: null }
    } catch (error) {
      return { success: false, data: null, error: errorCode(error, 'SKILL_REPO_PATH_FAILED') }
    }
  })

  ipcMain.handle('skill-control:get-snapshot', async () => {
    try {
      return { success: true, data: await readSnapshot(), error: null }
    } catch (error) {
      return { success: false, data: null, error: errorCode(error, 'SKILL_CONTROL_SCAN_FAILED') }
    }
  })

  ipcMain.handle('skill-control:execute', async (_event, params) => {
    const command = pickCommand(params)
    let repoPath
    try {
      repoPath = await resolveRepoPath({ homeDir }, deps)
    } catch (error) {
      return { success: false, data: { outcome: 'not-run' }, snapshot: null, error: errorCode(error, 'SKILL_REPO_PATH_FAILED') }
    }
    const name = await nameOf(command)
    return withLock(name, async () => {
      // 补关失败不挡这次写操作：它自己恢复了备份，下次动 Codex 时再试
      const codexListMemo = createListMemo()
      let migrated = false
      const beforeCodexWriteFn = async () => {
        const result = await migrate({ homeDir }, deps).catch(() => null)
        if (result?.status === 'migrated') migrated = true
        return result
      }
      const callDeps = { ...deps, codexListMemo, beforeCodexWriteFn }
      const before = command.action === 'delete' && command.skillName ? { holding: await toolsHolding(command.skillName) } : {}
      const refresh = async (operationId, data) => {
        // 补关真的改了别的 Skill 在 Codex 里的开关：整页重读（只在旧写法补关那一次发生）
        if (migrated) return readSnapshot({}, { codexListMemo })
        const toolIds = await toolsFor(command, operationId, data, before)
        const names = command.skillName ? [command.skillName] : name.startsWith('__') ? [] : [name]
        return readSnapshot({ only: { names, toolIds } }, { codexListMemo })
      }
      let data
      try {
        data = await execute({ ...command, repoPath, homeDir }, callDeps)
      } catch (error) {
        // 失败后重读一次：状态不确定时页面要按实际显示；重读也失败就不带快照
        const snapshot = await refresh(error?.operationId || command.operationId, null).catch(() => null)
        return {
          success: false,
          data: { outcome: error?.outcome || 'not-run', operationId: error?.operationId || null, reason: error?.reason || null, snapshot },
          snapshot,
          error: errorCode(error, 'SKILL_CONTROL_COMMAND_FAILED'),
        }
      }
      let snapshot
      try {
        snapshot = await refresh(data?.operationId || command.operationId, data)
      } catch {
        // 做完了，但随后状态没读出来：不能说成失败，也不能说已恢复
        const outcome = data?.outcome === 'done' || !data?.outcome ? 'done-unverified' : data.outcome
        return { success: true, data: { ...data, outcome, snapshot: null }, snapshot: null, error: null }
      }
      return { success: true, data: { ...data, outcome: data?.outcome || 'done', snapshot }, snapshot, error: null }
    })
  })
}

module.exports = { registerSkillControlHandlers }
