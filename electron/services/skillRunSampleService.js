/**
 * Skill 调用记录兼容编排服务
 *
 * 负责：
 * - 保留旧 service / IPC 命名，避免无价值的跨层重命名
 * - 编排 transcript scanner、v2 ledger 迁移与近 30 天聚合
 * - 为详情提供只读账本 + source availability 查询
 *
 * 原始日志只负责发现，v2 ledger 负责记住、计数和列详情。
 *
 * @module electron/services/skillRunSampleService
 */

const {
  scanSkillInvocations,
} = require('./skillInvocationScannerService')
const {
  defaultLedgerPath,
  readInvocationLedger,
  upsertInvocations,
  removeInvocationsById,
  ensureV2InvocationLedger,
  atomicWriteInvocationLedger,
} = require('./skillInvocationLedgerService')
const {
  getInvocationSourceAvailability,
  getTranscriptRoot,
  toTranscriptRelativePath,
  findUniqueTranscriptBySessionId,
} = require('./transcriptLocatorService')

const DAY_MS = 24 * 60 * 60 * 1000

function inWindow(timestamp, startMs, endMs) {
  const value = Date.parse(timestamp)
  return Number.isFinite(value) && value >= startMs && value <= endMs
}

function summarizeInvocations(records, nameSet) {
  const byName = new Map()
  const ensure = (name) => {
    let entry = byName.get(name)
    if (!entry) {
      entry = {
        name,
        total: 0,
        claude: 0,
        codex: 0,
        lastUsedAt: null,
      }
      byName.set(name, entry)
    }
    return entry
  }

  for (const record of records) {
    if (nameSet.size > 0 && !nameSet.has(record.skillName)) continue
    const entry = ensure(record.skillName)
    entry.total += 1
    if (record.tool === 'claude' || record.tool === 'codex') {
      entry[record.tool] += 1
    }
    if (!entry.lastUsedAt || Date.parse(record.triggeredAt) > Date.parse(entry.lastUsedAt)) {
      entry.lastUsedAt = record.triggeredAt
    }
  }

  const skills = Array.from(byName.values())
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
  const totals = skills.reduce((result, skill) => ({
    total: result.total + skill.total,
    claude: result.claude + skill.claude,
    codex: result.codex + skill.codex,
  }), { total: 0, claude: 0, codex: 0 })
  return { skills, totals }
}

function summarizeLegacyRecords(records, nameSet, startMs, endMs) {
  const normalized = records
    .filter((record) => record?.isUsable === true)
    .filter((record) => inWindow(record.timestamp, startMs, endMs))
    .filter((record) => nameSet.size === 0 || nameSet.has(record.skillRequested))
    .map((record, index) => ({
      schemaVersion: 1,
      invocationId: record.sampleId || `legacy-${index}`,
      skillName: record.skillRequested,
      tool: record.tool,
      triggeredAt: record.timestamp,
    }))
  return summarizeInvocations(normalized, nameSet)
}

async function repairInvocationRelativePaths(records, { homeDir, env, allFilePaths }) {
  const repaired = []
  for (const record of records) {
    const availability = await getInvocationSourceAvailability(record, { homeDir, env })
    if (availability === 'available') continue
    const match = findUniqueTranscriptBySessionId(
      record.session.id,
      allFilePaths?.[record.tool] || []
    )
    if (!match) continue
    const root = getTranscriptRoot(record.tool, { homeDir, env })
    repaired.push({
      ...record,
      session: {
        ...record.session,
        relativePath: toTranscriptRelativePath(root, match),
      },
    })
  }
  return repaired
}

/**
 * 扫描新 invocation、迁移/upsert ledger，并从 ledger 聚合近 N 天数字。
 * @param {object} deps - 依赖
 * @param {string} deps.homeDir - 用户主目录
 * @param {NodeJS.ProcessEnv|object} [deps.env] - 自定义工具 root
 * @param {() => Date} [deps.nowFn] - 当前时间工厂
 * @param {object} params - 扫描参数
 * @returns {Promise<object>}
 */
async function scanSkillRunSamples(deps, params = {}) {
  const {
    homeDir,
    env = process.env,
    nowFn = () => new Date(),
  } = deps
  const now = nowFn()
  const windowDays = typeof params.windowDays === 'number' && params.windowDays > 0
    ? params.windowDays
    : 30
  const startMs = now.getTime() - windowDays * DAY_MS
  const endMs = now.getTime()
  const nameSet = new Set(Array.isArray(params.skillNames) ? params.skillNames : [])
  const ledgerPath = params.ledgerPath || defaultLedgerPath(homeDir)
  let migrationScan = null

  const migration = await ensureV2InvocationLedger({
    homeDir,
    ledgerPath,
    nowFn,
    rebuildFn: async () => {
      if (nameSet.size === 0) {
        throw new Error('SKILL_NAMES_REQUIRED_FOR_MIGRATION')
      }
      migrationScan = await scanSkillInvocations(
        { homeDir, env, nowFn },
        {
          windowDays,
          skillNames: Array.from(nameSet),
          scanAll: true,
          maxLinesPerFile: Infinity,
        }
      )
      if (Object.values(migrationScan.sources).includes('error')) {
        throw new Error('SKILL_INVOCATION_SOURCE_SCAN_FAILED')
      }
      return migrationScan.invocations
    },
  })

  if (migration.migrationFailed) {
    const legacySummary = summarizeLegacyRecords(
      migration.legacyRecords || [],
      nameSet,
      startMs,
      endMs
    )
    const preservedV2 = (migration.records || [])
      .filter((record) => inWindow(record.triggeredAt, startMs, endMs))
    const v2Summary = summarizeInvocations(preservedV2, nameSet)
    const mergedSkills = new Map()
    for (const skill of [...v2Summary.skills, ...legacySummary.skills]) {
      const current = mergedSkills.get(skill.name) || {
        name: skill.name,
        total: 0,
        claude: 0,
        codex: 0,
        lastUsedAt: null,
      }
      current.total += skill.total
      current.claude += skill.claude
      current.codex += skill.codex
      if (!current.lastUsedAt || (skill.lastUsedAt && Date.parse(skill.lastUsedAt) > Date.parse(current.lastUsedAt))) {
        current.lastUsedAt = skill.lastUsedAt
      }
      mergedSkills.set(skill.name, current)
    }
    const skills = Array.from(mergedSkills.values())
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
    const totals = skills.reduce((result, skill) => ({
      total: result.total + skill.total,
      claude: result.claude + skill.claude,
      codex: result.codex + skill.codex,
    }), { total: 0, claude: 0, codex: 0 })
    const sources = migrationScan?.sources || { claude: 'error', codex: 'error' }
    return {
      window: windowDays,
      startTime: new Date(startMs).toISOString(),
      endTime: now.toISOString(),
      skills,
      totals,
      sources,
      scanMeta: {
        lastScannedAt: now.toISOString(),
        sources,
        unresolvedForkCount: 0,
        claudeSlashToolUseOverlapCount: 0,
        migrationFailed: true,
      },
      diagnostics: {
        migrationError: migration.migrationError,
        unparsableLedgerLineCount: migration.unparsableLineCount || 0,
        legacyLedgerLineCount: migration.legacyLineCount || 0,
        legacyFallback: true,
      },
      ledgerPath,
      invocations: [],
    }
  }

  const scanResult = migration.migrated
    ? migrationScan
    : await scanSkillInvocations(
      { homeDir, env, nowFn },
      {
        windowDays,
        skillNames: Array.from(nameSet),
        maxLinesPerFile: Infinity,
      }
    )

  if (!migration.migrated) {
    await upsertInvocations({
      homeDir,
      ledgerPath,
      records: scanResult.invocations,
    })
  }
  const reconciliation = await removeInvocationsById({
    homeDir,
    ledgerPath,
    invocationIds: scanResult?.suppressedInvocationIds || [],
  })

  let ledger = await readInvocationLedger({ homeDir, ledgerPath })
  let windowRecords = ledger.records
    .filter((record) => inWindow(record.triggeredAt, startMs, endMs))
    .filter((record) => nameSet.size === 0 || nameSet.has(record.skillName))
  const repaired = await repairInvocationRelativePaths(windowRecords, {
    homeDir,
    env,
    allFilePaths: scanResult?.allFilePaths,
  })
  if (repaired.length > 0) {
    await upsertInvocations({ homeDir, ledgerPath, records: repaired })
    ledger = await readInvocationLedger({ homeDir, ledgerPath })
    windowRecords = ledger.records
      .filter((record) => inWindow(record.triggeredAt, startMs, endMs))
      .filter((record) => nameSet.size === 0 || nameSet.has(record.skillName))
  }
  const summary = summarizeInvocations(windowRecords, nameSet)
  const sources = scanResult?.sources || { claude: 'missing', codex: 'missing' }
  const scannerDiagnostics = scanResult?.diagnostics || {}

  return {
    window: windowDays,
    startTime: new Date(startMs).toISOString(),
    endTime: now.toISOString(),
    ...summary,
    sources,
    scanMeta: {
      lastScannedAt: now.toISOString(),
      sources,
      unresolvedForkCount: scannerDiagnostics.unresolvedForkCount || 0,
      claudeSlashToolUseOverlapCount: scannerDiagnostics.claudeSlashToolUseOverlapCount || 0,
      migrationFailed: false,
    },
    diagnostics: {
      ...scannerDiagnostics,
      unparsableLedgerLineCount: ledger.unparsableLineCount || 0,
      legacyLedgerLineCount: ledger.legacyLineCount || 0,
      migrated: migration.migrated === true,
      backupPath: migration.backupPath || null,
      backupReused: migration.backupReused === true,
      reconciledReplayCount: reconciliation.removedCount || 0,
      repairedRelativePathCount: repaired.length,
    },
    ledgerPath,
    invocations: windowRecords,
  }
}

/**
 * 只读 ledger，返回单个 Skill 的调用记录及 source availability。
 * 此路径禁止扫描目录或读取 transcript 内容。
 * @param {object} deps - 依赖
 * @param {object} params - 查询参数
 * @returns {Promise<object>}
 */
async function listSkillInvocationRecords(deps, params = {}) {
  const {
    homeDir,
    env = process.env,
    nowFn = () => new Date(),
    accessFn,
  } = deps
  const skillName = typeof params.skillName === 'string' ? params.skillName : ''
  if (!skillName) throw new Error('SKILL_NAME_REQUIRED')
  const windowDays = typeof params.windowDays === 'number' && params.windowDays > 0
    ? params.windowDays
    : 30
  const now = nowFn()
  const startMs = now.getTime() - windowDays * DAY_MS
  const ledgerPath = params.ledgerPath || defaultLedgerPath(homeDir)
  const ledger = await readInvocationLedger({ homeDir, ledgerPath })
  const selected = ledger.records
    .filter((record) => record.skillName === skillName)
    .filter((record) => inWindow(record.triggeredAt, startMs, now.getTime()))
    .sort((a, b) => (
      Date.parse(b.triggeredAt) - Date.parse(a.triggeredAt)
      || b.invocationId.localeCompare(a.invocationId)
    ))

  const records = await Promise.all(selected.map(async (record) => ({
    ...record,
    sourceAvailable: await getInvocationSourceAvailability(record, {
      homeDir,
      env,
      ...(accessFn ? { accessFn } : {}),
    }),
  })))

  return {
    skillName,
    window: windowDays,
    startTime: new Date(startMs).toISOString(),
    endTime: now.toISOString(),
    records,
    ledgerPath,
    migrationRequired: ledger.state === 'v1' || ledger.state === 'mixed',
  }
}

/**
 * 兼容旧测试/调用方的 ledger 数组读取；返回值已经是 v2 invocation。
 * @param {object} params - 读取参数
 * @returns {Promise<object[]>}
 */
async function loadSkillRunLedger(params = {}) {
  const ledger = await readInvocationLedger(params)
  const nowFn = params.nowFn || (() => new Date())
  const startMs = typeof params.windowDays === 'number' && params.windowDays > 0
    ? nowFn().getTime() - params.windowDays * DAY_MS
    : null
  return ledger.records
    .filter((record) => !params.skillName || record.skillName === params.skillName)
    .filter((record) => startMs === null || Date.parse(record.triggeredAt) >= startMs)
}

/**
 * 兼容旧命名的完整 v2 ledger 写入；不接受 legacy sample。
 * @param {object} params - 写入参数
 * @returns {Promise<object>}
 */
function writeSkillRunLedger(params = {}) {
  return atomicWriteInvocationLedger(params)
}

module.exports = {
  scanSkillRunSamples,
  listSkillInvocationRecords,
  loadSkillRunLedger,
  writeSkillRunLedger,
  defaultLedgerPath,
  summarizeInvocations,
  repairInvocationRelativePaths,
}
