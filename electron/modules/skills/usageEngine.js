/** Sole ordinary Skill usage engine: current identity + transcript proof + durable history + load processes. */
const crypto = require('crypto')
const path = require('path')
const { readUsageSources } = require('./usageSources')
const { contextId, classifyContexts, removeProvenReplay, loadProcesses } = require('./usageContext')
const { readIndexedFiles, fileVersion } = require('./usageIndex')
const { reconcileHistory } = require('./usageHistory')
const { defaultLedgerPath } = require('../../services/skillInvocationLedgerService')
const queues = new Map()
const batches = new Map()
const DAY_MS = 86400000

function nowOf(deps, options) {
  if (options.now) return new Date(options.now)
  return deps.nowFn ? deps.nowFn() : deps.now ? new Date(deps.now) : new Date()
}
function collectUncertainty(registry, indexed, history, classes, inWindow) {
  const userCoverage = history.files.filter((file) => classes.get(contextId(file.meta)) !== 'independent')
  const diagnostics = [...registry.diagnostics, ...history.diagnostics]
  const state = {
    diagnostics,
    uncertain: new Map(),
    allPending:
      diagnostics.some((entry) => entry.scope === 'all') || userCoverage.some((file) => file.meta.invalidLines > 0),
    allError: diagnostics.some((entry) => entry.availability === 'error'),
  }
  const mark = (assetId, reason, availability = 'available') => {
    const prior = state.uncertain.get(assetId)
    state.uncertain.set(assetId, {
      reason,
      availability: prior?.availability === 'error' ? 'error' : availability,
    })
  }
  for (const file of userCoverage) {
    if (file.meta.invalidLines)
      state.diagnostics.push({
        code: 'TRANSCRIPT_COVERAGE_UNKNOWN',
        scope: 'all',
        tool: file.meta.tool,
      })
  }
  const possible = (candidate, reason, availability = 'available') => {
    if (candidate.name?.includes(':')) return
    const result = candidate.target
      ? registry.resolve(candidate.target, candidate.at)
      : { asset: registry.preferred.get(candidate.name) }
    if (result.excluded) return
    const asset = result.asset || registry.preferred.get(result.name || candidate.name)
    if (asset) mark(asset.assetId, reason, availability)
    else if (!candidate.name && !result.name) {
      state.allPending = true
      if (availability === 'error') state.allError = true
    }
  }
  for (const unavailable of indexed.unavailable) {
    if (unavailable.cached?.meta && classes.get(contextId(unavailable.cached.meta)) === 'independent') continue
    state.diagnostics.push({
      code: 'TRANSCRIPT_UNREADABLE',
      scope: unavailable.cached ? 'asset' : 'all',
      tool: unavailable.tool,
      availability: 'error',
    })
    const cached = unavailable.cached?.candidates
    if (cached?.length) for (const candidate of cached) possible(candidate, 'TRANSCRIPT_UNREADABLE', 'error')
    else {
      state.allPending = true
      state.allError = true
    }
  }
  for (const file of indexed.files) {
    if (file.stable || file.change === 'append-after-window' || classes.get(contextId(file.meta)) === 'independent')
      continue
    if (file.proof.candidates.length)
      for (const candidate of file.proof.candidates) possible(candidate, 'TRANSCRIPT_CHANGED_DURING_READ')
    else state.allPending = true
  }
  for (const candidate of history.pending)
    if (inWindow(candidate.at) && classes.get(candidate.contextId) !== 'independent')
      possible(candidate, candidate.reason || 'BODY_NOT_VERIFIED')
  for (const request of history.legacy)
    if (inWindow(request.at) && classes.get(request.contextId) !== 'independent')
      possible(request, 'LEGACY_REQUEST_NOT_VERIFIED')

  state.mark = mark
  state.possible = possible
  return state
}

function collectLoadEvents(registry, history, classes, inWindow, state) {
  const events = []
  for (const event of history.events) {
    if (!['read', 'injection'].includes(event.kind)) continue
    const resolved = registry.resolve(event.target, event.at)
    if (resolved.excluded) continue
    if (!resolved.asset) {
      if (inWindow(event.at)) state.possible(event, 'SOURCE_IDENTITY_UNKNOWN')
      continue
    }
    const classification = classes.get(event.contextId) || 'unknown'
    if (classification === 'unknown') {
      if (inWindow(event.at)) state.mark(resolved.asset.assetId, 'EXECUTION_CLASSIFICATION_UNKNOWN')
      continue
    }
    events.push({
      ...event,
      assetId: resolved.asset.assetId,
      skillName: resolved.asset.name,
      classification,
    })
  }
  return events
}

function summarizeAsset(asset, processes, state, batchId) {
  const loaded = processes.filter((record) => record.assetId === asset.assetId && record.classification === 'user')
  const assetState = state.uncertain.get(asset.assetId)
  const pending = state.allPending || Boolean(assetState)
  const first =
    loaded
      .map((record) => record.triggeredAt)
      .sort()
      .at(-1) || null
  const lastRead =
    loaded
      .map((record) => record.lastReadAt)
      .sort()
      .at(-1) || null
  return {
    name: asset.name,
    assetId: asset.assetId,
    kind: asset.kind,
    batchId,
    total: pending ? null : loaded.length,
    confirmedTotal: loaded.length,
    claude: loaded.filter((record) => record.tool === 'claude').length,
    codex: loaded.filter((record) => record.tool === 'codex').length,
    lastUsed: first,
    lastUsedAt: first,
    lastRead,
    completeness: pending ? 'pending' : 'complete',
    availability: state.allError || assetState?.availability === 'error' ? 'error' : 'available',
    uncertaintyScope: state.allPending ? 'all' : 'asset',
  }
}

function requestedSummaries(assets, registry, wantedIds, selectedIds, state) {
  return assets
    .filter((asset) => wantedIds.has(asset.assetId))
    .map((asset) => {
      if (selectedIds || asset.kind === 'central') return asset
      const copies = registry.assets.filter((entry) => entry.name === asset.name)
      if (copies.length < 2) return asset
      // A short name cannot choose between independent global copies. Explicit IDs stay independently complete.
      state.diagnostics.push({ code: 'SKILL_NAME_AMBIGUOUS', scope: 'asset', name: asset.name })
      return {
        ...asset,
        total: null,
        completeness: 'pending',
        uncertaintyScope: state.allPending ? 'all' : 'asset',
      }
    })
}

function assembleResult({
  registry,
  indexed,
  history,
  names,
  selectedIds,
  processes,
  state,
  now,
  start,
  days,
  batchId,
}) {
  const assets = registry.assets
    .map((asset) => summarizeAsset(asset, processes, state, batchId))
    .sort((a, b) => a.assetId.localeCompare(b.assetId))
  const wanted = selectedIds
    ? registry.assets.filter((asset) => selectedIds.has(asset.assetId))
    : [...registry.preferred.values()].filter((asset) => !names.size || names.has(asset.name))
  const wantedIds = new Set(wanted.map((asset) => asset.assetId))
  const skills = requestedSummaries(assets, registry, wantedIds, selectedIds, state)
  // A management snapshot may outlive an asset mapping change. An absent identity cannot establish zero.
  for (const name of selectedIds ? [] : names) {
    if (skills.some((asset) => asset.name === name)) continue
    skills.push({
      name,
      assetId: null,
      kind: 'unknown',
      batchId,
      total: null,
      confirmedTotal: 0,
      claude: 0,
      codex: 0,
      lastUsed: null,
      lastUsedAt: null,
      lastRead: null,
      completeness: 'pending',
      availability: state.allError || registry.diagnostics.some((entry) => entry.name === name) ? 'error' : 'available',
      uncertaintyScope: 'asset',
    })
  }
  skills.sort((a, b) => a.name.localeCompare(b.name))
  const records = processes
    .filter((record) => wantedIds.has(record.assetId) && record.classification === 'user')
    .sort((a, b) => b.triggeredAt.localeCompare(a.triggeredAt) || a.invocationId.localeCompare(b.invocationId))
  const independentRecords = processes
    .filter((record) => wantedIds.has(record.assetId) && record.classification === 'independent')
    .sort((a, b) => a.invocationId.localeCompare(b.invocationId))
  const sources = Object.fromEntries(
    Object.keys(registry.roots).map((tool) => [
      tool,
      indexed.unavailable.some((entry) => entry.tool === tool)
        ? 'error'
        : indexed.files.some((file) => file.tool === tool)
          ? 'available'
          : 'missing',
    ])
  )
  const result = {
    batchId,
    window: days,
    startTime: new Date(start).toISOString(),
    endTime: now.toISOString(),
    skills,
    assets,
    records,
    invocations: records,
    independentRecords,
    diagnostics: state.diagnostics,
    sources,
    totals: {
      total: skills.some((skill) => skill.total === null) ? null : records.length,
      confirmedTotal: records.length,
      claude: records.filter((record) => record.tool === 'claude').length,
      codex: records.filter((record) => record.tool === 'codex').length,
    },
    scanMeta: {
      ...indexed.scanMeta,
      historyWrites: history.writes,
      sources,
      lastScannedAt: now.toISOString(),
    },
  }
  return result
}

function rememberBatch(result, registry) {
  const key = registry.storeDir + ':' + result.batchId
  batches.set(key, { result, registry })
  while (batches.size > 24) batches.delete(batches.keys().next().value)
}

async function aggregate(deps, options = {}) {
  const registry = await readUsageSources(deps)
  const now = nowOf(deps, options)
  const days = typeof options.windowDays === 'number' && options.windowDays > 0 ? options.windowDays : 30
  const start = now.getTime() - days * DAY_MS
  const inWindow = (at) => Date.parse(at) >= start && Date.parse(at) <= now.getTime()
  const names = new Set(Array.isArray(options.skillNames) ? options.skillNames : [])
  const selectedIds = Array.isArray(options.assetIds) ? new Set(options.assetIds) : null
  if (selectedIds && [...selectedIds].some((id) => !registry.assets.some((asset) => asset.assetId === id)))
    throw new Error('SKILL_ASSET_ID_INVALID')
  const indexed = await readIndexedFiles(registry, deps, {
    ...options,
    snapshotEndTime: now.toISOString(),
  })
  const history = await reconcileHistory(registry, indexed, options.ledgerPath || defaultLedgerPath(deps.homeDir))
  const classes = classifyContexts(history.files)
  const state = collectUncertainty(registry, indexed, history, classes, inWindow)
  const events = collectLoadEvents(registry, history, classes, inWindow, state)
  const processes = loadProcesses(removeProvenReplay(events, history.files)).filter((record) =>
    inWindow(record.triggeredAt)
  )
  const batchId = crypto.randomUUID()
  const result = assembleResult({
    registry,
    indexed,
    history,
    names,
    selectedIds,
    processes,
    state,
    now,
    start,
    days,
    batchId,
  })
  rememberBatch(result, registry)
  return result
}
/**
 * 普通 Skill 唯一统计入口；同一私有存储串行处理并发查询。
 * @param {object} deps - 主进程 homeDir，以及可选 env/storeDir/nowFn。
 * @param {object} options - 名字或 assetIds、windowDays；内部校验可禁用索引。
 * @returns {Promise<object>} total=null 表示待核，confirmedTotal 为下限；
 * completeness 与 availability 分别表示证据是否完整、来源是否可读。
 * 返回随机 batchId 绑定当次资产、窗口及记录；只写并行的新索引/元数据历史，旧账本只读。
 */
function aggregateUsage(deps, options = {}) {
  const key = deps.storeDir || deps.homeDir
  const previous = queues.get(key) || Promise.resolve()
  const next = previous.catch(() => {}).then(() => aggregate(deps, options))
  queues.set(key, next)
  next
    .finally(() => {
      if (queues.get(key) === next) queues.delete(key)
    })
    .catch(() => {})
  return next
}
/**
 * 返回某一普通资产的确认加载过程；提供 batchId 时严格使用原聚合窗口与记录。
 * @param {object} deps - 与 aggregateUsage 相同的主进程依赖。
 * @param {object} options - assetId 或 skillName，以及可选 batchId/windowDays。
 * @returns {Promise<object>} 同批记录与完整性/可读性；批次失效或路径不再可读时拒绝。
 * 无批次时先执行聚合；检查记录来源权限，不读取正文，也不改用户资产或旧账本。
 */
async function listUsageRecords(deps, options = {}) {
  let batch
  if (options.batchId) {
    const registry = await readUsageSources(deps)
    batch = batches.get(registry.storeDir + ':' + options.batchId)
    if (!batch) throw new Error('SKILL_USAGE_BATCH_EXPIRED')
    if (JSON.stringify(registry.roots) !== JSON.stringify(batch.registry.roots))
      throw new Error('SKILL_USAGE_BATCH_EXPIRED')
    if (options.assetId && !registry.assets.some((asset) => asset.assetId === options.assetId))
      throw new Error('SKILL_USAGE_BATCH_EXPIRED')
    if (options.windowDays && batch.result.window !== options.windowDays) throw new Error('SKILL_USAGE_WINDOW_MISMATCH')
  } else {
    const result = await aggregateUsage(deps, {
      ...options,
      skillNames: options.skillName ? [options.skillName] : [],
    })
    const registry = await readUsageSources(deps)
    batch = { result, registry }
  }
  const selected = options.assetId
    ? batch.result.skills.find((asset) => asset.assetId === options.assetId)
    : batch.result.skills.find((asset) => asset.name === options.skillName)
  if (!selected) throw new Error('SKILL_ASSET_ID_INVALID')
  const records = batch.result.records.filter((record) => record.assetId === selected.assetId)
  for (const record of records) {
    const root = batch.registry.roots[record.tool]
    const file = path.resolve(root, record.session.relativePath)
    if (!file.startsWith(root + path.sep)) throw new Error('SKILL_RECORD_PATH_INVALID')
    try {
      await fileVersion(file)
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('SKILL_USAGE_SOURCE_UNREADABLE')
    }
  }
  return {
    batchId: batch.result.batchId,
    assetId: selected.assetId,
    skillName: selected.name,
    window: batch.result.window,
    startTime: batch.result.startTime,
    endTime: batch.result.endTime,
    completeness: selected.completeness,
    availability: selected.availability,
    records,
  }
}
module.exports = { aggregateUsage, listUsageRecords }
