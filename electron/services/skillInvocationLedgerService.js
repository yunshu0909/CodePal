/**
 * Skill invocation v2 账本服务
 *
 * 负责：
 * - 校验冻结的 9 字段 invocation schema
 * - 容错读取 JSONL、幂等 upsert 与稳定排序
 * - 使用 temp → fsync → rename 原子替换账本
 * - 将 v1 账本备份后从原 transcript 全量重建 v2
 *
 * @module electron/services/skillInvocationLedgerService
 */

const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const crypto = require('crypto')

const INVOCATION_KEYS = [
  'schemaVersion',
  'invocationId',
  'skillName',
  'tool',
  'triggerType',
  'triggeredAt',
  'session',
  'sourceLine',
  'classifierVersion',
]
const SESSION_KEYS = ['id', 'relativePath']
let writeQueue = Promise.resolve()

function defaultLedgerPath(homeDir) {
  return path.join(homeDir, 'Documents', 'SkillManager', '.codepal', 'skill-runs.jsonl')
}

function hasExactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => actual.includes(key))
}

/**
 * 判断记录是否严格符合冻结的 v2 schema。
 * @param {object} record - 待校验记录
 * @returns {boolean}
 */
function isV2Invocation(record) {
  if (!hasExactKeys(record, INVOCATION_KEYS)) return false
  if (record.schemaVersion !== 2) return false
  if (typeof record.invocationId !== 'string' || !record.invocationId) return false
  if (typeof record.skillName !== 'string' || !record.skillName) return false
  if (!['claude', 'codex'].includes(record.tool)) return false
  if (!['claude_tool_use', 'claude_slash', 'codex_dollar', 'goal_directive'].includes(record.triggerType)) return false
  if (typeof record.triggeredAt !== 'string' || !Number.isFinite(Date.parse(record.triggeredAt))) return false
  if (!hasExactKeys(record.session, SESSION_KEYS)) return false
  if (typeof record.session.id !== 'string' || !record.session.id) return false
  if (typeof record.session.relativePath !== 'string' || !record.session.relativePath) return false
  if (!Number.isInteger(record.sourceLine) || record.sourceLine < 1) return false
  return typeof record.classifierVersion === 'string' && Boolean(record.classifierVersion)
}

function sortInvocations(records) {
  return [...records].sort((a, b) => (
    Date.parse(a.triggeredAt) - Date.parse(b.triggeredAt)
    || a.invocationId.localeCompare(b.invocationId)
  ))
}

/**
 * 容错读取 invocation ledger。
 * @param {object} params - 读取参数
 * @returns {Promise<object>}
 */
async function readInvocationLedger(params = {}) {
  const { homeDir, ledgerPath = defaultLedgerPath(homeDir) } = params
  let content
  try {
    content = await fsp.readFile(ledgerPath, 'utf-8')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        path: ledgerPath,
        state: 'missing',
        records: [],
        legacyRecords: [],
        unparsableLineCount: 0,
        legacyLineCount: 0,
      }
    }
    throw error
  }

  const records = []
  const legacyRecords = []
  let unparsableLineCount = 0
  let legacyLineCount = 0
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      unparsableLineCount += 1
      continue
    }
    if (isV2Invocation(parsed)) records.push(parsed)
    else {
      legacyRecords.push(parsed)
      legacyLineCount += 1
    }
  }

  let state = unparsableLineCount > 0 ? 'corrupt' : 'empty'
  if (records.length && legacyRecords.length) state = 'mixed'
  else if (records.length) state = 'v2'
  else if (legacyRecords.length) state = 'v1'

  return {
    path: ledgerPath,
    state,
    records: sortInvocations(records),
    legacyRecords,
    unparsableLineCount,
    legacyLineCount,
  }
}

async function syncDirectory(directory) {
  let handle
  try {
    handle = await fsp.open(directory, 'r')
    await handle.sync()
  } catch {
    // 部分平台不支持目录 fsync；文件本身已在 rename 前完成 fsync。
  } finally {
    await handle?.close().catch(() => {})
  }
}

async function atomicWriteUnlocked({ ledgerPath, records, beforeRename }) {
  if (!records.every(isV2Invocation)) {
    throw new Error('INVALID_SKILL_INVOCATION_SCHEMA')
  }
  const sorted = sortInvocations(records)
  const directory = path.dirname(ledgerPath)
  await fsp.mkdir(directory, { recursive: true })
  const token = crypto.randomBytes(6).toString('hex')
  const tempPath = path.join(directory, `${path.basename(ledgerPath)}.tmp-${process.pid}-${token}`)
  const content = sorted.map((record) => JSON.stringify(record)).join('\n') + (sorted.length ? '\n' : '')
  let handle

  try {
    handle = await fsp.open(tempPath, 'wx', 0o600)
    await handle.writeFile(content, 'utf-8')
    await handle.sync()
    await handle.close()
    handle = null
    if (typeof beforeRename === 'function') await beforeRename(tempPath)
    await fsp.rename(tempPath, ledgerPath)
    await syncDirectory(directory)
    return { path: ledgerPath, count: sorted.length }
  } catch (error) {
    await handle?.close().catch(() => {})
    await fsp.rm(tempPath, { force: true }).catch(() => {})
    throw error
  }
}

function withWriteLock(task) {
  const run = writeQueue.catch(() => {}).then(task)
  writeQueue = run.catch(() => {})
  return run
}

/**
 * 原子替换完整 v2 ledger。
 * @param {object} params - 写入参数
 * @returns {Promise<object>}
 */
function atomicWriteInvocationLedger(params = {}) {
  const {
    homeDir,
    ledgerPath = defaultLedgerPath(homeDir),
    records = [],
    beforeRename,
  } = params
  return withWriteLock(() => atomicWriteUnlocked({ ledgerPath, records, beforeRename }))
}

/**
 * 按 invocationId 串行幂等 upsert，防止并发 aggregate 丢更新。
 * @param {object} params - upsert 参数
 * @returns {Promise<object>}
 */
function upsertInvocations(params = {}) {
  const {
    homeDir,
    ledgerPath = defaultLedgerPath(homeDir),
    records = [],
  } = params
  if (!records.every(isV2Invocation)) {
    return Promise.reject(new Error('INVALID_SKILL_INVOCATION_SCHEMA'))
  }

  return withWriteLock(async () => {
    const existing = await readInvocationLedger({ homeDir, ledgerPath })
    if (existing.state === 'v1' || existing.state === 'mixed') {
      throw new Error('SKILL_INVOCATION_LEDGER_REQUIRES_MIGRATION')
    }
    const byId = new Map(existing.records.map((record) => [record.invocationId, record]))
    for (const record of records) byId.set(record.invocationId, record)
    return atomicWriteUnlocked({
      ledgerPath,
      records: Array.from(byId.values()),
    })
  })
}

/**
 * 按 invocationId 删除已经确认属于 fork replay 的历史幽灵记录。
 * @param {object} params - 删除参数
 * @returns {Promise<object>}
 */
function removeInvocationsById(params = {}) {
  const {
    homeDir,
    ledgerPath = defaultLedgerPath(homeDir),
    invocationIds = [],
  } = params
  const ids = new Set(invocationIds.filter(Boolean))
  if (ids.size === 0) return Promise.resolve({ path: ledgerPath, count: 0, removedCount: 0 })

  return withWriteLock(async () => {
    const existing = await readInvocationLedger({ homeDir, ledgerPath })
    if (existing.state === 'v1' || existing.state === 'mixed') {
      throw new Error('SKILL_INVOCATION_LEDGER_REQUIRES_MIGRATION')
    }
    const remaining = existing.records.filter((record) => !ids.has(record.invocationId))
    const removedCount = existing.records.length - remaining.length
    if (removedCount === 0) {
      return { path: ledgerPath, count: existing.records.length, removedCount: 0 }
    }
    const written = await atomicWriteUnlocked({ ledgerPath, records: remaining })
    return { ...written, removedCount }
  })
}

function backupTimestamp(date) {
  return date.toISOString().replace(/[-:.]/g, '')
}

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex')
}

async function createOrReuseLegacyBackup(ledgerPath, now) {
  const directory = path.dirname(ledgerPath)
  const sourceContent = await fsp.readFile(ledgerPath)
  const sourceHash = sha256(sourceContent)
  const existingNames = await fsp.readdir(directory).catch(() => [])
  const backupNames = existingNames
    .filter((name) => name.startsWith('skill-runs.v1.backup-') && name.endsWith('.jsonl'))
    .sort()

  for (const name of backupNames) {
    const candidate = path.join(directory, name)
    try {
      const candidateContent = await fsp.readFile(candidate)
      if (sha256(candidateContent) === sourceHash) {
        return { path: candidate, reused: true }
      }
    } catch {
      // 某个旧备份不可读不阻断本次迁移，继续尝试创建新备份。
    }
  }

  const base = path.join(directory, `skill-runs.v1.backup-${backupTimestamp(now)}`)
  let index = 0
  while (true) {
    const suffix = index === 0 ? '' : `-${index}`
    const candidate = `${base}${suffix}.jsonl`
    try {
      await fsp.copyFile(ledgerPath, candidate, fs.constants.COPYFILE_EXCL)
      return { path: candidate, reused: false }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      index += 1
    }
  }
}

/**
 * 确保账本为 v2；legacy 账本只能从 transcript 重建，禁止 record 转换。
 * @param {object} params - 迁移参数
 * @returns {Promise<object>}
 */
function ensureV2InvocationLedger(params = {}) {
  const {
    homeDir,
    ledgerPath = defaultLedgerPath(homeDir),
    rebuildFn,
    nowFn = () => new Date(),
  } = params

  return withWriteLock(async () => {
    const current = await readInvocationLedger({ homeDir, ledgerPath })
    if (current.state === 'v2') {
      return {
        records: current.records,
        migrated: false,
        migrationFailed: false,
        unparsableLineCount: current.unparsableLineCount,
        legacyLineCount: current.legacyLineCount,
      }
    }
    if (current.state === 'missing' || current.state === 'empty') {
      return {
        records: [],
        migrated: false,
        migrationFailed: false,
        initialized: true,
        unparsableLineCount: current.unparsableLineCount,
        legacyLineCount: current.legacyLineCount,
      }
    }

    let backupPath = null
    let backupReused = false
    try {
      const backup = await createOrReuseLegacyBackup(ledgerPath, nowFn())
      backupPath = backup.path
      backupReused = backup.reused
      if (typeof rebuildFn !== 'function') {
        throw new Error('SKILL_INVOCATION_REBUILD_REQUIRED')
      }
      const rebuiltResult = await rebuildFn()
      const rebuilt = Array.isArray(rebuiltResult)
        ? rebuiltResult
        : rebuiltResult?.invocations
      if (!Array.isArray(rebuilt) || !rebuilt.every(isV2Invocation)) {
        throw new Error('INVALID_SKILL_INVOCATION_REBUILD')
      }
      // mixed ledger 中已经有效的 v2 记录可能对应已被清理的 transcript，迁移不能抹掉。
      const byId = new Map(current.records.map((record) => [record.invocationId, record]))
      for (const record of rebuilt) byId.set(record.invocationId, record)
      const merged = sortInvocations(Array.from(byId.values()))
      await atomicWriteUnlocked({ ledgerPath, records: merged })
      return {
        records: merged,
        migrated: true,
        migrationFailed: false,
        backupPath,
        backupReused,
        unparsableLineCount: current.unparsableLineCount,
        legacyLineCount: current.legacyLineCount,
      }
    } catch (error) {
      return {
        records: current.records,
        legacyRecords: current.legacyRecords,
        migrated: false,
        migrationFailed: true,
        backupPath,
        backupReused,
        migrationError: error?.message || 'SKILL_INVOCATION_MIGRATION_FAILED',
        unparsableLineCount: current.unparsableLineCount,
        legacyLineCount: current.legacyLineCount,
      }
    }
  })
}

module.exports = {
  defaultLedgerPath,
  isV2Invocation,
  readInvocationLedger,
  atomicWriteInvocationLedger,
  upsertInvocations,
  removeInvocationsById,
  ensureV2InvocationLedger,
  sortInvocations,
  INVOCATION_KEYS,
}
