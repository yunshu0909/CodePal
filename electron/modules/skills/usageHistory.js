/** Proven metadata history and legacy request reconciliation. Legacy v1/v2 files are always read-only. */
const fs = require('fs/promises')
const path = require('path')
const { hash } = require('./usageSources')
const { contextId } = require('./usageContext')
const { readJson, writeAtomic } = require('./usageIndex')

async function readLegacy(file) {
  let text
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return { requests: [], corrupt: false }
    return { requests: [], corrupt: false, unreadable: true }
  }
  const requests = []
  let corrupt = false
  for (const line of text.split('\n').filter((item) => item.trim())) {
    let record
    try {
      record = JSON.parse(line)
    } catch {
      corrupt = true
      continue
    }
    const name = record.skillName || record.skillRequested
    const at = record.triggeredAt || record.timestamp
    if (!name || !Number.isFinite(Date.parse(at)) || !['claude', 'codex'].includes(record.tool)) {
      corrupt = true
      continue
    }
    const sessionId = record.session?.id || record.sessionId
    const relativePath = record.session?.relativePath || record.sessionRelativePath || null
    requests.push({
      id:
        'legacy_' +
        hash(record.invocationId || record.sampleId || JSON.stringify(record)).slice(0, 24),
      name,
      at,
      tool: record.tool,
      contextId: sessionId ? contextId({ tool: record.tool, sessionId: hash(sessionId) }) : null,
      relativePath,
      sourceLine: record.sourceLine ?? record.lineNumber ?? null,
    })
  }
  return { requests, corrupt }
}
/**
 * @param {object} registry - 当前普通资产和私有存储。
 * @param {object} indexed - 本次完整证据、规则版本与覆盖结果。
 * @param {string} ledgerPath - 旧请求账本，只读。
 * @returns {Promise<object>} 保留确认事件、替换当前文件的待核证据，并核对旧请求。
 * 只更新独立新元数据历史；删除日志仍保留确认事件，规则缺口不得回填成完整或零。
 */
async function reconcileHistory(registry, indexed, ledgerPath) {
  const historyPath = path.join(registry.storeDir, 'history.json')
  let prior
  let readFailed = false
  try {
    prior = JSON.parse(await fs.readFile(historyPath, 'utf8'))
  } catch (error) {
    readFailed = error.code !== 'ENOENT'
  }
  const compatible = prior?.schemaVersion === 3 && prior?.version === indexed.version
  const history = compatible
    ? prior
    : {
        schemaVersion: 3,
        version: indexed.version,
        events: {},
        pending: {},
        files: {},
        legacy: {},
        ruleGaps: [],
      }
  const diagnostics = []
  history.unknownPriorHistory = readFailed || Boolean(prior?.unknownPriorHistory)
  if (prior && !compatible) {
    history.ruleGaps = Object.keys(prior.files || {})
  }
  if (readFailed)
    diagnostics.push({ code: 'HISTORY_READ_FAILED', scope: 'all', availability: 'error' })
  else if (history.unknownPriorHistory)
    diagnostics.push({ code: 'HISTORY_COVERAGE_UNKNOWN', scope: 'all' })
  // Preserve earlier proven reads, while replacing a present file's unresolved candidates with current evidence.
  for (const file of indexed.files) {
    const key = file.tool + ':' + file.relativePath
    history.files[key] = { ...file.meta, invalidLines: file.proof.invalidLines }
    history.ruleGaps = (history.ruleGaps || []).filter((gap) => gap !== key)
    for (const [id, candidate] of Object.entries(history.pending))
      if (candidate.fileKey === key) delete history.pending[id]
    for (const candidate of file.proof.candidates) {
      const event = {
        ...candidate,
        tool: file.tool,
        contextId: contextId(file.meta),
        fileKey: key,
        session: { id: file.meta.sessionId, relativePath: file.relativePath },
      }
      if (candidate.kind === 'pending') history.pending[candidate.eventId] = event
      else history.events[candidate.eventId] = event
    }
  }
  if (history.ruleGaps?.length) diagnostics.push({ code: 'HISTORY_RULE_CHANGED', scope: 'all' })
  const legacy = await readLegacy(ledgerPath)
  if (legacy.unreadable)
    diagnostics.push({ code: 'LEGACY_UNREADABLE', scope: 'all', availability: 'error' })
  if (legacy.corrupt) diagnostics.push({ code: 'LEGACY_COVERAGE_UNKNOWN', scope: 'all' })
  for (const request of legacy.requests) history.legacy[request.id] = request
  const activeEvents = Object.values(history.events)
  const unresolvedLegacy = Object.values(history.legacy).filter(
    (request) =>
      !activeEvents.some(
        (event) =>
          event.tool === request.tool &&
          event.name === request.name &&
          event.contextId === request.contextId &&
          (!request.relativePath || event.session.relativePath === request.relativePath) &&
          (event.sourceLine === request.sourceLine || event.requestLine === request.sourceLine) &&
          Date.parse(event.at) >= Date.parse(request.at)
      )
  )
  let writes = 0
  const canonical = (value) => {
    const sorted = {}
    for (const field of ['events', 'pending', 'files', 'legacy'])
      sorted[field] = Object.fromEntries(
        Object.entries(value?.[field] || {}).sort(([a], [b]) => a.localeCompare(b))
      )
    return JSON.stringify({
      schemaVersion: value?.schemaVersion,
      version: value?.version,
      unknownPriorHistory: Boolean(value?.unknownPriorHistory),
      ruleGaps: [...(value?.ruleGaps || [])].sort(),
      ...sorted,
    })
  }
  // prior is mutated by reconciliation only after a separate immutable comparison snapshot is available.
  const persisted = await readJson(historyPath, null).catch(() => null)
  if (canonical(history) !== canonical(persisted)) {
    try {
      await writeAtomic(historyPath, history)
      writes = 1
    } catch {
      diagnostics.push({ code: 'HISTORY_WRITE_FAILED', scope: 'all', availability: 'error' })
    }
  }
  return {
    events: activeEvents,
    pending: Object.values(history.pending),
    legacy: unresolvedLegacy,
    files: Object.entries(history.files).map(([key, meta]) => ({ key, meta })),
    diagnostics,
    writes,
  }
}
module.exports = { reconcileHistory }
