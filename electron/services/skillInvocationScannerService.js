/**
 * Skill invocation 扫描服务
 *
 * 负责：
 * - 流式读取 Claude Code / Codex transcript，提取显式 Skill 调用
 * - 在完整 transcript 上完成 logical 去重与 occurrence 编号
 * - 消解 Codex fork replay，生成稳定 invocation ID
 * - 只返回 valid invocation；rejected candidate 仅进入本次 diagnostics
 *
 * @module electron/services/skillInvocationScannerService
 */

const crypto = require('crypto')
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const readline = require('readline')
const {
  getTranscriptRoot,
  toTranscriptRelativePath,
  fallbackSessionIdFromPath,
  findUniqueTranscriptBySessionId,
} = require('./transcriptLocatorService')

const DAY_MS = 24 * 60 * 60 * 1000
const CMD_RE = /<command-name>\/?([a-zA-Z0-9_-]+)<\/command-name>/
const DOLLAR_RE = /\$([a-zA-Z][a-zA-Z0-9_-]+)/g
const CLASSIFIER_VERSION = 'skill-invocation-v2'
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i

function sha1(text) {
  return crypto.createHash('sha1').update(String(text || '')).digest('hex')
}

function cleanText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim()
}

function extractClaudeUserText(record) {
  const content = record.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((item) => {
      if (typeof item === 'string') return item
      return item?.text || ''
    })
    .join(' ')
}

function extractCodexUserText(record) {
  if (record.type === 'event_msg' && record.payload?.type === 'user_message') {
    return typeof record.payload.message === 'string' ? record.payload.message : null
  }
  if (record.type === 'response_item' && record.payload?.type === 'message' && record.payload?.role === 'user') {
    const content = record.payload.content
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return null
    return content
      .map((item) => {
        if (typeof item === 'string') return item
        return item?.text || item?.content || ''
      })
      .join(' ')
  }
  return null
}

function extractDollarSkills(text, nameSet) {
  const names = new Set()
  DOLLAR_RE.lastIndex = 0
  let match
  while ((match = DOLLAR_RE.exec(text || ''))) {
    if (nameSet.has(match[1])) names.add(match[1])
  }
  return Array.from(names)
}

function classifyCodexText(text) {
  const cleaned = cleanText(text)
  if (cleaned.startsWith('<codex_internal_context source="goal">')) {
    return { valid: false, triggerType: 'codex_goal_continuation', reason: 'goal_continuation' }
  }
  if (
    cleaned.startsWith('PLEASE IMPLEMENT THIS PLAN:')
    && cleaned.includes('default_prompt')
  ) {
    return { valid: false, triggerType: 'embedded_plan', reason: 'embedded_plan' }
  }
  if (cleaned.startsWith('/goal ')) {
    return { valid: true, triggerType: 'goal_directive', reason: null }
  }
  return { valid: true, triggerType: 'codex_dollar', reason: null }
}

async function pathExists(targetPath) {
  try {
    await fsp.access(targetPath)
    return true
  } catch {
    return false
  }
}

/**
 * 递归枚举 JSONL 文件，仅保留路径、mtime 和 size，不读取正文。
 * @param {string} root - transcript 根目录
 * @param {object} [options] - 枚举限制
 * @returns {Promise<Array<{path:string,mtimeMs:number,size:number}>>}
 */
async function listJsonlFiles(root, options = {}) {
  const maxDepth = options.maxDepth ?? 12
  const maxFiles = options.maxFiles ?? 20000
  const files = []

  async function walk(current, depth) {
    if (depth > maxDepth) return
    const entries = await fsp.readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      if (files.length >= maxFiles) {
        throw new Error('SKILL_INVOCATION_MAX_FILES_EXCEEDED')
      }
      const target = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(target, depth + 1)
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const stat = await fsp.stat(target)
        files.push({ path: target, mtimeMs: stat.mtimeMs, size: stat.size })
      }
    }
  }

  await walk(root, 0)
  return files
}

/**
 * 流式遍历 JSONL，保证不会把大型 rollout 整体读入内存。
 * @param {string} filePath - JSONL 路径
 * @param {(record:object,lineNumber:number)=>void} onRecord - 行回调
 * @returns {Promise<void>}
 */
async function streamJsonl(filePath, onRecord) {
  const input = fs.createReadStream(filePath, { encoding: 'utf-8' })
  const lines = readline.createInterface({ input, crlfDelay: Infinity })
  let lineNumber = 0
  for await (const line of lines) {
    lineNumber += 1
    if (!line.trim()) continue
    try {
      onRecord(JSON.parse(line), lineNumber)
    } catch {
      // 单行损坏不影响同 transcript 的其他 invocation。
    }
  }
}

function readTimestamp(record) {
  const timestamp = typeof record.timestamp === 'string' ? record.timestamp : ''
  const timestampMs = Date.parse(timestamp)
  return Number.isFinite(timestampMs) ? { timestamp, timestampMs } : null
}

function sameCodexDualWrite(previousGroup, current) {
  if (!previousGroup || current.tool !== 'codex') return false
  const representative = previousGroup.events[previousGroup.events.length - 1]
  if (!representative || representative.tool !== 'codex') return false
  if (representative.skillName !== current.skillName) return false
  if (representative.normalizedTriggerHash !== current.normalizedTriggerHash) return false
  if (Math.abs(representative.timestampMs - current.timestampMs) > 2000) return false
  return !previousGroup.rawTypes.has(current.rawType)
}

function normalizeFileEvents(rawEvents, session) {
  const sorted = [...rawEvents].sort((a, b) => (
    a.sourceLine - b.sourceLine
    || a.timestampMs - b.timestampMs
  ))
  const groups = []
  const pendingByKey = new Map()

  for (const event of sorted) {
    const key = `${event.tool}|${event.skillName}|${event.normalizedTriggerHash}`
    const pending = pendingByKey.get(key)
    if (sameCodexDualWrite(pending, event)) {
      pending.events.push(event)
      pending.rawTypes.add(event.rawType)
      // 一组 Codex dual-write 已闭合，后续同文本是新的真实调用。
      pendingByKey.delete(key)
    } else {
      const group = { events: [event], rawTypes: new Set([event.rawType]) }
      groups.push(group)
      if (event.tool === 'codex') pendingByKey.set(key, group)
    }
  }

  const logical = groups.map((group) => {
    const events = group.events
    const first = events.reduce((best, event) => (
      event.sourceLine < best.sourceLine ? event : best
    ), events[0])
    const earliest = events.reduce((best, event) => (
      event.timestampMs < best.timestampMs ? event : best
    ), events[0])
    return {
      tool: first.tool,
      skillName: first.skillName,
      triggerType: first.triggerType,
      valid: first.valid,
      rejectionReason: first.rejectionReason,
      normalizedTriggerHash: first.normalizedTriggerHash,
      triggeredAt: earliest.timestamp,
      timestampMs: earliest.timestampMs,
      sourceLine: first.sourceLine,
      rawEventCount: events.length,
      session,
    }
  })

  const occurrences = new Map()
  for (const event of logical) {
    const key = `${event.skillName}|${event.normalizedTriggerHash}`
    const index = occurrences.get(key) || 0
    event.occurrenceIndexWithinSession = index
    occurrences.set(key, index + 1)
  }
  return logical
}

function createInvocation(event) {
  const invocationId = sha1([
    event.tool,
    event.session.id,
    event.skillName,
    event.normalizedTriggerHash,
    event.occurrenceIndexWithinSession,
  ].join('|'))
  return {
    schemaVersion: 2,
    invocationId,
    skillName: event.skillName,
    tool: event.tool,
    triggerType: event.triggerType,
    triggeredAt: event.triggeredAt,
    session: {
      id: event.session.id,
      relativePath: event.session.relativePath,
    },
    sourceLine: event.sourceLine,
    classifierVersion: CLASSIFIER_VERSION,
  }
}

function eventSignature(event) {
  return [
    event.skillName,
    event.triggerType,
    event.normalizedTriggerHash,
    event.occurrenceIndexWithinSession,
  ].join('|')
}

function commonPrefixLength(parentEvents, childEvents) {
  const limit = Math.min(parentEvents.length, childEvents.length)
  let index = 0
  while (index < limit && eventSignature(parentEvents[index]) === eventSignature(childEvents[index])) {
    index += 1
  }
  return index
}

async function parseClaudeTranscript(filePath, root, nameSet) {
  const rawEvents = []
  let sessionId = ''
  let agentId = ''
  const baseName = path.basename(filePath)

  await streamJsonl(filePath, (record, sourceLine) => {
    if (!sessionId && typeof record.sessionId === 'string') sessionId = record.sessionId
    if (!agentId && typeof (record.agentId || record.agent_id) === 'string') {
      agentId = record.agentId || record.agent_id
    }
    const time = readTimestamp(record)
    if (!time) return

    if (record.type === 'assistant' && Array.isArray(record.message?.content)) {
      for (const item of record.message.content) {
        if (
          item?.type === 'tool_use'
          && item.name === 'Skill'
          && typeof item.input?.skill === 'string'
          && nameSet.has(item.input.skill)
        ) {
          const basis = `claude_tool_use:${item.id || record.uuid || record.message?.id || 'missing'}`
          rawEvents.push({
            tool: 'claude',
            skillName: item.input.skill,
            triggerType: 'claude_tool_use',
            valid: true,
            rejectionReason: null,
            normalizedTriggerHash: sha1(basis),
            rawType: 'assistant/tool_use',
            sourceLine,
            ...time,
          })
        }
      }
    }

    if (record.type === 'user') {
      const text = extractClaudeUserText(record)
      const match = text.match(CMD_RE)
      if (match && nameSet.has(match[1])) {
        rawEvents.push({
          tool: 'claude',
          skillName: match[1],
          triggerType: 'claude_slash',
          valid: true,
          rejectionReason: null,
          normalizedTriggerHash: sha1(cleanText(text)),
          rawType: 'user/slash',
          sourceLine,
          ...time,
        })
      }
    }
  })

  const isAgentTranscript = baseName.startsWith('agent-')
    || baseName.startsWith('journal.')
    || (!sessionId && Boolean(agentId))
  const canonicalId = isAgentTranscript
    ? (agentId || sessionId || fallbackSessionIdFromPath(filePath))
    : (sessionId || agentId || fallbackSessionIdFromPath(filePath))
  const session = {
    id: canonicalId,
    relativePath: toTranscriptRelativePath(root, filePath),
  }
  return {
    tool: 'claude',
    id: canonicalId,
    parentId: null,
    filePath,
    logicalEvents: normalizeFileEvents(rawEvents, session),
    rawEventCount: rawEvents.length,
  }
}

async function parseCodexTranscript(filePath, root, nameSet) {
  const rawEvents = []
  let sessionId = ''
  let parentId = ''

  await streamJsonl(filePath, (record, sourceLine) => {
    // Fork rollout 可能在后文回放历史 session_meta；canonical meta 只能取文件首条。
    if (record.type === 'session_meta' && !sessionId) {
      const payload = record.payload || {}
      if (typeof payload.id === 'string') sessionId = payload.id
      if (typeof payload.forked_from_id === 'string') parentId = payload.forked_from_id
      else if (typeof payload.parent_thread_id === 'string') parentId = payload.parent_thread_id
    }

    const time = readTimestamp(record)
    if (!time) return
    const text = extractCodexUserText(record)
    if (typeof text !== 'string') return
    const classification = classifyCodexText(text)
    const normalizedTriggerHash = sha1(cleanText(text))
    const skillNames = extractDollarSkills(text, nameSet)
    for (const skillName of skillNames) {
      rawEvents.push({
        tool: 'codex',
        skillName,
        triggerType: classification.triggerType,
        valid: classification.valid,
        rejectionReason: classification.reason,
        normalizedTriggerHash,
        rawType: `${record.type}/${record.payload?.type || 'message'}`,
        sourceLine,
        ...time,
      })
    }
  })

  const canonicalId = sessionId || fallbackSessionIdFromPath(filePath)
  const session = {
    id: canonicalId,
    relativePath: toTranscriptRelativePath(root, filePath),
  }
  return {
    tool: 'codex',
    id: canonicalId,
    parentId: parentId || null,
    filePath,
    logicalEvents: normalizeFileEvents(rawEvents, session),
    rawEventCount: rawEvents.length,
  }
}

function fallbackCodexId(filePath) {
  const match = path.basename(filePath).match(UUID_RE)
  return match ? match[0] : fallbackSessionIdFromPath(filePath)
}

function countClaudeSignalOverlaps(sessions) {
  let count = 0
  for (const session of sessions) {
    const valid = session.logicalEvents.filter((event) => event.valid)
    for (let left = 0; left < valid.length; left += 1) {
      for (let right = left + 1; right < valid.length; right += 1) {
        const a = valid[left]
        const b = valid[right]
        if (a.skillName !== b.skillName || a.triggerType === b.triggerType) continue
        const pair = new Set([a.triggerType, b.triggerType])
        if (!pair.has('claude_slash') || !pair.has('claude_tool_use')) continue
        if (Math.abs(a.timestampMs - b.timestampMs) <= 60000) count += 1
      }
    }
  }
  return count
}

/**
 * 扫描当前可观测的 Skill invocation。
 * @param {object} deps - 依赖
 * @param {string} deps.homeDir - 用户主目录
 * @param {NodeJS.ProcessEnv|object} [deps.env] - 自定义工具根目录
 * @param {() => Date} [deps.nowFn] - 测试时间工厂
 * @param {object} params - 扫描参数
 * @param {string[]} params.skillNames - 已管理 Skill 名
 * @param {number} [params.windowDays=30] - 时间窗
 * @param {boolean} [params.scanAll=false] - migration 全量扫描
 * @param {number} [params.maxLinesPerFile=Infinity] - 必须为 Infinity
 * @param {number} [params.maxFilesPerSource=20000] - 单个来源的文件枚举上限
 * @returns {Promise<object>}
 */
async function scanSkillInvocations(deps, params = {}) {
  if (params.maxLinesPerFile !== undefined && params.maxLinesPerFile !== Infinity) {
    throw new Error('SKILL_INVOCATION_REQUIRES_FULL_TRANSCRIPT')
  }
  const { homeDir, env = process.env, nowFn = () => new Date() } = deps
  const now = nowFn()
  const windowDays = typeof params.windowDays === 'number' && params.windowDays > 0
    ? params.windowDays
    : 30
  const startMs = now.getTime() - windowDays * DAY_MS
  const endMs = now.getTime()
  const scanAll = params.scanAll === true
  const maxFilesPerSource = Number.isInteger(params.maxFilesPerSource) && params.maxFilesPerSource > 0
    ? params.maxFilesPerSource
    : 20000
  const nameSet = new Set(Array.isArray(params.skillNames) ? params.skillNames : [])
  const sources = { claude: 'missing', codex: 'missing' }
  const diagnostics = {
    rawEventCount: 0,
    logicalRecordCount: 0,
    rejectedRecordCount: 0,
    forkReplaySuppressedCount: 0,
    unresolvedForkCount: 0,
    claudeSlashToolUseOverlapCount: 0,
    unreadableFileCount: 0,
    codexSessionCount: 0,
    codexLineageCount: 0,
    resolvedCodexLineageCount: 0,
    sourceErrors: { claude: null, codex: null },
  }
  const invocations = []
  const suppressedInvocationIds = []
  const allFilePaths = { claude: [], codex: [] }

  if (nameSet.size === 0) {
    return {
      invocations,
      sources,
      diagnostics,
      allFilePaths,
      startTime: new Date(startMs).toISOString(),
      endTime: now.toISOString(),
    }
  }

  const claudeRoot = getTranscriptRoot('claude', { homeDir, env })
  if (await pathExists(claudeRoot)) {
    try {
      const descriptors = await listJsonlFiles(claudeRoot, { maxFiles: maxFilesPerSource })
      allFilePaths.claude = descriptors.map((item) => item.path)
      const candidates = descriptors.filter((item) => scanAll || item.mtimeMs >= startMs)
      const sessions = []
      for (const descriptor of candidates) {
        try {
          sessions.push(await parseClaudeTranscript(descriptor.path, claudeRoot, nameSet))
        } catch {
          diagnostics.unreadableFileCount += 1
        }
      }
      for (const session of sessions) {
        diagnostics.rawEventCount += session.rawEventCount
        diagnostics.logicalRecordCount += session.logicalEvents.length
        diagnostics.rejectedRecordCount += session.logicalEvents.filter((event) => !event.valid).length
        for (const event of session.logicalEvents) {
          if (!event.valid) continue
          if (!scanAll && !(event.timestampMs >= startMs && event.timestampMs <= endMs)) continue
          invocations.push(createInvocation(event))
        }
      }
      diagnostics.claudeSlashToolUseOverlapCount = countClaudeSignalOverlaps(sessions)
      sources.claude = 'ok'
    } catch (error) {
      sources.claude = 'error'
      diagnostics.sourceErrors.claude = error?.message || 'SKILL_INVOCATION_CLAUDE_SCAN_FAILED'
    }
  }

  const codexRoot = getTranscriptRoot('codex', { homeDir, env })
  if (await pathExists(codexRoot)) {
    try {
      const descriptors = await listJsonlFiles(codexRoot, { maxFiles: maxFilesPerSource })
      allFilePaths.codex = descriptors.map((item) => item.path)
      const candidates = descriptors.filter((item) => scanAll || item.mtimeMs >= startMs)
      const candidatePaths = new Set(candidates.map((item) => item.path))
      const pathById = new Map(descriptors.map((item) => [fallbackCodexId(item.path), item.path]))
      const parsedByPath = new Map()
      const parsedById = new Map()

      async function ensureParsed(filePath) {
        if (!filePath) return null
        if (parsedByPath.has(filePath)) return parsedByPath.get(filePath)
        try {
          const parsed = await parseCodexTranscript(filePath, codexRoot, nameSet)
          parsedByPath.set(filePath, parsed)
          parsedById.set(parsed.id, parsed)
          pathById.set(parsed.id, filePath)
          return parsed
        } catch {
          diagnostics.unreadableFileCount += 1
          parsedByPath.set(filePath, null)
          return null
        }
      }

      for (const descriptor of candidates) await ensureParsed(descriptor.path)

      let loadedParent = true
      while (loadedParent) {
        loadedParent = false
        for (const session of Array.from(parsedById.values())) {
          if (!session?.parentId || parsedById.has(session.parentId)) continue
          const parentPath = pathById.get(session.parentId)
            || findUniqueTranscriptBySessionId(session.parentId, allFilePaths.codex)
          if (parentPath && !parsedByPath.has(parentPath)) {
            await ensureParsed(parentPath)
            candidatePaths.add(parentPath)
            loadedParent = true
          }
        }
      }

      for (const session of parsedByPath.values()) {
        if (!session || !candidatePaths.has(session.filePath)) continue
        diagnostics.codexSessionCount += 1
        diagnostics.rawEventCount += session.rawEventCount
        diagnostics.logicalRecordCount += session.logicalEvents.length
        diagnostics.rejectedRecordCount += session.logicalEvents.filter((event) => !event.valid).length

        const validEvents = session.logicalEvents.filter((event) => event.valid)
        let surviving = validEvents
        if (session.parentId) {
          diagnostics.codexLineageCount += 1
          const parent = parsedById.get(session.parentId)
          if (!parent) {
            diagnostics.unresolvedForkCount += 1
          } else {
            diagnostics.resolvedCodexLineageCount += 1
            const parentEvents = parent.logicalEvents.filter((event) => event.valid)
            const prefixLength = commonPrefixLength(parentEvents, validEvents)
            diagnostics.forkReplaySuppressedCount += prefixLength
            for (const event of validEvents.slice(0, prefixLength)) {
              suppressedInvocationIds.push(createInvocation(event).invocationId)
            }
            surviving = validEvents.slice(prefixLength)
          }
        }

        for (const event of surviving) {
          if (!scanAll && !(event.timestampMs >= startMs && event.timestampMs <= endMs)) continue
          invocations.push(createInvocation(event))
        }
      }
      sources.codex = 'ok'
    } catch (error) {
      sources.codex = 'error'
      diagnostics.sourceErrors.codex = error?.message || 'SKILL_INVOCATION_CODEX_SCAN_FAILED'
    }
  }

  invocations.sort((a, b) => (
    Date.parse(a.triggeredAt) - Date.parse(b.triggeredAt)
    || a.invocationId.localeCompare(b.invocationId)
  ))

  return {
    invocations,
    sources,
    diagnostics,
    suppressedInvocationIds,
    allFilePaths,
    startTime: new Date(startMs).toISOString(),
    endTime: now.toISOString(),
  }
}

module.exports = {
  scanSkillInvocations,
  listJsonlFiles,
  streamJsonl,
  normalizeFileEvents,
  commonPrefixLength,
  CLASSIFIER_VERSION,
}
