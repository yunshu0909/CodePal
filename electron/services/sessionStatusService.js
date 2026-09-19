/**
 * 会话状态服务（原 K28 状态灯，#41）
 *
 * 负责：
 * - 读取 Claude Code / Codex 钩子写下的会话状态（states/*.txt、.task、.ask）与 Claude 动态工作流
 * - 列表规则：只留进行中 / 等你确认 / 完成了；Codex 完成后 30 分钟消失；任何状态 24 小时不变就不显示；排序；最多 20 个
 * - 总开关：打开 = 复制钩子脚本 + 给检测到的工具装钩子；关闭 = 删掉 CodePal 加的钩子 + 清空状态
 *
 * 目录仍是 ~/.claude/k28-status-light（旧状态灯留下的名字，为兼容已装的钩子不改）；
 * K28 亮灯、语音播报、蓝牙依赖、音频保护已删除，tts.conf 里的旧语音项保留但不再读取。
 *
 * @module electron/services/sessionStatusService
 */
const fs = require('fs/promises')
const path = require('path')
const os = require('os')
// settings.json 写入统一走唯一 broker（V1.9.8 收口）；本模块 atomicWriteText 只用于 Codex config / 本目录的 conf
const { mutateClaudeSettingsFile, detectUnsupportedCustomRoot } = require('./claudeSettingsService')
const { trustCodePalCodexHooks } = require('./codexHookTrust')

const HOOK_DIR = path.join(os.homedir(), '.claude', 'k28-status-light')
const TEMPLATE_DIR = path.resolve(__dirname, '..', '..', 'templates', 'k28-status-light')
const CONF_PATH = path.join(HOOK_DIR, 'tts.conf')
const STATES_DIR = path.join(HOOK_DIR, 'states')
const CLAUDE_HOOK_MARK = 'k28-status-light/k28_status.sh'
const CODEX_HOOK_MARK = 'k28-status-light/codex-hook.sh'

const EXECUTABLE_TEMPLATE_FILES = new Set(['codex-delayed-clear.sh', 'codex-hook.sh', 'codex-notify.sh', 'k28_status.sh'])

const CLAUDE_HOME = path.join(os.homedir(), '.claude')
const CODEX_HOME = path.join(os.homedir(), '.codex')
const CLAUDE_PROJECTS_DIR = path.join(CLAUDE_HOME, 'projects')
const CODEX_CONFIG_PATH = path.join(CODEX_HOME, 'config.toml')

const CLAUDE_WORKFLOW_FINISHED_STATUSES = new Set([
  'completed', 'complete', 'done', 'failed', 'failure', 'error', 'cancelled', 'canceled', 'aborted',
])
// 心跳活跃窗口：run 目录内任一文件 5 分钟内有写入才算"正在跑"
const CLAUDE_WORKFLOW_LIVE_MS = 5 * 60 * 1000
// 单次最多检查的 run 目录数（按目录新鲜度倒序后取头部，防历史目录全量读盘）
const CLAUDE_WORKFLOW_MAX_RUNS = 60

// 列表规则（设计：specs/状态提醒重做/状态清单-会话状态-草案.md 触发表、A6、A13）
// stopped = 你中途中断（只有 Codex 有这个时机），灰标「已停止」、不通知
const STATE_ORDER = Object.freeze({ attention: 0, busy: 1, done: 2, stopped: 3 })
const CODEX_DONE_TTL_MS = 30 * 60 * 1000
const STALE_TTL_MS = 24 * 60 * 60 * 1000
const MAX_VISIBLE_SESSIONS = 20
const STORE_KEY_ENABLED = 'sessionStatusEnabled'

/**
 * 判断路径是否存在
 * @param {string} filePath - 文件或目录路径
 * @returns {Promise<boolean>}
 */
async function pathExists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

/**
 * 原子写入文本文件
 * @param {string} filePath - 目标路径
 * @param {string} content - 内容
 * @returns {Promise<void>}
 */
async function atomicWriteText(filePath, content) {
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  try {
    await fs.writeFile(tmpPath, content, 'utf-8')
    await fs.rename(tmpPath, filePath)
  } catch (error) {
    try { await fs.unlink(tmpPath) } catch {}
    throw error
  }
}

/**
 * 复制内置 K28 模板到用户目录
 * @returns {Promise<void>}
 */
async function installTemplateFiles() {
  if (!(await pathExists(TEMPLATE_DIR))) {
    throw new Error(`未找到内置会话状态模板: ${TEMPLATE_DIR}`)
  }
  await fs.mkdir(HOOK_DIR, { recursive: true })
  await fs.mkdir(STATES_DIR, { recursive: true })

  const entries = await fs.readdir(TEMPLATE_DIR, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const source = path.join(TEMPLATE_DIR, entry.name)
    const target = path.join(HOOK_DIR, entry.name)

    // 已有配置文件可能包含真实 key，安装/修复时不能覆盖。
    if (entry.name === 'tts.conf' && await pathExists(target)) continue

    await fs.copyFile(source, target)
    if (EXECUTABLE_TEMPLATE_FILES.has(entry.name)) {
      await fs.chmod(target, 0o755)
    }
  }
}

/**
 * 给 Claude settings 写入 K28 hooks
 * @returns {Promise<void>}
 */
async function installClaudeHooks() {
  // 配置根不支持时必须在任何副作用之前拒绝（前面已有脚本复制 / 依赖安装）
  const unsupportedRoot = detectUnsupportedCustomRoot()
  if (unsupportedRoot) {
    throw Object.assign(new Error(unsupportedRoot.error), { code: unsupportedRoot.errorCode })
  }
  // 单次事务：hooks 的构造必须基于**事务内最新** settings，
  // 否则会按旧快照重建，覆盖并发的其他 settings 改动。
  const writeResult = await mutateClaudeSettingsFile(({ data, kind, errorCode, error }) => {
    if (kind === 'corrupt' || kind === 'io_error') {
      // 历史行为：非 ENOENT 的读取/解析错误直接抛出，不自动修复
      return { ok: false, errorCode: errorCode || 'SESSION_STATUS_SETTINGS_UNREADABLE', error: error || '无法读取 Claude settings.json' }
    }

    const next = { ...data }
    if (!next.hooks || typeof next.hooks !== 'object' || Array.isArray(next.hooks)) next.hooks = {}
    else next.hooks = { ...next.hooks }

    const addHook = (eventName, command, matcher = null) => {
      const groups = Array.isArray(next.hooks[eventName]) ? next.hooks[eventName] : []
      const filteredGroups = groups
        .map((group) => ({
          ...group,
          hooks: Array.isArray(group.hooks)
            ? group.hooks.filter((hook) => !String(hook.command || '').includes('k28-status-light/k28_status.sh'))
            : [],
        }))
        .filter((group) => group.hooks.length > 0)

      const nextGroup = {
        ...(matcher ? { matcher } : {}),
        hooks: [{ type: 'command', command }],
      }
      next.hooks[eventName] = [...filteredGroups, nextGroup]
    }

    addHook('SessionStart', `bash ${path.join(HOOK_DIR, 'k28_status.sh')} idle`)
    addHook('UserPromptSubmit', `bash ${path.join(HOOK_DIR, 'k28_status.sh')} busy`)
    addHook('PreToolUse', `bash ${path.join(HOOK_DIR, 'k28_status.sh')} attention`, 'AskUserQuestion')
    addHook('PostToolUse', `bash ${path.join(HOOK_DIR, 'k28_status.sh')} busy`, 'AskUserQuestion')
    addHook('Stop', `bash ${path.join(HOOK_DIR, 'k28_status.sh')} done`)
    addHook('SessionEnd', `bash ${path.join(HOOK_DIR, 'k28_status.sh')} clear`)

    // 启动时每次都会调：钩子已经是这一套就不写，避免每次启动都重写 settings.json、攒一份备份
    if (JSON.stringify(next) === JSON.stringify(data)) return { ok: true, noop: true }
    return { ok: true, next, create: true }
  }, { backupSuffix: 'k28-hooks' })

  if (!writeResult.success) {
    // 结构化提交状态不能只留在 broker：抛错时一并带上，供上层区分"完全没写"与"已写入未验证"
    const error = new Error(writeResult.error || '写入 Claude settings.json 失败')
    error.code = writeResult.errorCode || 'WRITE_FAILED'
    error.committed = writeResult.committed === true
    error.durability = writeResult.durability || null
    throw error
  }
}

/**
 * 给 Codex config.toml 追加 K28 hooks；已有 K28 hooks 时只确保 features.hooks=true
 * @returns {Promise<void>}
 */
async function installCodexHooks() {
  let content = ''
  try {
    content = await fs.readFile(CODEX_CONFIG_PATH, 'utf-8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }

  // 不再改顶层 notify：「完成了」由 Stop 钩子负责；旧逻辑认不出多行写法的 notify，会插出重复的键让 Codex 读配置失败
  let nextContent = content

  if (/\[features\]/.test(nextContent)) {
    if (/(\[features\][\s\S]*?)(?=\n\[|$)/.test(nextContent)) {
      nextContent = nextContent.replace(/(\[features\][\s\S]*?)(?=\n\[|$)/, (block) => {
        if (/^hooks\s*=/m.test(block)) {
          return block.replace(/^hooks\s*=.*$/m, 'hooks = true')
        }
        return `${block.trimEnd()}\nhooks = true\n`
      })
    }
  } else {
    nextContent = `${nextContent.trimEnd()}\n\n[features]\nhooks = true\n`
  }

  // 每次都先删掉我们旧的一套再追加最新的：旧安装只有 4 个时机，这样能升级到 6 个；内容没变就不写
  // 钩子内容（command / timeout / statusMessage / matcher）必须和旧安装逐字一致：Codex 按内容算 trusted_hash，
  // 任何一处变了，用户已信任的钩子就会被判为未信任而停用（statusMessage 因此保留旧的「K28 …」）
  nextContent = stripCodexHooks(nextContent)
  const hook = (event, state, matcher) => `
[[hooks.${event}]]
${matcher ? `matcher = "${matcher}"\n` : ''}
[[hooks.${event}.hooks]]
type = "command"
command = "bash ${path.join(HOOK_DIR, 'codex-hook.sh')} ${state}"
timeout = 10
statusMessage = "K28 ${state}"
`
  nextContent = `${nextContent.trimEnd()}

# CodePal session status hooks${[
    // PostToolUse：批准后工具跑完 → 回到进行中；SessionEnd：关会话 → 立刻清掉（不触发时仍按完成后 30 分钟收尾）
    hook('SessionStart', 'idle', 'startup|resume|clear|compact'),
    hook('UserPromptSubmit', 'busy'),
    hook('PermissionRequest', 'attention'),
    hook('PostToolUse', 'busy'),
    hook('Stop', 'done'),
    hook('SessionEnd', 'clear'),
    // Interrupt：你中途停止这一轮 → 已停止（不通知）；新钩子同样要用户在 Codex 里确认信任
    hook('Interrupt', 'stopped'),
  ].join('')}`

  if (`${nextContent.trimEnd()}\n` === content) return

  if (content) {
    const backupPath = `${CODEX_CONFIG_PATH}.k28.${Date.now()}.bak`
    await fs.writeFile(backupPath, content, 'utf-8')
  }
  await atomicWriteText(CODEX_CONFIG_PATH, `${nextContent.trimEnd()}\n`)
}

/**
 * 从 Claude workflow 脚本文本里提取 meta 字段
 * @param {string} script - workflow 脚本文本
 * @param {string} field - meta 字段名
 * @returns {string}
 */
function extractWorkflowMetaValue(script, field) {
  const match = String(script || '').match(new RegExp(`${field}:\\s*(['"\`])([\\s\\S]*?)\\1`))
  return match?.[2]?.trim() || ''
}

/**
 * 计算 run 目录的最近心跳：目录内任一文件的最大 mtime（毫秒）
 * 活跃工作流的 agent .jsonl 会持续流式写入，故用 max(mtime) 判断"是否仍在动"
 * @param {string} runDir - <session>/subagents/workflows/wf_<id> 目录
 * @returns {Promise<number>} 毫秒时间戳，读取失败返回 0
 */
async function readWorkflowRunHeartbeatMs(runDir) {
  let entries = []
  try {
    entries = await fs.readdir(runDir, { withFileTypes: true })
  } catch {
    return 0
  }
  let latestMs = 0
  for (const entry of entries) {
    if (!entry.isFile()) continue
    try {
      const stat = await fs.stat(path.join(runDir, entry.name))
      if (stat.mtimeMs > latestMs) latestMs = stat.mtimeMs
    } catch {}
  }
  return latestMs
}

/**
 * 判断 run 是否已结束
 * Claude Code 仅在工作流跑完时才把完成快照写到 <session>/workflows/<runId>.json，
 * 故快照出现即视为结束；仅当快照显式带「非终态」status 时才例外（防御未来格式变化）。
 * @param {string} sessionDir - 会话目录
 * @param {string} runId - 工作流 runId（wf_*）
 * @returns {Promise<boolean>}
 */
async function isClaudeWorkflowFinished(sessionDir, runId) {
  const snapshotPath = path.join(sessionDir, 'workflows', `${runId}.json`)
  let raw
  try {
    raw = await fs.readFile(snapshotPath, 'utf-8')
  } catch {
    return false
  }
  try {
    const status = String(JSON.parse(raw)?.status || '').trim().toLowerCase()
    if (status && !CLAUDE_WORKFLOW_FINISHED_STATUSES.has(status)) return false
  } catch {}
  return true
}

/**
 * 读取 run 对应工作流脚本的 meta（name / description）
 * 脚本落在 <session>/workflows/scripts/<slug>-<runId>.js
 * @param {string} sessionDir - 会话目录
 * @param {string} runId - 工作流 runId
 * @returns {Promise<{name: string, description: string}>}
 */
async function readClaudeWorkflowScriptMeta(sessionDir, runId) {
  const scriptsDir = path.join(sessionDir, 'workflows', 'scripts')
  let entries = []
  try {
    entries = await fs.readdir(scriptsDir)
  } catch {
    return { name: '', description: '' }
  }
  const scriptName = entries.find((name) => name.endsWith(`${runId}.js`))
    || entries.find((name) => name.includes(runId))
  if (!scriptName) return { name: '', description: '' }
  try {
    const script = await fs.readFile(path.join(scriptsDir, scriptName), 'utf-8')
    return {
      name: extractWorkflowMetaValue(script, 'name'),
      description: extractWorkflowMetaValue(script, 'description'),
    }
  } catch {
    return { name: '', description: '' }
  }
}

/**
 * 从 journal.jsonl 统计 agent 进度文案
 * 事件 started=已派发、result=已完成，按 agentId 去重；
 * 分母取「已派发数」（运行中无法预知最终总量，宁可如实反映已观测到的）
 * @param {string} runDir - run 目录
 * @returns {Promise<string>} 形如 "3/5 agents done"，无数据返回 ''
 */
async function readClaudeWorkflowProgressText(runDir) {
  let raw
  try {
    raw = await fs.readFile(path.join(runDir, 'journal.jsonl'), 'utf-8')
  } catch {
    return ''
  }
  const started = new Set()
  const done = new Set()
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let event
    try {
      event = JSON.parse(trimmed)
    } catch {
      continue
    }
    const agentId = event?.agentId || event?.key
    if (!agentId) continue
    if (event.type === 'started') started.add(agentId)
    else if (event.type === 'result') done.add(agentId)
  }
  if (!started.size) return ''
  return `${done.size}/${started.size} agents done`
}

/**
 * 把一个正在跑的工作流 run 映射成 K28 活跃状态行
 * @param {object} run - run 描述
 * @param {string} run.runId - 工作流 runId
 * @param {number} run.heartbeatMs - 最近心跳毫秒时间戳
 * @param {{name: string, description: string}} run.meta - 脚本 meta
 * @param {string} run.progress - 进度文案
 * @returns {object}
 */
function toClaudeWorkflowState({ runId, heartbeatMs, meta, progress }) {
  const name = String(meta?.name || runId || 'Claude workflow').trim()
  const description = String(meta?.description || 'Claude dynamic workflow').trim()
  return {
    key: `claude-workflow:${runId}`,
    state: 'busy',
    epoch: Math.floor((heartbeatMs || 0) / 1000),
    name,
    task: progress ? `${description} · ${progress}` : description,
    source: 'Claude',
  }
}

/**
 * 收集 Claude Code dynamic workflow 的运行目录
 * 运行态实时落在 <session>/subagents/workflows/wf_<id>/，完成后才有 <session>/workflows/wf_<id>.json
 * @param {string} projectsDir - ~/.claude/projects 目录
 * @returns {Promise<Array<{runId: string, runDir: string, sessionDir: string}>>}
 */
async function collectClaudeWorkflowRuns(projectsDir) {
  const runs = []
  let projectEntries = []
  try {
    projectEntries = await fs.readdir(projectsDir, { withFileTypes: true })
  } catch {
    return runs
  }

  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory()) continue
    const projectDir = path.join(projectsDir, projectEntry.name)
    let sessionEntries = []
    try {
      sessionEntries = await fs.readdir(projectDir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const sessionEntry of sessionEntries) {
      if (!sessionEntry.isDirectory()) continue
      const sessionDir = path.join(projectDir, sessionEntry.name)
      const runsDir = path.join(sessionDir, 'subagents', 'workflows')
      let runEntries = []
      try {
        runEntries = await fs.readdir(runsDir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const runEntry of runEntries) {
        if (runEntry.isDirectory() && runEntry.name.startsWith('wf_')) {
          runs.push({
            runId: runEntry.name,
            runDir: path.join(runsDir, runEntry.name),
            sessionDir,
          })
        }
      }
    }
  }

  return runs
}

/**
 * 读取 Claude Code dynamic workflow 的活跃（进行中）状态
 * 判活两道独立信号：① 无完成快照；② run 目录心跳在 liveMs 内（防崩溃后的僵尸 run）
 * @param {object} options - 读取选项
 * @param {string} [options.projectsDir] - Claude projects 目录
 * @param {number} [options.nowMs] - 当前毫秒时间戳
 * @param {number} [options.liveMs] - 心跳活跃窗口
 * @returns {Promise<Array<{key: string, state: string, epoch: number, name: string, task: string, source: string}>>}
 */
async function readClaudeWorkflowStates({
  projectsDir = CLAUDE_PROJECTS_DIR,
  nowMs = Date.now(),
  liveMs = CLAUDE_WORKFLOW_LIVE_MS,
} = {}) {
  const runs = await collectClaudeWorkflowRuns(projectsDir)

  // 按 run 目录自身 mtime 粗排取头部，避免历史目录全量读盘
  const ranked = []
  for (const run of runs) {
    let dirMtimeMs = 0
    try {
      dirMtimeMs = (await fs.stat(run.runDir)).mtimeMs
    } catch {}
    ranked.push({ ...run, dirMtimeMs })
  }
  ranked.sort((a, b) => b.dirMtimeMs - a.dirMtimeMs)

  const states = []
  for (const run of ranked.slice(0, CLAUDE_WORKFLOW_MAX_RUNS)) {
    // 完成快照出现即结束，不再算进行中
    if (await isClaudeWorkflowFinished(run.sessionDir, run.runId)) continue
    // 心跳超时 = 崩溃/中断的僵尸 run，不显示
    const heartbeatMs = await readWorkflowRunHeartbeatMs(run.runDir)
    if (!heartbeatMs || nowMs - heartbeatMs > liveMs) continue
    const meta = await readClaudeWorkflowScriptMeta(run.sessionDir, run.runId)
    const progress = await readClaudeWorkflowProgressText(run.runDir)
    states.push(toClaudeWorkflowState({ runId: run.runId, heartbeatMs, meta, progress }))
  }

  return states
}

/**
 * 读取活跃状态文件
 * @returns {Promise<Array<{key: string, state: string, epoch: number, name: string, task: string}>>}
 */
async function readActiveStates() {
  let states = []
  try {
    const entries = await fs.readdir(STATES_DIR, { withFileTypes: true })
    const textFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.txt'))
    for (const entry of textFiles) {
      const key = entry.name.replace(/\.txt$/, '')
      const filePath = path.join(STATES_DIR, entry.name)
      const taskPath = path.join(STATES_DIR, `${key}.task`)
      try {
        const content = await fs.readFile(filePath, 'utf-8')
        const [state = '', epochRaw = '', name = '', source = ''] = content.trim().split('\t')
        let task = ''
        try {
          task = (await fs.readFile(taskPath, 'utf-8')).trim()
        } catch {}
        let ask = ''
        try {
          ask = (await fs.readFile(path.join(STATES_DIR, `${key}.ask`), 'utf-8')).trim()
        } catch {}
        states.push({
          key,
          state,
          epoch: Number(epochRaw) || 0,
          name,
          task,
          ask,
          source,
        })
      } catch {}
    }
  } catch {}

  const workflowStates = await readClaudeWorkflowStates()
  states = [...states, ...workflowStates]
  return states.sort((a, b) => b.epoch - a.epoch)
}

/**
 * 按列表规则挑出要显示的会话
 * - 只留进行中 / 等你确认 / 完成了 / 已停止
 * - Codex 完成 / 已停止后 30 分钟没新动静就消失；Claude 靠会话结束钩子消失
 * - 任何状态 24 小时没变就不显示（强行关终端时结束钩子来不及触发的兜底）
 * - 排序：等你确认 → 进行中 → 完成了 → 已停止，同类新的在前；最多 20 个，total 是真实总数
 * @param {Array<{state: string, epoch: number, source: string}>} states
 * @param {number} [nowMs=Date.now()]
 * @returns {{sessions: Array<object>, total: number}}
 */
function selectVisibleSessions(states, nowMs = Date.now()) {
  const alive = (Array.isArray(states) ? states : []).filter((item) => {
    // hasOwn 而不是 in：状态文件写坏成 toString 这类原型链键时也要跳过
    if (!Object.hasOwn(STATE_ORDER, item?.state)) return false
    const ageMs = nowMs - (Number(item.epoch) || 0) * 1000
    if (ageMs > STALE_TTL_MS) return false
    if (item.source === 'Codex' && (item.state === 'done' || item.state === 'stopped') && ageMs > CODEX_DONE_TTL_MS) return false
    return true
  })
  alive.sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || b.epoch - a.epoch)
  return { sessions: alive.slice(0, MAX_VISIBLE_SESSIONS), total: alive.length }
}

/**
 * 检测本机装了哪些工具（看配置根目录在不在）
 * @returns {Promise<{claude: boolean, codex: boolean}>}
 */
async function detectTools() {
  const [claude, codex] = await Promise.all([pathExists(CLAUDE_HOME), pathExists(CODEX_HOME)])
  return { claude, codex }
}

/**
 * 把 conf 里的总闸改成指定值；其余行（含旧语音配置、真实 key）原样保留
 * @param {'0'|'1'} value
 * @returns {Promise<void>}
 */
async function setConfSwitch(value) {
  let raw = ''
  try {
    raw = await fs.readFile(CONF_PATH, 'utf-8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const line = `STATUS_LIGHT_ENABLED=${value}`
  let next
  if (/^STATUS_LIGHT_ENABLED=.*$/m.test(raw)) next = raw.replace(/^STATUS_LIGHT_ENABLED=.*$/m, line)
  else next = `${raw.trimEnd()}${raw ? '\n' : ''}${line}\n`
  // 旧安装的 conf 顶上补一段说明：语音 / 亮灯项已停用（只补一次）
  if (!next.includes('[CodePal 会话状态]')) {
    next = `# [CodePal 会话状态] STATUS_LIGHT_ENABLED 是总闸，由 CodePal 自动维护。\n# 其余语音 / 亮灯 / 摘要设置已停用，CodePal 不再读取，保留只为兼容旧安装。\n\n${next}`
  }
  if (next !== raw) await atomicWriteText(CONF_PATH, next)
}

/**
 * 删掉 Claude settings 里 CodePal 加的会话状态钩子；其他钩子原样保留
 * @returns {Promise<void>}
 */
async function uninstallClaudeHooks() {
  const writeResult = await mutateClaudeSettingsFile(({ data, kind, exists, errorCode, error }) => {
    if (!exists) return { ok: true, noop: true }
    if (kind === 'corrupt' || kind === 'io_error') {
      return { ok: false, errorCode: errorCode || 'SESSION_STATUS_SETTINGS_UNREADABLE', error: error || '无法读取 Claude settings.json' }
    }
    const hooks = data?.hooks
    if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return { ok: true, noop: true }
    let changed = false
    const nextHooks = {}
    for (const [eventName, groups] of Object.entries(hooks)) {
      if (!Array.isArray(groups)) { nextHooks[eventName] = groups; continue }
      const kept = groups
        .map((group) => {
          if (!Array.isArray(group?.hooks)) return group
          const hs = group.hooks.filter((hook) => !String(hook?.command || '').includes(CLAUDE_HOOK_MARK))
          if (hs.length !== group.hooks.length) changed = true
          return { ...group, hooks: hs }
        })
        .filter((group) => !Array.isArray(group?.hooks) || group.hooks.length > 0)
      if (kept.length) nextHooks[eventName] = kept
      else changed = true
    }
    if (!changed) return { ok: true, noop: true }
    const next = { ...data, hooks: nextHooks }
    if (!Object.keys(nextHooks).length) delete next.hooks
    return { ok: true, next }
  }, { backupSuffix: 'session-status-off' })

  if (!writeResult.success) {
    const err = new Error(writeResult.error || '写入 Claude settings.json 失败')
    err.code = writeResult.errorCode || 'WRITE_FAILED'
    throw err
  }
}

/**
 * 从 Codex config.toml 删掉 CodePal 加的会话状态钩子；其他内容原样保留
 * notify 行不删：旧安装把它换成了 codex-notify.sh，它还负责把 turn-ended 转给 Codex Computer Use；
 * 关掉后 conf 总闸为 0，它只转发、不再记录会话
 * 按表头把文件切段：删「命令指向我们脚本」的 [[hooks.X.hooks]] 段，以及紧挨在它前面、只有 matcher 的 [[hooks.X]] 段
 * @param {string} content
 * @returns {string}
 */
function stripCodexHooks(content) {
  const lines = content.split('\n')
  const segments = []
  let current = { header: null, lines: [] }
  for (const line of lines) {
    if (/^\s*\[/.test(line)) {
      segments.push(current)
      current = { header: line.trim(), lines: [line] }
    } else {
      current.lines.push(line)
    }
  }
  segments.push(current)

  const drop = new Set()
  segments.forEach((seg, index) => {
    if (!seg.header || !/^\[\[hooks\.[A-Za-z]+\.hooks\]\]$/.test(seg.header)) return
    if (!seg.lines.some((l) => l.includes(CODEX_HOOK_MARK))) return
    drop.add(index)
    const prev = segments[index - 1]
    const parent = seg.header.replace('.hooks]]', ']]')
    if (prev && prev.header === parent) {
      const body = prev.lines.slice(1).filter((l) => l.trim() && !l.trim().startsWith('#'))
      if (body.every((l) => /^\s*matcher\s*=/.test(l))) drop.add(index - 1)
    }
  })

  const out = segments
    .filter((_, index) => !drop.has(index))
    .flatMap((seg) => seg.lines)
    .filter((line) => !/^#\s*CodePal (K28 status light|session status) hooks\s*$/.test(line.trim()))
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
}

/**
 * @returns {Promise<void>}
 */
async function uninstallCodexHooks() {
  let content
  try {
    content = await fs.readFile(CODEX_CONFIG_PATH, 'utf-8')
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  const next = stripCodexHooks(content)
  if (next === content) return
  await fs.writeFile(`${CODEX_CONFIG_PATH}.session-status.${Date.now()}.bak`, content, 'utf-8')
  await atomicWriteText(CODEX_CONFIG_PATH, next)
}

/**
 * 看钩子是否已装在各工具的配置里
 * @returns {Promise<{claude: boolean, codex: boolean}>}
 */
async function readHookPresence() {
  const has = async (file, mark) => {
    try {
      return (await fs.readFile(file, 'utf-8')).includes(mark)
    } catch {
      return false
    }
  }
  const [claude, codex] = await Promise.all([
    has(path.join(CLAUDE_HOME, 'settings.json'), CLAUDE_HOOK_MARK),
    has(CODEX_CONFIG_PATH, CODEX_HOOK_MARK),
  ])
  return { claude, codex }
}

/**
 * 清空状态文件（关掉功能时列表随之清空）
 * @returns {Promise<void>}
 */
async function clearStateFiles() {
  let entries = []
  try {
    entries = await fs.readdir(STATES_DIR)
  } catch {
    return
  }
  await Promise.all(entries
    .filter((name) => /\.(txt|task|ask)$/.test(name))
    .map((name) => fs.rm(path.join(STATES_DIR, name), { force: true })))
}

/**
 * 给检测到的工具装好 / 修好钩子（幂等，启动时和打开开关时都调）
 * 一边失败不影响另一边；返回每个工具的结果
 * @returns {Promise<{success: boolean, tools: {claude: boolean, codex: boolean}, failures: Array<{tool: string, error: string}>}>}
 */
async function installSessionStatus({ trustHooks = trustCodePalCodexHooks } = {}) {
  const tools = await detectTools()
  const failures = []
  if (!tools.claude && !tools.codex) return { success: true, tools, failures }
  // 配置根不支持且没有别的工具可装时，必须在任何副作用（复制脚本 / 改 conf）之前拒绝
  const unsupportedRoot = tools.claude ? detectUnsupportedCustomRoot() : null
  if (unsupportedRoot && !tools.codex) {
    return { success: false, tools, failures: [{ tool: 'claude', error: unsupportedRoot.error }] }
  }

  try {
    await installTemplateFiles()
    await setConfSwitch('1')
  } catch (error) {
    return { success: false, tools, failures: [{ tool: 'all', error: error.message }] }
  }

  if (tools.claude) {
    if (unsupportedRoot) failures.push({ tool: 'claude', error: unsupportedRoot.error })
    else {
      try {
        await installClaudeHooks()
      } catch (error) {
        failures.push({ tool: 'claude', error: error.message })
      }
    }
  }
  if (tools.codex) {
    try {
      await installCodexHooks()
      // 钩子装好后替用户在 Codex 里信任 CodePal 自己的钩子（走官方接口），否则新钩子不会运行
      try {
        await trustHooks({ configPath: CODEX_CONFIG_PATH })
      } catch (error) {
        failures.push({ tool: 'codex-trust', error: error.message })
      }
    } catch (error) {
      failures.push({ tool: 'codex', error: error.message })
    }
  }
  // 信任没成功不算装失败：旧的已信任钩子照常工作，页面提示用户去 Codex 里 /hooks 手动确认
  const hardFailures = failures.filter((f) => f.tool !== 'codex-trust').length
  const attempted = Number(tools.claude) + Number(tools.codex)
  return { success: hardFailures < attempted, tools, failures }
}

/**
 * 删掉 CodePal 加的钩子并清空状态（关掉开关时调）
 * @returns {Promise<{success: boolean, failures: Array<{tool: string, error: string}>}>}
 */
async function uninstallSessionStatus() {
  const failures = []
  try {
    await uninstallClaudeHooks()
  } catch (error) {
    failures.push({ tool: 'claude', error: error.message })
  }
  try {
    await uninstallCodexHooks()
  } catch (error) {
    failures.push({ tool: 'codex', error: error.message })
  }
  // 残留钩子（删不掉的那边）也让它只做清理，不再记录
  try {
    if (await pathExists(CONF_PATH)) await setConfSwitch('0')
  } catch {}
  await clearStateFiles()
  return { success: failures.length === 0, failures }
}

/**
 * 读当前可见会话
 * @param {number} [nowMs]
 * @returns {Promise<{sessions: Array<object>, total: number}>}
 */
async function listSessions(nowMs = Date.now()) {
  return selectVisibleSessions(await readActiveStates(), nowMs)
}

module.exports = {
  STATES_DIR,
  STORE_KEY_ENABLED,
  selectVisibleSessions,
  detectTools,
  readHookPresence,
  installSessionStatus,
  uninstallSessionStatus,
  listSessions,
  _private: {
    installClaudeHooks,
    uninstallClaudeHooks,
    stripCodexHooks,
    readClaudeWorkflowStates,
    toClaudeWorkflowState,
    readActiveStates,
  },
}
