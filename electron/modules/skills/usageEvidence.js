/** Streaming transcript evidence. Persist only proof metadata, never prompts, commands or returned bodies. */
const fs = require('fs')
const readline = require('readline')
const path = require('path')
const crypto = require('crypto')
const { hash } = require('./usageSources')
const PARSER_VERSION = 'body-evidence-3.6'
const BODY_PATH = /SKILL\.md(?:[\s'"<>)]|$)/i
const failure = /(?:permission denied|no such file|unknown skill|not found|ENOENT|EACCES)/i
const timestamp = (row) => row.timestamp || row.created_at || row.at || null
const skillName = (target) => path.basename(path.dirname(target))
const privateId = (id) => (id ? hash(id) : null)

function outputText(value) {
  if (typeof value === 'string') {
    if (/^\s*[\[{]/.test(value)) {
      try {
        return outputText(JSON.parse(value))
      } catch {
        /* ordinary body may start with punctuation */
      }
    }
    return value
  }
  if (Array.isArray(value)) return value.map(outputText).join('\n')
  if (!value || typeof value !== 'object') return ''
  for (const field of [
    'text',
    'output',
    'aggregated_output',
    'stdout',
    'content',
    'result',
    ...(value.status === 'fulfilled' ? ['value'] : []),
  ]) {
    if (value[field] !== undefined) return outputText(value[field])
  }
  return ''
}
function executorReceipts(value) {
  if (typeof value === 'string') {
    try {
      return executorReceipts(JSON.parse(value))
    } catch {
      return []
    }
  }
  if (Array.isArray(value)) return value.flatMap(executorReceipts)
  if (!value || typeof value !== 'object') return []
  if (
    Number.isInteger(value.exit_code) &&
    typeof value.output === 'string' &&
    (value.chunk_id || typeof value.wall_time_seconds === 'number')
  )
    return [value]
  if (value.status === 'fulfilled') return executorReceipts(value.value)
  if (value.content) return executorReceipts(value.content)
  if (value.result) return executorReceipts(value.result)
  if (value.type === 'input_text' || value.type === 'text') return executorReceipts(value.text)
  return []
}
function exitStatus(value) {
  const receipts = executorReceipts(value)
  if (receipts.length === 1) return receipts[0].exit_code
  const text = outputText(value)
  const match = text.match(/(?:Process exited with code|exit[_ ]code["':\s]*)\s*(-?\d+)/i)
  return match ? Number(match[1]) : null
}
function commandLiterals(source) {
  if (typeof source !== 'string' || !/exec_command/.test(source)) return []
  const commands = []
  const literal =
    /exec_command\s*\(\s*\{\s*(?:cmd|command)\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g
  for (const match of source.matchAll(literal)) {
    let command
    try {
      command =
        match[1][0] === '"'
          ? JSON.parse(match[1])
          : match[1].slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, '\\').replace(/\\n/g, '\n')
    } catch {
      continue
    }
    commands.push(command)
  }
  return commands
}

function stripReceipt(text) {
  const after = text.match(/(?:Final output:|Command output(?: text)?:)\s*\n([\s\S]*)$/i)
  return (
    after
      ? after[1]
      : text.replace(/^Script (?:completed|running)[^\n]*\n?(?:Wall time:[^\n]*\n)?/, '')
  ).trim()
}
function bodyProof(text) {
  const body = stripReceipt(text)
  if (!body || failure.test(body.slice(0, 300))) return null
  if (/^[a-f0-9]{32,128}(?:\s+.*)?$/i.test(body)) return null
  return hash(body)
}
function readTargets(command, cwd) {
  if (typeof command !== 'string' || !BODY_PATH.test(command)) return []
  if (!/(?:^|[\s("'])\b(?:cat|sed|head|tail)\b\s/.test(command)) return []
  const tokens = [...command.matchAll(/"([^"\n]*)"|'([^'\n]*)'|([^\s;|&<>"']+)/g)].map(
    (match) => match[1] ?? match[2] ?? match[3]
  )
  const targets = []
  for (const token of tokens) {
    if (!/(?:^|\/)SKILL\.md$/i.test(token) || /\$|`/.test(token)) continue
    targets.push(
      token.startsWith('/') || token.startsWith('~/') ? token : path.resolve(cwd || '.', token)
    )
  }
  // exec orchestration contains quoted command literals. Inspect literals, without evaluating JavaScript.
  if (targets.length === 0 && /exec_command/.test(command)) {
    for (const token of tokens) {
      if (token !== command && /(?:cat|sed|head|tail)\s/.test(token))
        targets.push(...readTargets(token, cwd))
    }
  }
  return [...new Set(targets)]
}
// Only an executed reader proves body delivery. Echoing a command or piping it into a counter does not.
const executedReader = (command) =>
  /^\s*(?:(?:\/bin\/|\/usr\/bin\/)?(?:cat|sed|head|tail))\s/.test(command || '')
const metadataCommand = (command) =>
  /^\s*(?:echo|printf)\s/.test(command || '') && !/[;|&\n]/.test(command)
const compoundCommand = (command) => /[;|&<>\n]/.test(command || '')
function supportedInjection(meta) {
  if (meta.tool === 'claude')
    return (
      /^2\.1\.\d+(?:[-.].*)?$/.test(meta.version || '') &&
      Number((meta.version || '').split('.')[2]) <= 292
    )
  const version = (meta.version || '').match(/^0\.(\d+)\.(\d+)(?:[-.].*)?$/)
  return (
    version &&
    Number(version[1]) >= 116 &&
    Number(version[1]) <= 159 &&
    /^(?:Codex Desktop|codex-tui|codex_cli_rs)$/i.test(meta.originator || '')
  )
}
function contentBlocks(row) {
  const content = row.message?.content ?? row.payload?.content
  return Array.isArray(content) ? content : []
}

/**
 * 解析有限长度日志，分别处理来源元数据、工具返回、原生完成记录与正文注入。
 * @param {object} file - 已核对 realPath、size、tool 和 relativePath 的文件版本。
 * @param {object} deps - 主进程依赖；afterFileRead 仅供隔离验证。
 * @returns {Promise<object>} 只含证据摘要的候选与覆盖状态，原始正文不持久化。
 * 内部临时 openHandle/unfinishedText 不可枚举；调用者必须核对读后版本并关闭该句柄。
 */
async function parseTranscript(file, deps) {
  const meta = {
    tool: file.tool,
    fileId: hash(file.realPath),
    sessionId: null,
    entrypoint: null,
    originator: null,
    source: null,
    version: null,
    agentId: null,
    sidechain: false,
    parentId: null,
    forkId: null,
    cwd: null,
  }
  const candidates = []
  const requests = new Map()
  const calls = new Map()
  const explicit = new Map()
  const excludedTargets = new Set()
  const userSignals = new Map()
  let lastUser = ''
  let compact = 0
  let line = 0
  let invalidLines = 0
  let lastInvalidLine = 0
  let unfinishedText = null
  let snapshotTail = Buffer.alloc(0)
  const snapshotHash = crypto.createHash('sha256')
  const epochOf = (name) => compact + ':' + (explicit.get(name) || 0)
  const add = (target, at, callId, kind, bodyHash, sourceLine, extra = {}) => {
    if (!at || !Number.isFinite(Date.parse(at))) {
      invalidLines += 1
      return
    }
    const name = target ? skillName(target) : extra.name
    if (target && excludedTargets.has(target) && kind !== 'resolution') {
      kind = 'resolution'
      bodyHash = null
      extra = { ...extra, reason: 'EXPLICIT_SAMPLE' }
    }
    const candidate = {
      target: target || null,
      name,
      at,
      callId: privateId(callId),
      kind,
      bodyHash: bodyHash || null,
      sourceLine,
      epoch: epochOf(name),
      ...extra,
    }
    candidate.eventId = hash(
      [
        file.tool,
        file.relativePath,
        candidate.callId,
        at,
        target,
        kind,
        bodyHash,
        candidate.epoch,
      ].join('\0')
    )
    candidates.push(candidate)
  }
  const openExplicit = (name, id, at) => {
    explicit.set(name, (explicit.get(name) || 0) + 1)
    requests.set(id, { name, at, line, epoch: epochOf(name) })
  }
  const settleName = (name, at) => {
    for (const [id, request] of requests) {
      if (request.name === name && Date.parse(request.at) <= Date.parse(at)) requests.delete(id)
    }
  }
  const acceptOutput = (id, value, failed = false, forceExit = null, bodyAt = null) => {
    const call = calls.get(id)
    if (!call) {
      if (failed) requests.delete(id)
      return
    }
    calls.delete(id)
    const receipts = executorReceipts(value)
    const text = outputText(value)
    const at = bodyAt || call.at
    const exit = forceExit ?? (call.nativeRead ? (failed ? 1 : 0) : exitStatus(value))
    const wholeBody = bodyProof(text)
    for (const target of call.targets) {
      const name = skillName(target)
      if (call.verifiedReader === false) {
        add(target, call.at, id, 'pending', null, call.line, { reason: 'READ_COMMAND_UNSUPPORTED' })
        continue
      }
      let segment = text
      let perTarget = false
      if (call.targets.length > 1 || call.ambiguous) {
        const marker = '==> ' + target + ' <=='
        const start = text.indexOf(marker)
        if (start >= 0) {
          segment = text.slice(start + marker.length).split(/\n==> /)[0]
          perTarget = true
        }
      }
      if (perTarget && failure.test(segment.slice(0, 300))) {
        add(target, call.at, id, 'resolution', null, call.line, { reason: 'READ_FAILED' })
        settleName(name, call.at)
        continue
      }
      if ((call.targets.length > 1 || call.ambiguous || receipts.length > 1) && !perTarget) {
        add(target, call.at, id, 'pending', null, call.line, { reason: 'AMBIGUOUS_TARGET_OUTPUT' })
        continue
      }
      if (!perTarget && (failed || (exit !== null && exit !== 0))) {
        add(target, call.at, id, 'resolution', null, call.line, { reason: 'READ_FAILED' })
        settleName(name, call.at)
        continue
      }
      const proof = perTarget ? bodyProof(segment) : wholeBody
      if (proof && (perTarget || exit === 0)) {
        add(target, at, id, 'read', proof, call.line, { bodyLine: line, requestedAt: call.at })
        settleName(name, call.at)
      } else add(target, call.at, id, 'pending', null, call.line, { reason: 'BODY_NOT_VERIFIED' })
    }
  }
  const recordUser = (text, at, id) => {
    lastUser = text
    for (const match of text.matchAll(/(?:^|\s)\$([\w-]+)\b/g)) {
      userSignals.set(match[1], text)
      openExplicit(match[1], id + ':' + match[1], at)
    }
    for (const match of text.matchAll(/<command-name>\/([\w-]+)<\/command-name>/g))
      openExplicit(match[1], id + ':' + match[1], at)
    if (/(?:作为|as\s+(?:a\s+)?)(?:研究样本|测试材料|research sample|test fixture)/i.test(text)) {
      for (const match of text.matchAll(/(?:^|\s)(\/[^\n]*?\/SKILL\.md)(?=\s|$)/g))
        excludedTargets.add(match[1])
    }
  }
  function updateMetadata(row) {
    if (row.sessionId && !meta.sessionId) meta.sessionId = privateId(row.sessionId)
    if (row.entrypoint) meta.entrypoint = row.entrypoint
    if (row.version) meta.version = row.version
    if (row.cwd) meta.cwd = row.cwd
    if (row.agentId) meta.agentId = privateId(row.agentId)
    if (row.isSidechain) meta.sidechain = true
    if (row.forkedFromSessionId) meta.forkId = privateId(row.forkedFromSessionId)
    if (row.type === 'session_meta') {
      const payload = row.payload || {}
      meta.sessionId = privateId(payload.id)
      meta.originator = payload.originator
      meta.version = payload.cli_version
      meta.cwd = payload.cwd
      meta.source = typeof payload.source === 'string' ? payload.source : null
      meta.parentId = privateId(
        payload.source?.subagent?.thread_spawn?.parent_thread_id || payload.parent_thread_id
      )
      meta.forkId = privateId(payload.forked_from_id || payload.forked_from_session_id)
      return true
    }
    return false
  }

  function handleToolBlocks(row, at) {
    for (const block of contentBlocks(row)) {
      if (block.type === 'tool_use') {
        if (block.name === 'Skill' && !String(block.input?.skill || '').includes(':'))
          openExplicit(String(block.input?.skill || ''), block.id, at)
        if (block.name === 'Read' && /\/SKILL\.md$/i.test(block.input?.file_path || '')) {
          calls.set(block.id, { targets: [block.input.file_path], at, line, nativeRead: true })
        }
        if (['Bash', 'exec_command'].includes(block.name)) {
          const command = block.input?.command || block.input?.cmd
          const targets = readTargets(command, meta.cwd)
          if (targets.length && !metadataCommand(command))
            calls.set(block.id, {
              targets,
              at,
              line,
              nativeRead: true,
              verifiedReader: executedReader(command),
              ambiguous: compoundCommand(command),
            })
        }
      }
      if (block.type === 'tool_result') {
        if (requests.has(block.tool_use_id) && block.is_error) {
          const request = requests.get(block.tool_use_id)
          add(null, request.at, block.tool_use_id, 'resolution', null, request.line, {
            name: request.name,
            reason: 'REQUEST_FAILED',
          })
          requests.delete(block.tool_use_id)
        }
        acceptOutput(block.tool_use_id, block.content, block.is_error === true, null, at)
      }
    }
  }

  function handleCodexCalls(row, payload, at) {
    if (
      row.type === 'response_item' &&
      ['function_call', 'custom_tool_call'].includes(payload.type)
    ) {
      let args = {}
      try {
        args = JSON.parse(payload.arguments || '{}')
      } catch {
        /* custom tool input is source, not JSON */
      }
      const source = payload.input || payload.arguments || ''
      const literalCommands = commandLiterals(source)
      const commands = literalCommands.length ? literalCommands : [args.cmd || args.command || '']
      const actualCommands = commands.filter((command) => !metadataCommand(command))
      const callCwd = args.workdir || args.cwd || meta.cwd
      const targets = [
        ...new Set(actualCommands.flatMap((command) => readTargets(command, callCwd))),
      ]
      if (targets.length)
        calls.set(payload.call_id, {
          targets,
          at,
          line,
          verifiedReader:
            /^(?:functions\.)?(?:exec_command|exec)$/.test(payload.name || '') &&
            actualCommands.every(executedReader),
          ambiguous: commands.length > 1 || actualCommands.some(compoundCommand),
        })
      else if (
        actualCommands.length &&
        /exec_command/.test(source) &&
        BODY_PATH.test(source) &&
        /(?:cat|sed|head|tail)\s/.test(source)
      ) {
        const possibleTargets = readTargets(source, meta.cwd)
        if (possibleTargets.length) {
          for (const target of possibleTargets)
            add(target, at, payload.call_id, 'pending', null, line, {
              reason: 'READ_COMMAND_UNSUPPORTED',
            })
        } else
          add(null, at, payload.call_id, 'pending', null, line, {
            reason: 'READ_COMMAND_UNSUPPORTED',
          })
      }
    }
    if (
      row.type === 'response_item' &&
      ['function_call_output', 'custom_tool_call_output'].includes(payload.type)
    )
      acceptOutput(payload.call_id, payload.output, false, null, at)
  }

  function handleNativeCompletion(row, payload, at) {
    // Desktop Codex writes native completions inside event_msg.payload; CLI fixtures may use the top-level shape.
    const completion = row.type === 'event_msg' && payload.type === 'item_completed' ? payload : row
    if (completion.type === 'item_completed' && completion.item?.type === 'CommandExecution') {
      const item = completion.item
      const command = Array.isArray(item.command) ? item.command.at(-1) : item.command
      const cwd = item.cwd || meta.cwd
      const targets = (item.parsed_cmd || [])
        .filter((entry) => entry.type === 'read' && /(?:^|\/)SKILL\.md$/i.test(entry.path || ''))
        .map((entry) =>
          entry.path.startsWith('/') || entry.path.startsWith('~/')
            ? entry.path
            : path.resolve(cwd || '.', entry.path)
        )
      const actualTargets = targets.length ? targets : readTargets(command, cwd)
      if (actualTargets.length && !metadataCommand(command)) {
        calls.set(item.id, {
          targets: actualTargets,
          at,
          line,
          verifiedReader: targets.length > 0 || executedReader(command),
          ambiguous: compoundCommand(command),
        })
        acceptOutput(item.id, item.aggregated_output, item.status !== 'completed', item.exit_code)
      }
    }
  }

  function handleInjectedBody(row, payload, at) {
    const injected =
      row.type === 'user' && row.isMeta
        ? outputText(row.message?.content)
        : row.type === 'response_item' && payload.type === 'message' && payload.role === 'user'
          ? outputText(payload.content)
          : ''
    if (!injected) return
    if (meta.tool === 'claude') {
      const match = injected.match(/Base directory for this skill:\s*([^\n]+)\n([\s\S]+)/)
      if (!match) return
      const target = path.join(match[1].trim(), 'SKILL.md')
      const request = requests.get(row.sourceToolUseID)
      const proof = bodyProof(match[2])
      if (proof && request?.name === skillName(target) && supportedInjection(meta)) {
        add(target, at, row.sourceToolUseID, 'injection', proof, line, {
          requestLine: request.line,
        })
        settleName(request.name, at)
      } else
        add(target, at, row.uuid || 'inject-' + line, 'pending', null, line, {
          reason: 'INJECTION_NOT_VERIFIED',
        })
    } else {
      for (const match of injected.matchAll(
        /<skill>\s*<name>([^<]+)<\/name>\s*<path>([^<]+)<\/path>([\s\S]*?)<\/skill>/g
      )) {
        const [, name, target, body] = match
        // Equal actual user text is a paste, not a producer-injected body.
        if (lastUser === injected || userSignals.get(name) === injected) continue
        const proof = bodyProof(body)
        if (proof && userSignals.has(name) && supportedInjection(meta)) {
          add(target, at, 'inject-' + line, 'injection', proof, line)
          settleName(name, at)
        } else
          add(target, at, 'inject-' + line, 'pending', null, line, {
            name,
            reason: 'INJECTION_NOT_VERIFIED',
          })
      }
    }
  }

  // The index owns this handle until the post-read version/append check; verification does not reopen a body.
  const handle = await fs.promises.open(file.realPath, 'r')
  const stream = handle.createReadStream({
    start: 0,
    end: Math.max(0, file.size - 1),
    autoClose: false,
  })
  stream.on('data', (chunk) => {
    snapshotHash.update(chunk)
    snapshotTail =
      chunk.length >= 4096
        ? chunk.subarray(chunk.length - 4096)
        : Buffer.concat([snapshotTail, chunk]).subarray(-4096)
  })
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const text of reader) {
      line += 1
      if (!text.trim()) continue
      // Most huge assistant/output records cannot contain body evidence. Keep metadata, requests, and results of an outstanding read.
      if (
        text.length > 4096 &&
        !text.includes('SKILL.md') &&
        calls.size === 0 &&
        !text.includes('session_meta') &&
        !text.includes('sourceToolUseID') &&
        !text.includes('entrypoint') &&
        !text.includes('tool_result') &&
        !text.includes('compacted') &&
        !text.includes('"user"') &&
        !text.includes('"user_message"') &&
        !text.includes('"tool_use"')
      )
        continue
      let row
      try {
        row = JSON.parse(text)
      } catch {
        invalidLines += 1
        lastInvalidLine = line
        unfinishedText = text
        continue
      }
      const at = timestamp(row)
      if (updateMetadata(row)) continue
      if (
        row.type === 'compacted' ||
        (row.type === 'system' && /compact/.test(row.subtype || ''))
      ) {
        compact += 1
        continue
      }
      if (row.type === 'event_msg' && row.payload?.type === 'user_message') {
        recordUser(row.payload.message || '', at, 'user-' + line)
        continue
      }
      if (row.type === 'user' && !row.isMeta && typeof row.message?.content === 'string') {
        recordUser(row.message.content, at, row.uuid || 'user-' + line)
      }
      handleToolBlocks(row, at)
      const payload = row.payload || {}
      handleCodexCalls(row, payload, at)
      handleNativeCompletion(row, payload, at)
      handleInjectedBody(row, payload, at)
    }
  } catch (error) {
    await handle.close().catch(() => {})
    throw error
  } finally {
    reader.close()
    stream.pause()
  }
  for (const [id, call] of calls)
    for (const target of call.targets)
      add(target, call.at, id, 'pending', null, call.line, { reason: 'RESULT_MISSING' })
  for (const [id, request] of requests) {
    add(null, request.at, id, 'pending', null, request.line, {
      name: request.name,
      epoch: request.epoch,
      reason: 'REQUEST_ONLY',
    })
  }
  try {
    if (deps.afterFileRead) await deps.afterFileRead(file.path)
  } catch (error) {
    await handle.close().catch(() => {})
    throw error
  }
  const proof = {
    meta,
    candidates,
    invalidLines,
    snapshotTailBytes: snapshotTail.length,
    snapshotTailHash: crypto.createHash('sha256').update(snapshotTail).digest('hex'),
    snapshotHash: snapshotHash.digest('hex'),
  }
  const unfinishedTail =
    lastInvalidLine === line && snapshotTail.length > 0 && snapshotTail.at(-1) !== 10
  // Raw unfinished text and the handle are ephemeral and are never serialized into index/history.
  Object.defineProperties(proof, {
    openHandle: { value: handle, configurable: true },
    unfinishedText: { value: unfinishedTail ? unfinishedText : null, configurable: true },
  })
  return proof
}
module.exports = { PARSER_VERSION, parseTranscript }
