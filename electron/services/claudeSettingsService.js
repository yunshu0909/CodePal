/**
 * Claude settings.json 文件操作服务
 *
 * 负责：
 * - 读取并解析 ~/.claude/settings.json
 * - 备份 settings 文件
 * - **settings.json 唯一写入口**（writeClaudeSettingsFile：串行队列 + 备份 + 原子写）
 * - 确保 apiKeyHelper 脚本存在
 * - 将供应商配置应用到 settings
 *
 * V1.9.8 起全应用对 settings.json 的写入必须走本模块的 writeClaudeSettingsFile，
 * 禁止各模块自行 read-modify-write（防止并发互相覆盖 + 备份位置漂移）。
 *
 * @module electron/services/claudeSettingsService
 */

const fs = require('fs/promises')
const fsConstants = require('fs').constants
const path = require('path')
const os = require('os')
const { normalizeEnvValue, atomicWriteText } = require('./envFileService')

/**
 * 判断是否为普通对象
 * @param {unknown} value - 待检查的值
 * @returns {boolean}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 生成备份文件名时间戳
 * @returns {string}
 */
function createBackupTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

// 模块级路径常量：写入口和备份必须全应用唯一，不能随工厂多实例漂移
const CLAUDE_SETTINGS_FILE_PATH = path.join(os.homedir(), '.claude', 'settings.json')
const CLAUDE_SETTINGS_BACKUP_DIR = path.join(os.homedir(), '.claude', 'backups')

/**
 * 推导某个 settings 文件对应的备份目录
 *
 * 默认全应用唯一（`~/.claude/backups/`）；仅当调用方传入 `filePath`（即它自己持有
 * 另一个根目录，如 Skill adapter 的 `homeDir` 参数）时，备份落到该文件同级目录下，
 * 与业务文件同根——既保持同根可追溯，也避免把沙箱/测试的写入泄漏到真实家目录。
 * @param {string} [filePath] - 目标 settings 路径；须与 CLAUDE_SETTINGS_FILE_PATH 同形
 * @returns {string} 备份目录绝对路径
 */
function resolveBackupDir(filePath) {
  if (!filePath || filePath === CLAUDE_SETTINGS_FILE_PATH) return CLAUDE_SETTINGS_BACKUP_DIR
  return path.join(path.dirname(filePath), 'backups')
}

/**
 * 备份 Claude settings 原始内容（默认统一落 ~/.claude/backups/）
 * @param {string} rawContent - 原始文件内容
 * @param {string} suffix - 备份后缀
 * @param {string} [backupDir] - 备份目录；缺省用全应用唯一目录
 * @returns {Promise<{success: boolean, backupPath: string|null, errorCode: string|null, error: string|null}>}
 */
async function backupClaudeSettingsRaw(rawContent, suffix = 'snapshot', backupDir = CLAUDE_SETTINGS_BACKUP_DIR) {
  try {
    // 备份目录私有化：mkdir 的 mode 只影响新建目录，已存在的目录必须显式收紧
    await fs.mkdir(backupDir, { recursive: true, mode: PRIVATE_DIR_MODE })
    await fs.chmod(backupDir, PRIVATE_DIR_MODE).catch(() => {})

    const base = `settings-${suffix}-${createBackupTimestamp()}`
    // 用 wx 独占创建：同毫秒重名时**不覆盖已有备份**，换个名字重试
    let backupPath = null
    let handle = null
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const candidate = path.join(backupDir, attempt === 0 ? `${base}.json` : `${base}-${attempt}.json`)
      try {
        handle = await fs.open(candidate, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, PRIVATE_FILE_MODE)
        backupPath = candidate
        break
      } catch (error) {
        if (error.code === 'EEXIST') continue
        throw error
      }
    }
    if (!backupPath || !handle) {
      return { success: false, backupPath: null, errorCode: 'WRITE_FAILED', error: '无法创建 Claude settings 备份文件（重名过多）' }
    }

    // 原始字节原样落地，不做任何编码转换；fsync 后才算备份成立
    await handle.writeFile(rawContent)
    await handle.sync()
    await handle.close()
    return { success: true, backupPath, errorCode: null, error: null }
  } catch (error) {
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      return { success: false, backupPath: null, errorCode: 'PERMISSION_DENIED', error: '无法写入 Claude settings 备份，请检查权限' }
    }
    if (error.code === 'ENOSPC') {
      return { success: false, backupPath: null, errorCode: 'DISK_FULL', error: '磁盘空间不足，无法写入 Claude settings 备份' }
    }
    return { success: false, backupPath: null, errorCode: 'WRITE_FAILED', error: `写入 Claude settings 备份失败: ${error.message}` }
  }
}


/**
 * 模块级串行队列——settings 写入的**唯一互斥点**
 *
 * 工厂可能多实例（provider / usage-status 各建一个），所以队列必须挂模块级，
 * 不能随实例漂移。
 *
 * **边界（如实声明）**：互斥范围是**同一 JavaScript 执行环境、且解析到同一个模块缓存
 * 条目的调用**。这里"同进程 + 同 require 缓存"还不够精确——同一缓存里可以存在不同路径
 * 的两份模块副本，worker 也有各自独立的执行环境。
 * - 生产：主进程入口是原始 `electron/main.js`，electron-builder 递归打包 electron 目录，
 *   Vite 不参与主进程打包 → 普通路径下只有一份模块实例，队列唯一
 * - 若打包器产出重复副本、或出现跨进程写入者 → **队列不共享**，串行保证失效，
 *   只剩原子替换 + 提交前复验 + readback 兜底，**不构成跨进程原子 CAS**
 */
let settingsWriteQueue = Promise.resolve()

/** 私有文件/目录权限（settings 与备份，防同机其他用户读取） */
const PRIVATE_FILE_MODE = 0o600
const PRIVATE_DIR_MODE = 0o700
/** Node 在部分平台不提供 O_NOFOLLOW，缺失时降级为 0（并保留 lstat 前置判定） */
const O_NOFOLLOW = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0

/** 把文件系统错误映射为统一错误码 */
function mapFsError(error) {
  const code = error && error.code
  if (code === 'EACCES' || code === 'EPERM') return 'PERMISSION_DENIED'
  if (code === 'ENOSPC') return 'DISK_FULL'
  if (code === 'ELOOP') return 'SETTINGS_SYMLINK_REJECTED'
  return 'READ_FAILED'
}

/**
 * 检测 CodePal 尚未统一支持的 `CLAUDE_CONFIG_DIR` 自定义配置根
 *
 * 背景：Claude Code 用 `CLAUDE_CONFIG_DIR` 改变 settings / 历史等所有用户目录的位置，
 * 而 CodePal 目前只有部分模块认这个变量（如 transcriptLocatorService），settings 写入
 * 仍固定 `~/.claude`。两边不一致时**会把配置写到错误的位置并报告成功**。
 *
 * 处置（评审认可的缩减方案）：**明确拒绝，不悄悄回退默认根**。
 * 完整统一（含 skills / hooks / MCP / session 等全部路径）留作独立工作单元。
 *
 * @returns {{errorCode: string, error: string}|null} 需要拒绝时返回错误对象，否则 null
 */
function detectUnsupportedCustomRoot() {
  const configured = process.env.CLAUDE_CONFIG_DIR
  if (typeof configured !== 'string' || configured.trim() === '') return null
  const expectedDir = path.resolve(path.join(os.homedir(), '.claude'))
  const resolved = path.resolve(configured.trim())
  if (resolved === expectedDir) return null
  return {
    errorCode: 'SETTINGS_CUSTOM_ROOT_UNSUPPORTED',
    error: `检测到 CLAUDE_CONFIG_DIR=${resolved}，但 CodePal 尚未把该自定义配置根全链统一；`
      + '为避免把配置写到错误位置，本次写入被拒绝。请取消该环境变量后重试。',
  }
}

/**
 * 安全读取一个 settings 文件并分类
 *
 * 分类是唯一事实源：**不存在 / 合法对象 / 损坏 / 结构异常 / 权限拒绝 / 不支持的文件类型
 * / 符号链接**七态分明。用 `O_NOFOLLOW` 在同一次 open 中拒绝符号链接，不用 lstat 前置
 * （`lstat → open` 之间存在换链窗口）。只有 `ENOENT` 才算"不存在"——任何其他错误
 * 都必须如实上报，绝不能当成"不存在"从而放行创建。
 *
 * 同时给出**原始字节** `rawBytes`（Buffer，备份与回读比对以此为准）与**文本** `raw`
 * （仅供 JSON 解析）。两者分开的原因：非法 UTF-8 经文本解码会产生替换字符，
 * 用文本做备份会破坏原始内容。
 *
 * 打开时带 `O_NONBLOCK`：目标是 FIFO 时不会永久阻塞（否则会占死整个写入队列），
 * 随后由 `stat.isFile()` 判型拒绝。
 *
 * @param {string} filePath - 目标文件绝对路径
 * @returns {Promise<{kind: string, rawBytes: Buffer|null, raw: string, data: Record<string, any>|null, exists: boolean, errorCode: string|null, error: string|null}>}
 */
async function readSettingsFileState(filePath) {
  let handle
  try {
    // O_NOFOLLOW：符号链接直接 ELOOP，不跟随；O_NONBLOCK：FIFO 不阻塞
    const flags = fsConstants.O_RDONLY | O_NOFOLLOW | (fsConstants.O_NONBLOCK || 0)
    handle = await fs.open(filePath, flags)
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { kind: 'missing', rawBytes: null, raw: '', data: null, exists: false, errorCode: null, error: null }
    }
    if (error.code === 'ELOOP') {
      return { kind: 'symlink', rawBytes: null, raw: '', data: null, exists: true, errorCode: 'SETTINGS_SYMLINK_REJECTED', error: 'settings 路径是符号链接，拒绝读写' }
    }
    const errorCode = mapFsError(error)
    return { kind: 'io_error', rawBytes: null, raw: '', data: null, exists: false, errorCode, error: `无法读取 Claude settings.json: ${error.message}` }
  }

  try {
    const stat = await handle.stat()
    if (!stat.isFile()) {
      return { kind: 'unsupported', rawBytes: null, raw: '', data: null, exists: true, errorCode: 'SETTINGS_UNSUPPORTED_FILE_TYPE', error: 'settings 路径不是普通文件' }
    }
    const rawBytes = await handle.readFile()
    // 文本视图仅供解析；非法 UTF-8 在这里可能出现替换字符，但备份/比对一律走 rawBytes
    const raw = rawBytes.toString('utf-8')
    let data = null
    try {
      data = JSON.parse(raw)
    } catch {
      return { kind: 'corrupt', rawBytes, raw, data: null, exists: true, errorCode: 'CONFIG_CORRUPTED', error: 'Claude settings.json 已损坏（JSON 解析失败）' }
    }
    if (!isPlainObject(data)) {
      return { kind: 'corrupt', rawBytes, raw, data: null, exists: true, errorCode: 'CONFIG_CORRUPTED', error: 'Claude settings.json 结构异常（顶层不是对象）' }
    }
    return { kind: 'valid', rawBytes, raw, data, exists: true, errorCode: null, error: null }
  } catch (error) {
    const errorCode = mapFsError(error)
    return { kind: 'io_error', rawBytes: null, raw: '', data: null, exists: false, errorCode, error: `无法读取 Claude settings.json: ${error.message}` }
  } finally {
    await handle.close().catch(() => {})
  }
}

/**
 * 事务内排他创建 settings 文件（完整临时文件 → `link` 无替换发布）
 *
 * 为什么不用「`wx` 直接打开正式目标再写」：那会让目标**先以空文件/半成品出现**，
 * 进程若在写入途中崩溃或断电，目标已存在但内容是坏的，且没有任何备份可恢复。
 * 也不在失败时 `rm(filePath)`——期间目标可能已被别人换成新内容，删掉就是毁掉别人的数据。
 *
 * 改用：同目录临时文件写满 + `fsync` → `fs.link(temp, target)` 发布。
 * `link` 在目标已存在时返回 `EEXIST`，是真正的 no-replace；失败时只清理**自己的**临时文件。
 *
 * @param {string} filePath - 目标文件
 * @param {Buffer} contentBytes - 完整文件内容（原始字节）
 * @returns {Promise<{success: boolean, committed: boolean, errorCode: string|null, error: string|null}>}
 */
async function createSettingsFileExclusive(filePath, contentBytes) {
  const tempPath = `${filePath}.codepal-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`
  let handle
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: PRIVATE_DIR_MODE })
    handle = await fs.open(tempPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, PRIVATE_FILE_MODE)
    await handle.writeFile(contentBytes)
    await handle.sync()
    await handle.close()
    handle = null
  } catch (error) {
    if (handle) await handle.close().catch(() => {})
    await fs.rm(tempPath, { force: true }).catch(() => {})   // 只删自己的临时文件
    const errorCode = error.code === 'EACCES' || error.code === 'EPERM'
      ? 'PERMISSION_DENIED'
      : error.code === 'ENOSPC' ? 'DISK_FULL' : 'WRITE_FAILED'
    return { success: false, committed: false, errorCode, error: `创建 Claude settings.json 失败: ${error.message}` }
  }

  try {
    await fs.link(tempPath, filePath)   // no-replace：目标已存在即 EEXIST
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {})
    if (error.code === 'EEXIST') {
      return { success: false, committed: false, errorCode: 'SETTINGS_ALREADY_EXISTS', error: 'settings.json 已被其他操作创建，本次未写入' }
    }
    const errorCode = error.code === 'EACCES' || error.code === 'EPERM' ? 'PERMISSION_DENIED' : 'WRITE_FAILED'
    return { success: false, committed: false, errorCode, error: `创建 Claude settings.json 失败: ${error.message}` }
  }
  await fs.rm(tempPath, { force: true }).catch(() => {})

  let durability = 'synced'
  try {
    const dirHandle = await fs.open(path.dirname(filePath), 'r')
    await dirHandle.sync()
    await dirHandle.close()
  } catch {
    durability = 'unsynced'
  }

  const readback = await readSettingsFileState(filePath)
  if (readback.kind !== 'valid' || !readback.rawBytes || !readback.rawBytes.equals(contentBytes)) {
    return { success: false, committed: true, errorCode: 'SETTINGS_READBACK_MISMATCH', error: '文件已创建但回读校验失败，内容与预期不一致' }
  }
  return { success: true, committed: true, durability, errorCode: null, error: null }
}

/**
 * 原子替换已存在的 settings 文件（临时文件 + rename + 目录 fsync + readback）
 *
 * 临时文件用 `wx` 独占创建并显式 0600；rename 后回读校验，不符即报
 * `SETTINGS_READBACK_MISMATCH`。
 *
 * **残余竞争窗口（如实声明）**：rename 的原子性不包含版本条件。本次写完最后一次校验
 * 之后、rename 之前，若有**绕过本队列的进程外写入者**改动目标，仍会被本次 rename 覆盖，
 * 且 readback 读到的是本次内容、无法发现。本函数不构成跨进程原子 CAS。
 *
 * @param {string} filePath - 目标文件
 * @param {string} content - 完整文件内容
 * @returns {Promise<{success: boolean, errorCode: string|null, error: string|null}>}
 */
async function replaceSettingsFileAtomically(filePath, contentBytes, { expectedBytes = null } = {}) {
  const tempPath = `${filePath}.codepal-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`
  let handle
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: PRIVATE_DIR_MODE })
    handle = await fs.open(tempPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, PRIVATE_FILE_MODE)
    await handle.writeFile(contentBytes)
    await handle.sync()
    await handle.close()
    handle = null
  } catch (error) {
    if (handle) await handle.close().catch(() => {})
    await fs.rm(tempPath, { force: true }).catch(() => {})
    const errorCode = error.code === 'EACCES' || error.code === 'EPERM'
      ? 'PERMISSION_DENIED'
      : error.code === 'ENOSPC' ? 'DISK_FULL' : 'WRITE_FAILED'
    return { success: false, committed: false, errorCode, error: `写入 Claude settings.json 失败: ${error.message}` }
  }

  try {
    // 提交前复验：确认目标仍是本次事务读到的内容，否则说明期间被外部改写 → 放弃，不改动目标。
    // 这不能消除"复验到 rename 之间"的残余窗口（见上方声明），但能挡住整个 mutator / 备份
    // 期间发生的改动。
    if (expectedBytes) {
      const current = await readSettingsFileState(filePath)
      // 只比字节，不要求 current 是 valid——损坏修复（含零字节）时原文本来就解析不出来
      const unchanged = current.rawBytes && current.rawBytes.equals(expectedBytes)
      if (!unchanged) {
        await fs.rm(tempPath, { force: true }).catch(() => {})
        return { success: false, committed: false, errorCode: 'SETTINGS_CONFLICT', error: 'settings.json 在本次写入期间被外部修改，已放弃写入' }
      }
    }
    await fs.rename(tempPath, filePath)
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {})
    const errorCode = error.code === 'EACCES' || error.code === 'EPERM'
      ? 'PERMISSION_DENIED'
      : error.code === 'ENOSPC' ? 'DISK_FULL' : 'WRITE_FAILED'
    return { success: false, committed: false, errorCode, error: `写入 Claude settings.json 失败: ${error.message}` }
  }

  // 目标已被替换（committed=true）。此后任何失败都不得谎报成"完全没写"。
  let durability = 'synced'
  try {
    const dirHandle = await fs.open(path.dirname(filePath), 'r')
    await dirHandle.sync()
    await dirHandle.close()
  } catch {
    // 目录项未持久化：极端断电下有丢失风险，但本次替换确实已生效
    durability = 'unsynced'
  }

  const readback = await readSettingsFileState(filePath)
  if (readback.kind !== 'valid' || !readback.rawBytes || !readback.rawBytes.equals(contentBytes)) {
    return {
      success: false,
      committed: true,
      durability,
      errorCode: 'SETTINGS_READBACK_MISMATCH',
      error: '文件已替换但回读校验失败，内容与预期不一致',
    }
  }
  return { success: true, committed: true, durability, errorCode: null, error: null }
}

/**
 * settings.json 唯一写入口（事务版）：排队 → 读真实状态 → 交 mutator → 备份 → 提交
 *
 * 与 `writeClaudeSettingsFile` 的差别是本函数把**读**也纳入事务：读、判断、改字段、
 * 备份、提交在同一个队列任务里完成，因此不存在"调用方持有旧快照再整体写回"这一步，
 * 也不会因两个调用方各自读到同一版本而丢失对方的字段。
 *
 * **依赖当前文件状态的判断必须写在 mutator 内**（例如"是否已被用户改成自定义命令、
 * 是否允许从不存在状态创建"）——写在外面就等于把过期决定带进来。
 *
 * **残余风险（如实声明）**：本函数只对共享本队列的调用方串行。绕过队列的进程外写入者
 * 仍可能在最后一次校验之后、提交之前改动目标并被覆盖；本函数不构成跨进程原子 CAS。
 *
 * @param {Object} options
 * @param {(context: {state: Object, data: Record<string, any>, raw: string, exists: boolean, kind: string}) => {ok: boolean, errorCode?: string, error?: string, next?: Record<string, any>, create?: boolean, backup?: boolean, allowCorruptRepair?: boolean, backupSuffix?: string}} mutator
 *   `state` = `{kind, exists, errorCode, error, raw}`；返回 `ok:false` 即中止且不写入。
 *   - `create: true` 表示"文件当前不存在则创建"；若文件已存在则走更新（除非 `updateExisting: false`）
 *   - `updateExisting: false` 配合 `create: true` 表示"只允许创建，已存在即冲突"
 *   - `allowCorruptRepair: true` 表示调用方同意在备份损坏内容后以空对象重建
 * @param {string} [options.filePath] - 目标路径；默认模块级唯一路径
 * @param {string} [options.backupSuffix] - 备份后缀
 * @returns {Promise<{success: boolean, backupPath: string|null, errorCode: string|null, error: string|null, exists: boolean}>}
 */
async function mutateClaudeSettingsFile(mutator, { filePath = CLAUDE_SETTINGS_FILE_PATH, backupSuffix = 'settings' } = {}) {
  if (typeof mutator !== 'function') {
    return { success: false, committed: false, backupPath: null, errorCode: 'INVALID_MUTATOR', error: 'mutator 必须是函数', exists: false }
  }

  // 默认根写入前先确认 CLAUDE_CONFIG_DIR 没有把它挪走（绝不悄悄写错位置）
  if (filePath === CLAUDE_SETTINGS_FILE_PATH) {
    const unsupported = detectUnsupportedCustomRoot()
    if (unsupported) {
      return { success: false, committed: false, backupPath: null, exists: false, ...unsupported }
    }
  }

  const run = async () => {
    const state = await readSettingsFileState(filePath)

    // 读取层已能定性的失败：权限、符号链接、非普通文件、IO 错误 —— 不交给 mutator 决定
    if (state.kind === 'symlink' || state.kind === 'unsupported' || state.kind === 'io_error') {
      return { success: false, committed: false, backupPath: null, errorCode: state.errorCode, error: state.error, exists: state.exists }
    }

    const data = state.kind === 'valid' ? state.data : {}
    // 传入完整的 state，并**同时**在顶层展开 errorCode/error/raw/rawBytes，
    // 避免调用方按任一种写法解构都拿不到值。
    const outcome = await mutator({
      state: { kind: state.kind, exists: state.exists, errorCode: state.errorCode, error: state.error, raw: state.raw, rawBytes: state.rawBytes },
      data,
      raw: state.raw,
      rawBytes: state.rawBytes,
      exists: state.exists,
      kind: state.kind,
      errorCode: state.errorCode,
      error: state.error,
    })
    if (!outcome || outcome.ok !== true) {
      return {
        success: false,
        committed: false,
        backupPath: null,
        errorCode: (outcome && outcome.errorCode) || 'MUTATION_REFUSED',
        error: (outcome && outcome.error) || '变更被拒绝',
        exists: state.exists,
      }
    }

    const next = outcome.next
    if (!isPlainObject(next)) {
      return { success: false, committed: false, backupPath: null, errorCode: 'INVALID_SETTINGS_DATA', error: 'mutator 返回的 settings 必须是普通对象', exists: state.exists }
    }

    const repairingCorrupt = state.kind === 'corrupt'
    if (repairingCorrupt && outcome.allowCorruptRepair !== true) {
      return { success: false, committed: false, backupPath: null, errorCode: 'CONFIG_CORRUPTED', error: state.error, exists: true }
    }

    // **不存在的目标必须显式声明创建意图**：否则一次"更新"会顺手建出文件，
    // 掩盖调用方对状态判断的错误（也挡住静默复活被删除的配置）。
    if (state.kind === 'missing' && outcome.create !== true) {
      return { success: false, committed: false, backupPath: null, errorCode: 'SETTINGS_MISSING', error: 'settings.json 不存在，且本次操作未声明创建意图', exists: false }
    }

    const createMode = outcome.create === true && !state.exists

    // create-only 语义：调用方声明"只允许创建"，而文件已存在 → 冲突，绝不覆盖
    if (outcome.create === true && outcome.updateExisting === false && state.exists) {
      return { success: false, committed: false, backupPath: null, errorCode: 'SETTINGS_ALREADY_EXISTS', error: 'settings.json 已存在，本次操作为仅创建', exists: true }
    }

    // 备份策略：修复损坏必留一份；更新已存在文件、或调用方明确要求时留一份。
    // 用 rawBytes（原始字节）——零字节文件同样是有效内容，必须备份，不能因"falsy"跳过。
    let backupPath = null
    const needsBackup = repairingCorrupt || (!createMode && state.kind === 'valid' && outcome.backup !== false) || outcome.backup === true
    if (needsBackup && state.exists && state.rawBytes) {
      const suffix = repairingCorrupt ? 'corrupted' : (outcome.backupSuffix || backupSuffix)
      const backupResult = await backupClaudeSettingsRaw(state.rawBytes, suffix, resolveBackupDir(filePath))
      if (!backupResult.success) {
        // 备份失败即中止，绝不替换目标
        return { success: false, committed: false, backupPath: null, errorCode: backupResult.errorCode, error: backupResult.error, exists: state.exists }
      }
      backupPath = backupResult.backupPath
    }

    const contentBytes = Buffer.from(`${JSON.stringify(next, null, 2)}\n`, 'utf-8')
    const writeResult = createMode
      ? await createSettingsFileExclusive(filePath, contentBytes)
      : await replaceSettingsFileAtomically(filePath, contentBytes, {
        // 提交前复验：目标必须仍是本次事务读到的字节，否则说明期间被外部改写 → 放弃。
        // 损坏修复同样适用（原文不得被换掉），缺失态走创建分支、不经过这里。
        expectedBytes: state.exists ? state.rawBytes : null,
      })

    if (!writeResult.success) {
      return {
        success: false,
        committed: writeResult.committed === true,
        backupPath,
        errorCode: writeResult.errorCode,
        error: writeResult.error,
        exists: state.exists,
      }
    }
    return { success: true, committed: true, durability: writeResult.durability, backupPath, errorCode: null, error: null, exists: true }
  }

  // 前一个任务失败也不阻塞后续（错误已通过各自返回值上抛）
  const result = settingsWriteQueue.then(run, run)
  settingsWriteQueue = result.then(() => {}, () => {})
  return result
}

/**
 * settings.json 唯一写入口（**已废弃，仅供历史测试/兼容**）
 *
 * ⚠️ 新代码一律使用 `mutateClaudeSettingsFile`。本函数接收**调用方已构造好的整份
 * settings 对象**并整体写回，正是"调用方持有旧快照"这一丢更新来源的形态；
 * 它不做读、不做提交前复验，保留只为不破坏既有调用契约。
 *
 * 步骤：
 * 1. settingsData 必须是普通对象，否则 INVALID_SETTINGS_DATA
 * 2. 进模块级串行队列（settings.json 全应用同一路径，写写互斥）
 * 3. previousContent 非空时先备份，备份失败即中止不写
 * 4. atomicWriteText 写入格式化 JSON（尾换行）
 *
 * @param {Record<string, any>} settingsData - 要写入的完整 settings 对象
 * @param {Object} [options]
 * @param {string} [options.backupSuffix] - 备份文件后缀（标记写入来源）
 * @param {string} [options.previousContent] - 写前原始内容，非空则先备份
 * @param {string} [options.filePath] - 目标 settings 路径；默认模块级唯一路径。
 *   仅限调用方持有**来自参数的家目录**（如 Skill adapter 的 `homeDir`）时传入，
 *   保证读写的根目录与调用方一致；不传则沿用全应用唯一路径，行为不变。
 * @returns {Promise<{success: boolean, backupPath: string|null, errorCode: string|null, error: string|null}>}
 */
async function writeClaudeSettingsFile(
  settingsData,
  { backupSuffix = 'settings', previousContent = '', filePath = CLAUDE_SETTINGS_FILE_PATH } = {},
) {
  if (!isPlainObject(settingsData)) {
    return { success: false, backupPath: null, errorCode: 'INVALID_SETTINGS_DATA', error: 'settings 数据必须是普通对象' }
  }
  if (filePath === CLAUDE_SETTINGS_FILE_PATH) {
    const unsupported = detectUnsupportedCustomRoot()
    if (unsupported) {
      return { success: false, backupPath: null, ...unsupported }
    }
  }

  const run = async () => {
    let backupPath = null
    if (previousContent) {
      const backupResult = await backupClaudeSettingsRaw(previousContent, backupSuffix, resolveBackupDir(filePath))
      if (!backupResult.success) {
        return { success: false, backupPath: null, errorCode: backupResult.errorCode, error: backupResult.error }
      }
      backupPath = backupResult.backupPath
    }
    // 注意：atomicWriteText 失败通过返回值上报（{success:false, error:'CODE'}），不抛异常
    const writeResult = await atomicWriteText(filePath, `${JSON.stringify(settingsData, null, 2)}\n`)
    if (!writeResult.success) {
      const code = writeResult.error || 'WRITE_FAILED'
      if (code === 'PERMISSION_DENIED') {
        return { success: false, backupPath, errorCode: 'PERMISSION_DENIED', error: '无法写入 Claude settings.json，请检查权限' }
      }
      if (code === 'DISK_FULL') {
        return { success: false, backupPath, errorCode: 'DISK_FULL', error: '磁盘空间不足，无法写入 Claude settings.json' }
      }
      return { success: false, backupPath, errorCode: 'WRITE_FAILED', error: `写入 Claude settings.json 失败: ${code}` }
    }
    return { success: true, backupPath, errorCode: null, error: null }
  }

  // 前一个写失败也不阻塞后续（错误已通过各自返回值上抛）
  const result = settingsWriteQueue.then(run, run)
  settingsWriteQueue = result.then(() => {}, () => {})
  return result
}

/**
 * 创建 Claude settings 服务实例
 * @param {Object} deps - 依赖注入
 * @param {(filepath: string) => Promise<boolean>} deps.pathExists - 路径存在检查
 * @returns {Object} Claude settings 服务
 */
function createClaudeSettingsService({ pathExists }) {
  const CLAUDE_API_KEY_HELPER_FILE_NAME = 'skill-manager-api-key-helper.sh'
  const CLAUDE_API_KEY_HELPER_PATH = path.join(path.dirname(CLAUDE_SETTINGS_FILE_PATH), CLAUDE_API_KEY_HELPER_FILE_NAME)
  const CLAUDE_API_KEY_HELPER_CONTENT = `#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
SETTINGS_FILE="$SCRIPT_DIR/settings.json"
if [ ! -f "$SETTINGS_FILE" ]; then
  exit 1
fi
node -e '
const fs=require("fs")
const settingsPath=process.argv[1]
const settings=JSON.parse(fs.readFileSync(settingsPath,"utf8"))
const env=settings&&typeof settings==="object"&&settings.env&&typeof settings.env==="object"
  ? settings.env
  : {}
const token=(env.ANTHROPIC_API_KEY||env.ANTHROPIC_AUTH_TOKEN||"").trim()
if (token) {
  process.stdout.write(token + "\\n")
}
' "$SETTINGS_FILE"
`

  /**
   * 确保 Claude apiKeyHelper 脚本存在
   * @returns {Promise<{success: boolean, helperPath: string|null, errorCode: string|null, error: string|null}>}
   */
  async function ensureClaudeApiKeyHelperScript() {
    try {
      await fs.mkdir(path.dirname(CLAUDE_API_KEY_HELPER_PATH), { recursive: true })
      await fs.writeFile(CLAUDE_API_KEY_HELPER_PATH, CLAUDE_API_KEY_HELPER_CONTENT, {
        encoding: 'utf-8',
        mode: 0o700,
      })
      await fs.chmod(CLAUDE_API_KEY_HELPER_PATH, 0o700)
      return { success: true, helperPath: CLAUDE_API_KEY_HELPER_PATH, errorCode: null, error: null }
    } catch (error) {
      if (error.code === 'EACCES' || error.code === 'EPERM') {
        return { success: false, helperPath: null, errorCode: 'PERMISSION_DENIED', error: '无法写入 Claude apiKeyHelper 脚本，请检查权限' }
      }
      if (error.code === 'ENOSPC') {
        return { success: false, helperPath: null, errorCode: 'DISK_FULL', error: '磁盘空间不足，无法写入 Claude apiKeyHelper 脚本' }
      }
      return { success: false, helperPath: null, errorCode: 'WRITE_FAILED', error: `写入 Claude apiKeyHelper 脚本失败: ${error.message}` }
    }
  }

  /**
   * 读取 Claude settings.json 文件
   * @returns {Promise<{success: boolean, exists: boolean, content: string, data: Record<string, any>, errorCode: string|null, error: string|null, backupPath: string|null}>}
   */
  async function readClaudeSettingsFile() {
    try {
      const exists = await pathExists(CLAUDE_SETTINGS_FILE_PATH)
      if (!exists) {
        return { success: true, exists: false, content: '', data: {}, errorCode: null, error: null, backupPath: null }
      }

      const content = await fs.readFile(CLAUDE_SETTINGS_FILE_PATH, 'utf-8')
      let data

      try {
        data = JSON.parse(content)
      } catch {
        const backupResult = await backupClaudeSettingsRaw(content, 'corrupted')
        const backupMessage = backupResult.success
          ? `已备份到 ${backupResult.backupPath}`
          : `备份失败（${backupResult.error || '未知错误'}）`
        return { success: false, exists: true, content, data: {}, errorCode: 'CONFIG_CORRUPTED', error: `Claude settings.json 已损坏，${backupMessage}`, backupPath: backupResult.backupPath || null }
      }

      if (!isPlainObject(data)) {
        const backupResult = await backupClaudeSettingsRaw(content, 'corrupted')
        const backupMessage = backupResult.success
          ? `已备份到 ${backupResult.backupPath}`
          : `备份失败（${backupResult.error || '未知错误'}）`
        return { success: false, exists: true, content, data: {}, errorCode: 'CONFIG_CORRUPTED', error: `Claude settings.json 结构异常，${backupMessage}`, backupPath: backupResult.backupPath || null }
      }

      return { success: true, exists: true, content, data, errorCode: null, error: null, backupPath: null }
    } catch (error) {
      if (error.code === 'EACCES' || error.code === 'EPERM') {
        return { success: false, exists: false, content: '', data: {}, errorCode: 'PERMISSION_DENIED', error: '无法读取 Claude settings.json，请检查权限', backupPath: null }
      }
      return { success: false, exists: false, content: '', data: {}, errorCode: 'READ_FAILED', error: `读取 Claude settings.json 失败: ${error.message}`, backupPath: null }
    }
  }

  /**
   * 将供应商档应用到 Claude settings 数据
   * @param {Record<string, any>} settingsData - 原始 settings 数据
   * @param {{token: string|null, baseUrl: string|null, model: string, settingsEnv?: Record<string, string>}} profile - 目标供应商档
   * @param {string[]} managedEnvKeys - 需要清理的 env keys
   * @returns {Record<string, any>}
   */
  function applyProviderProfileToSettings(settingsData, profile, managedEnvKeys) {
    const source = isPlainObject(settingsData) ? settingsData : {}
    const updated = JSON.parse(JSON.stringify(source))
    const envObject = isPlainObject(updated.env) ? updated.env : {}

    for (const key of managedEnvKeys) {
      delete envObject[key]
    }

    if (profile.token) {
      // 仅写 API_KEY：避免将第三方 sk-* 误当作 OAuth token 走账号登录链路。
      envObject.ANTHROPIC_API_KEY = profile.token
    }
    if (profile.baseUrl) {
      envObject.ANTHROPIC_BASE_URL = profile.baseUrl
    }
    if (isPlainObject(profile.settingsEnv)) {
      for (const [key, value] of Object.entries(profile.settingsEnv)) {
        const normalizedValue = normalizeEnvValue(value)
        if (normalizedValue) {
          envObject[key] = normalizedValue
        }
      }
    }

    updated.env = envObject
    if (profile.token) {
      // Claude CLI 登录判断优先读取 apiKeyHelper
      updated.apiKeyHelper = CLAUDE_API_KEY_HELPER_PATH
    } else {
      // Official 严格登录模式：无条件清理 apiKeyHelper
      delete updated.apiKeyHelper
    }
    updated.model = profile.model
    return updated
  }

  return {
    settingsFilePath: CLAUDE_SETTINGS_FILE_PATH,
    apiKeyHelperPath: CLAUDE_API_KEY_HELPER_PATH,
    backupClaudeSettingsRaw,
    writeClaudeSettingsFile,
    mutateClaudeSettingsFile,
    ensureClaudeApiKeyHelperScript,
    readClaudeSettingsFile,
    applyProviderProfileToSettings,
    isPlainObject,
  }
}

module.exports = {
  isPlainObject,
  resolveBackupDir,
  readSettingsFileState,
  backupClaudeSettingsRaw,
  writeClaudeSettingsFile,
  mutateClaudeSettingsFile,
  createClaudeSettingsService,
}
