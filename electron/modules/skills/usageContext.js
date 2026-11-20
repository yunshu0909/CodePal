/** Actual execution ancestry and continuous body-load processes; no filename or time-based parent guessing. */
const { hash } = require('./usageSources')
const GAP_MS = 30 * 60 * 1000

/**
 * @param {object} meta - 来源元数据。
 * @returns {string} 同工具/会话/代理的不可逆上下文键。
 */
function contextId(meta) {
  return hash([meta.tool, meta.sessionId || meta.fileId, meta.agentId || ''].join('\0'))
}
/**
 * @param {object[]} files - 当前及已保留的真实会话元数据。
 * @returns {Map<string, string>} user/independent/unknown；只采用已证明的执行祖先，不猜父会话。
 */
function classifyContexts(files) {
  const metas = files.map((file) => file.meta)
  const roots = new Map(
    metas
      .filter((meta) => !meta.agentId && !meta.sidechain)
      .map((meta) => [meta.tool + '\0' + meta.sessionId, meta])
  )
  const resolved = new Map()
  const classify = (meta, visiting = new Set()) => {
    const id = contextId(meta)
    if (resolved.has(id)) return resolved.get(id)
    if (visiting.has(id)) return 'unknown'
    visiting.add(id)
    let result = 'unknown'
    if (meta.parentId) {
      const parent = roots.get(meta.tool + '\0' + meta.parentId)
      if (parent) result = classify(parent, visiting)
    } else if (meta.tool === 'claude') {
      if (meta.agentId || meta.sidechain) {
        const parent = roots.get(meta.tool + '\0' + meta.sessionId)
        if (parent && parent !== meta) result = classify(parent, visiting)
      } else if (meta.entrypoint === 'cli') result = 'user'
      else if (/sdk/i.test(meta.entrypoint || '')) result = 'independent'
    } else {
      if (meta.source === 'exec' || meta.originator === 'codex_exec') result = 'independent'
      else if (
        ['vscode', 'cli'].includes(meta.source) &&
        /^(?:Codex Desktop|codex-tui|codex_cli_rs)$/i.test(meta.originator || '')
      )
        result = 'user'
    }
    visiting.delete(id)
    resolved.set(id, result)
    return result
  }
  for (const meta of metas) classify(meta)
  return resolved
}

/**
 * 子代理上下文 → 发起它的最上层主会话上下文（#81：子代理不进主数字，明细里按主会话合成一行）。
 * Claude 子代理和主会话同一 sessionId、自带 agentId；Codex 子线程记着父线程号，子代理再派的一路找到顶。
 * 与主会话共用同一上下文键的（旧版无 agentId 的 sidechain）不算子代理，免得把主会话自己的读取也挪走。
 * @param {object[]} files - 当前及已保留的真实会话元数据。
 * @returns {Map<string, string>} 子代理 contextId → 主会话 contextId；父会话找不到的子代理不在里面（分类本就是 unknown）。
 */
function subagentRoots(files) {
  // Claude 子代理文件和主会话同一 sessionId：只拿主会话那份当「会话」
  const sessions = new Map(
    files
      .filter((file) => !file.meta.agentId && !file.meta.sidechain)
      .map((file) => [file.meta.tool + '\0' + file.meta.sessionId, file.meta])
  )
  const roots = new Map()
  for (const { meta } of files) {
    const claudeAgent = meta.tool === 'claude' && (meta.agentId || meta.sidechain)
    if (!claudeAgent && !meta.parentId) continue
    let root = claudeAgent ? sessions.get(meta.tool + '\0' + meta.sessionId) : meta
    const visited = new Set()
    while (root?.parentId && !visited.has(root.sessionId)) {
      visited.add(root.sessionId)
      root = sessions.get(root.tool + '\0' + root.parentId)
    }
    if (!root || root.parentId) continue
    const own = contextId(meta)
    const top = contextId(root)
    if (own !== top) roots.set(own, top)
  }
  return roots
}

/** 同一次派出里，相邻两个子代理首次读取最多隔这么久（#81 合成一行的规则） */
const DISPATCH_GAP_MS = 10 * 60 * 1000
/**
 * 把子代理的加载过程合成「一次派出」：同一资产、同一工具、同一主会话，按首次读取排开，相邻不超过 10 分钟算同一次。
 * @param {object[]} processes - loadProcesses 的结果，只传子代理那部分。
 * @param {Map<string, string>} roots - subagentRoots 的结果。
 * @returns {object[]} 每次派出一行：最早读取时间、派出的不同子代理个数；不修改输入。
 */
function groupSubagentRuns(processes, roots) {
  const open = new Map()
  const runs = []
  for (const record of [...processes].sort(
    (a, b) => Date.parse(a.triggeredAt) - Date.parse(b.triggeredAt) || a.invocationId.localeCompare(b.invocationId)
  )) {
    const key = [record.tool, record.assetId, roots.get(record.contextId)].join('\0')
    const run = open.get(key)
    if (run && Date.parse(record.triggeredAt) - Date.parse(run.lastStartAt) <= DISPATCH_GAP_MS) {
      run.agents.add(record.contextId)
      run.lastStartAt = record.triggeredAt
      if (Date.parse(record.lastReadAt) > Date.parse(run.lastReadAt)) run.lastReadAt = record.lastReadAt
      continue
    }
    const next = {
      runId: 'subagents_' + hash(key + '\0' + record.invocationId).slice(0, 24),
      skillName: record.skillName,
      assetId: record.assetId,
      tool: record.tool,
      triggeredAt: record.triggeredAt,
      lastReadAt: record.lastReadAt,
      lastStartAt: record.triggeredAt,
      agents: new Set([record.contextId]),
      session: record.session,
    }
    open.set(key, next)
    runs.push(next)
  }
  return runs.map(({ agents, lastStartAt, ...run }) => ({ ...run, agentCount: agents.size }))
}

/**
 * @param {object[]} events - 已验证正文证据。
 * @param {object[]} files - 含真实分叉祖先的会话元数据。
 * @returns {object[]} 只去掉已证明复制到子上下文的相同事件，不修改输入。
 */
function removeProvenReplay(events, files) {
  const metas = new Map(files.map((file) => [contextId(file.meta), file.meta]))
  const bySession = new Map(
    files.map((file) => [file.meta.tool + '\0' + file.meta.sessionId, contextId(file.meta)])
  )
  const fingerprints = new Map()
  for (const event of events) {
    const key = event.callId + '\0' + event.at + '\0' + event.target + '\0' + event.bodyHash
    if (!fingerprints.has(event.contextId)) fingerprints.set(event.contextId, new Set())
    fingerprints.get(event.contextId).add(key)
  }
  return events.filter((event) => {
    const meta = metas.get(event.contextId)
    let parent = meta?.forkId
    const visited = new Set()
    const proof = event.callId + '\0' + event.at + '\0' + event.target + '\0' + event.bodyHash
    while (parent && !visited.has(parent)) {
      visited.add(parent)
      const parentContext = bySession.get(event.tool + '\0' + parent)
      if (fingerprints.get(parentContext)?.has(proof)) return false
      parent = metas.get(parentContext)?.forkId
    }
    return true
  })
}

/**
 * @param {object[]} events - 已映射到真实普通资产与执行上下文的正文证据。
 * @returns {object[]} 按末次读取间隔合并的加载过程；首证据决定归窗，末次读取另存。
 * 明确重调、压缩和新上下文用 epoch/key 分隔；不改变输入证据。
 */
function loadProcesses(events) {
  const groups = new Map()
  const processes = []
  for (const event of [...events].sort(
    (a, b) => Date.parse(a.at) - Date.parse(b.at) || a.eventId.localeCompare(b.eventId)
  )) {
    const key = [event.tool, event.contextId, event.assetId, event.epoch].join('\0')
    const last = groups.get(key)
    if (last && Date.parse(event.at) - Date.parse(last.lastReadAt) <= GAP_MS) {
      last.lastReadAt = event.at
      last.evidenceIds.push(event.eventId)
      continue
    }
    const process = {
      invocationId: 'load_' + hash(key + '\0' + event.eventId).slice(0, 24),
      skillName: event.skillName,
      assetId: event.assetId,
      tool: event.tool,
      contextId: event.contextId,
      classification: event.classification,
      triggeredAt: event.at,
      lastReadAt: event.at,
      evidenceType: event.kind,
      evidenceIds: [event.eventId],
      session: event.session,
    }
    groups.set(key, process)
    processes.push(process)
  }
  return processes
}
module.exports = {
  contextId,
  classifyContexts,
  subagentRoots,
  groupSubagentRuns,
  removeProvenReplay,
  loadProcesses,
}
