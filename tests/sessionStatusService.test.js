/**
 * 会话状态服务测试（#41，原 K28 状态灯服务测试迁移而来）
 *
 * 负责：
 * - Claude 动态工作流读取（原样保留的成熟逻辑）
 * - 列表规则：Codex 完成 30 分钟消失、24 小时兜底、排序、最多 20 个
 * - 打开 / 关掉：临时 HOME 下装钩子与删钩子的往返，只动 CodePal 自己的那几行
 * - Codex config 切段删钩子、不动用户内容与 notify 行
 * - 不支持的配置根：只有 Claude 时在任何副作用前拒绝
 *
 * @module tests/sessionStatusService
 */

import { mkdir, mkdtemp, writeFile, readFile, readdir } from 'fs/promises'
import os from 'os'
import path from 'path'
import { createRequire } from 'module'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { _private } = require('../electron/services/sessionStatusService')

/**
 * 按真实落盘结构写入一个 Claude workflow run
 * @param {string} projectsDir - 临时 ~/.claude/projects 目录
 * @param {object} options - run 选项
 * @param {string} options.runId - 工作流 runId（wf_*）
 * @param {object} [options.meta] - 脚本 meta，写入 scripts/<slug>-<runId>.js
 * @param {Array<object>} [options.journalEvents] - journal.jsonl 事件
 * @param {object|null} [options.completed] - 非空则写完成快照 workflows/<runId>.json
 * @returns {Promise<string>} runDir 路径
 */
async function writeWorkflowRun(projectsDir, { runId, meta, journalEvents = [], completed = null }) {
  const sessionDir = path.join(projectsDir, '-tmp-project', 'session-1')
  const runDir = path.join(sessionDir, 'subagents', 'workflows', runId)
  await mkdir(runDir, { recursive: true })

  const journal = journalEvents.map((event) => JSON.stringify(event)).join('\n')
  await writeFile(path.join(runDir, 'journal.jsonl'), `${journal}\n`, 'utf-8')
  // agent .jsonl 是运行态心跳的主要来源，补一个让结构更贴近真实
  await writeFile(path.join(runDir, 'agent-aaa.jsonl'), '{"type":"system"}\n', 'utf-8')

  if (meta) {
    const scriptsDir = path.join(sessionDir, 'workflows', 'scripts')
    await mkdir(scriptsDir, { recursive: true })
    const script = `export const meta = {\n  name: '${meta.name}',\n  description: '${meta.description}',\n}\n`
    await writeFile(path.join(scriptsDir, `${meta.name}-${runId}.js`), script, 'utf-8')
  }

  if (completed) {
    const workflowsDir = path.join(sessionDir, 'workflows')
    await mkdir(workflowsDir, { recursive: true })
    await writeFile(path.join(workflowsDir, `${runId}.json`), `${JSON.stringify(completed)}\n`, 'utf-8')
  }

  return runDir
}

describe('sessionStatusService · Claude 动态工作流（沿用原状态灯读取）', () => {
  it('includes running Claude dynamic workflows as active sessions', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'codepal-k28-status-'))
    const projectsDir = path.join(tempDir, '.claude', 'projects')

    await writeWorkflowRun(projectsDir, {
      runId: 'wf_release_review',
      meta: {
        name: 'release-review-v193',
        description: '校核 v1.9.3 两功能发版就绪',
      },
      // 3 个已派发、2 个已出结果 → 2/3 agents done
      journalEvents: [
        { type: 'started', agentId: 'a1' },
        { type: 'started', agentId: 'a2' },
        { type: 'started', agentId: 'a3' },
        { type: 'result', agentId: 'a1' },
        { type: 'result', agentId: 'a2' },
      ],
    })

    const states = await _private.readClaudeWorkflowStates({
      projectsDir,
      nowMs: Date.now(),
    })

    expect(states).toHaveLength(1)
    expect(states[0]).toMatchObject({
      key: 'claude-workflow:wf_release_review',
      state: 'busy',
      name: 'release-review-v193',
      source: 'Claude',
    })
    expect(states[0].task).toContain('校核 v1.9.3 两功能发版就绪')
    expect(states[0].task).toContain('2/3 agents done')
  })

  it('ignores workflows that already have a completion snapshot', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'codepal-k28-status-'))
    const projectsDir = path.join(tempDir, '.claude', 'projects')

    await writeWorkflowRun(projectsDir, {
      runId: 'wf_completed',
      meta: { name: 'release-review-v193', description: '已经结束的 workflow' },
      journalEvents: [
        { type: 'started', agentId: 'a1' },
        { type: 'result', agentId: 'a1' },
      ],
      // 完成快照一旦出现就算结束
      completed: { runId: 'wf_completed', status: 'completed', agentCount: 1 },
    })

    const states = await _private.readClaudeWorkflowStates({
      projectsDir,
      nowMs: Date.now(),
    })

    expect(states).toEqual([])
  })

  it('drops zombie runs whose heartbeat has gone stale', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'codepal-k28-status-'))
    const projectsDir = path.join(tempDir, '.claude', 'projects')

    await writeWorkflowRun(projectsDir, {
      runId: 'wf_zombie',
      meta: { name: 'crashed-workflow', description: '崩在半路的工作流' },
      journalEvents: [{ type: 'started', agentId: 'a1' }],
      // 无完成快照，但心跳早就停了
    })

    // 把"现在"推到 10 分钟后，超过默认 5 分钟心跳窗口
    const states = await _private.readClaudeWorkflowStates({
      projectsDir,
      nowMs: Date.now() + 10 * 60 * 1000,
    })

    expect(states).toEqual([])
  })

  it('falls back to runId when script meta is missing', () => {
    const state = _private.toClaudeWorkflowState({
      runId: 'wf_meta',
      heartbeatMs: 1780838272455,
      meta: { name: '', description: '' },
      progress: '',
    })

    expect(state).toMatchObject({
      key: 'claude-workflow:wf_meta',
      state: 'busy',
      name: 'wf_meta',
      task: 'Claude dynamic workflow',
      source: 'Claude',
    })
  })
})

const NOW = Date.UTC(2026, 8, 19, 12, 0, 0)
const at = (minutesAgo) => Math.floor((NOW - minutesAgo * 60000) / 1000)

describe('列表规则 selectVisibleSessions', () => {
  const { selectVisibleSessions } = require('../electron/services/sessionStatusService')

  it('只留进行中 / 等你确认 / 完成了，按「等你确认 → 进行中 → 完成了」排，同类新的在前', () => {
    const { sessions, total } = selectVisibleSessions([
      { key: 'a', state: 'done', epoch: at(1), source: 'Claude' },
      { key: 'b', state: 'busy', epoch: at(5), source: 'Claude' },
      { key: 'c', state: 'attention', epoch: at(9), source: 'Codex' },
      { key: 'd', state: 'busy', epoch: at(2), source: 'Codex' },
      { key: 'e', state: 'idle', epoch: at(1), source: 'Claude' },
    ], NOW)
    expect(sessions.map((s) => s.key)).toEqual(['c', 'd', 'b', 'a'])
    expect(total).toBe(4)
  })

  it('状态文件写坏（未知状态、原型链键）直接跳过', () => {
    const { sessions } = selectVisibleSessions([
      { key: 'x', state: 'toString', epoch: at(1), source: 'Claude' },
      { key: 'y', state: 'constructor', epoch: at(1), source: 'Codex' },
      { key: 'z', state: '', epoch: at(1), source: 'Claude' },
      { key: 'ok', state: 'busy', epoch: at(1), source: 'Claude' },
    ], NOW)
    expect(sessions.map((s) => s.key)).toEqual(['ok'])
  })

  it('Codex 完成后 30 分钟消失；Claude 完成不按 30 分钟消失', () => {
    const { sessions } = selectVisibleSessions([
      { key: 'codex-29', state: 'done', epoch: at(29), source: 'Codex' },
      { key: 'codex-31', state: 'done', epoch: at(31), source: 'Codex' },
      { key: 'claude-90', state: 'done', epoch: at(90), source: 'Claude' },
      { key: 'codex-busy-90', state: 'busy', epoch: at(90), source: 'Codex' },
    ], NOW)
    expect(sessions.map((s) => s.key).sort()).toEqual(['claude-90', 'codex-29', 'codex-busy-90'])
  })

  it('任何状态 24 小时没变就不显示', () => {
    const { sessions } = selectVisibleSessions([
      { key: 'old', state: 'busy', epoch: at(24 * 60 + 1), source: 'Claude' },
      { key: 'ok', state: 'attention', epoch: at(24 * 60 - 1), source: 'Claude' },
    ], NOW)
    expect(sessions.map((s) => s.key)).toEqual(['ok'])
  })

  it('最多显示 20 个，total 是真实总数', () => {
    const many = Array.from({ length: 23 }, (_, i) => ({ key: `k${i}`, state: 'busy', epoch: at(i), source: 'Claude' }))
    const { sessions, total } = selectVisibleSessions(many, NOW)
    expect(sessions).toHaveLength(20)
    expect(total).toBe(23)
    expect(sessions[0].key).toBe('k0')
  })
})

describe('stripCodexHooks：只删 CodePal 的钩子段', () => {
  const { _private } = require('../electron/services/sessionStatusService')
  const OURS = (event, state, matcher) => `[[hooks.${event}]]\n${matcher ? `matcher = "${matcher}"\n` : ''}\n[[hooks.${event}.hooks]]\ntype = "command"\ncommand = "bash /Users/x/.claude/k28-status-light/codex-hook.sh ${state}"\ntimeout = 10\n`

  it('用户自己的钩子、notify 行、其他表都保留；我们的段和注释行删掉', () => {
    const user = 'model = "gpt-5"\nnotify = ["bash", "/Users/x/.claude/k28-status-light/codex-notify.sh"]\n\n[features]\nhooks = true\n\n[[hooks.Stop]]\n\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "say done"\n'
    const content = `${user}\n# CodePal K28 status light hooks\n${OURS('SessionStart', 'idle', 'startup|resume|clear|compact')}\n${OURS('UserPromptSubmit', 'busy')}\n${OURS('Stop', 'done')}\n[profiles.fast]\nmodel = "gpt-5-mini"\n`
    const out = _private.stripCodexHooks(content)
    expect(out).not.toContain('codex-hook.sh')
    expect(out).not.toContain('CodePal K28 status light hooks')
    expect(out).toContain('command = "say done"')
    expect(out).toContain('notify = ["bash", "/Users/x/.claude/k28-status-light/codex-notify.sh"]')
    expect(out).toContain('[profiles.fast]')
    expect(out).toContain('[features]\nhooks = true')
    expect(out.match(/\[\[hooks\.Stop\]\]/g)).toHaveLength(1)
    expect(out.match(/\[\[hooks\.SessionStart\]\]/g)).toBeNull()
  })

  it('没有我们的段时原样返回（只规整结尾换行）', () => {
    const content = 'model = "gpt-5"\n\n[features]\nhooks = true\n'
    expect(_private.stripCodexHooks(content)).toBe(content)
  })
})

/**
 * 在临时 HOME 下重新加载服务（常量在加载时按 os.homedir() 算）
 * @param {string} home
 */
function loadFresh(home) {
  process.env.HOME = home
  for (const id of Object.keys(require.cache)) {
    if (/electron[\\/]services[\\/](sessionStatusService|claudeSettingsService)\.js$/.test(id)) delete require.cache[id]
  }
  return require('../electron/services/sessionStatusService')
}

describe('打开 / 关掉：临时 HOME 下的往返', () => {
  const originalHome = process.env.HOME
  const originalRoot = process.env.CLAUDE_CONFIG_DIR
  afterEach(() => {
    process.env.HOME = originalHome
    if (originalRoot === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalRoot
    for (const id of Object.keys(require.cache)) {
      if (/electron[\\/]services[\\/](sessionStatusService|claudeSettingsService)\.js$/.test(id)) delete require.cache[id]
    }
  })

  it('重复打开不重写 Claude settings.json、不攒备份', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'ss-home-'))
    delete process.env.CLAUDE_CONFIG_DIR
    await mkdir(path.join(home, '.claude'), { recursive: true })
    await writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'opus' }))
    const svc = loadFresh(home)
    await svc.installSessionStatus()
    const first = await readFile(path.join(home, '.claude', 'settings.json'), 'utf-8')
    const count = async () => (await readdir(path.join(home, '.claude'), { recursive: true })).filter((f) => /settings-.*\.json$/.test(f)).length
    const before = await count()
    await svc.installSessionStatus()
    await svc.installSessionStatus()
    expect(await readFile(path.join(home, '.claude', 'settings.json'), 'utf-8')).toBe(first)
    expect(await count()).toBe(before)
  })

  it('打开装好两边钩子、总闸为 1；关掉只删我们的钩子、保留用户的，清空状态、总闸为 0', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'ss-home-'))
    delete process.env.CLAUDE_CONFIG_DIR
    await mkdir(path.join(home, '.claude'), { recursive: true })
    await mkdir(path.join(home, '.codex'), { recursive: true })
    const userHook = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }
    await writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'opus', hooks: { PreToolUse: [userHook] } }))
    await writeFile(path.join(home, '.codex', 'config.toml'), 'model = "gpt-5"\n')
    const svc = loadFresh(home)

    const on = await svc.installSessionStatus()
    expect(on).toMatchObject({ success: true, tools: { claude: true, codex: true }, failures: [] })
    const settings = JSON.parse(await readFile(path.join(home, '.claude', 'settings.json'), 'utf-8'))
    expect(JSON.stringify(settings.hooks)).toContain('k28-status-light/k28_status.sh')
    expect(settings.hooks.PreToolUse.some((g) => g.hooks[0].command === 'echo mine')).toBe(true)
    expect(await readFile(path.join(home, '.codex', 'config.toml'), 'utf-8')).toContain('codex-hook.sh')
    expect(await readFile(path.join(home, '.claude', 'k28-status-light', 'tts.conf'), 'utf-8')).toMatch(/^STATUS_LIGHT_ENABLED=1$/m)
    expect(await svc.readHookPresence()).toEqual({ claude: true, codex: true })
    // 只复制记状态要用的脚本，不再有语音 / 亮灯 / 蓝牙
    const files = await readdir(path.join(home, '.claude', 'k28-status-light'))
    expect(files).toEqual(expect.arrayContaining(['k28_status.sh', 'codex-hook.sh', 'codex-delayed-clear.sh', 'codex-notify.sh', 'tts.conf']))
    expect(files.some((f) => /tts_say|k28_render|k28_set|summarize_task/.test(f))).toBe(false)

    await writeFile(path.join(home, '.claude', 'k28-status-light', 'states', 's1.txt'), 'busy\t1\tproj\tClaude\n')
    await writeFile(path.join(home, '.claude', 'k28-status-light', 'states', 's1.task'), '修复')
    const off = await svc.uninstallSessionStatus()
    expect(off).toEqual({ success: true, failures: [] })
    const after = JSON.parse(await readFile(path.join(home, '.claude', 'settings.json'), 'utf-8'))
    expect(JSON.stringify(after)).not.toContain('k28_status.sh')
    expect(after.hooks).toEqual({ PreToolUse: [userHook] })
    expect(after.model).toBe('opus')
    const codexAfter = await readFile(path.join(home, '.codex', 'config.toml'), 'utf-8')
    expect(codexAfter).not.toContain('codex-hook.sh')
    expect(codexAfter).toContain('model = "gpt-5"')
    expect(await readdir(path.join(home, '.claude', 'k28-status-light', 'states'))).toEqual([])
    expect(await readFile(path.join(home, '.claude', 'k28-status-light', 'tts.conf'), 'utf-8')).toMatch(/^STATUS_LIGHT_ENABLED=0$/m)
    expect(await svc.readHookPresence()).toEqual({ claude: false, codex: false })
  })

  it('旧安装的 conf（总闸为 0、带真实 key）：打开只改总闸，key 和其他行原样保留，并补一段停用说明', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'ss-home-'))
    delete process.env.CLAUDE_CONFIG_DIR
    await mkdir(path.join(home, '.claude', 'k28-status-light'), { recursive: true })
    await writeFile(path.join(home, '.claude', 'k28-status-light', 'tts.conf'), 'STATUS_LIGHT_ENABLED=0\nVOLC_API_KEY=sk-***\n')
    const svc = loadFresh(home)
    await svc.installSessionStatus()
    const conf = await readFile(path.join(home, '.claude', 'k28-status-light', 'tts.conf'), 'utf-8')
    expect(conf).toMatch(/^STATUS_LIGHT_ENABLED=1$/m)
    expect(conf).toContain('VOLC_API_KEY=sk-***')
    expect(conf).toContain('[CodePal 会话状态]')
  })

  it('Codex：装 6 个时机（含工具用完、会话结束）；旧的 4 个会被升级且不重复；重复打开不改文件、不产生新备份', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'ss-home-'))
    delete process.env.CLAUDE_CONFIG_DIR
    await mkdir(path.join(home, '.codex'), { recursive: true })
    const oldBlock = ['SessionStart|idle|startup|resume|clear|compact', 'UserPromptSubmit|busy|', 'PermissionRequest|attention|', 'Stop|done|']
      .map((spec) => { const [e, st, m] = spec.split('|'); return `[[hooks.${e}]]\n${m ? `matcher = "${m}"\n` : ''}\n[[hooks.${e}.hooks]]\ntype = "command"\ncommand = "bash ${home}/.claude/k28-status-light/codex-hook.sh ${st}"\ntimeout = 10\nstatusMessage = "K28 ${st}"\n` }).join('\n')
    await writeFile(path.join(home, '.codex', 'config.toml'), `model = "gpt-5"\n\n[features]\nhooks = true\n\n# CodePal K28 status light hooks\n${oldBlock}`)
    const svc = loadFresh(home)
    await svc.installSessionStatus()
    const cfg = await readFile(path.join(home, '.codex', 'config.toml'), 'utf-8')
    for (const e of ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'PostToolUse', 'Stop', 'SessionEnd']) {
      expect(cfg.match(new RegExp(`^\\[\\[hooks\\.${e}\\]\\]$`, 'gm'))).toHaveLength(1)
    }
    expect(cfg).toContain('codex-hook.sh busy')
    expect(cfg).toContain('codex-hook.sh clear')
    expect(cfg).not.toContain('K28 status light')
    expect(cfg).toContain('model = "gpt-5"')
    const backups = async () => (await readdir(path.join(home, '.codex'))).filter((f) => f.endsWith('.bak')).length
    const before = await backups()
    await svc.installSessionStatus()
    expect(await readFile(path.join(home, '.codex', 'config.toml'), 'utf-8')).toBe(cfg)
    expect(await backups()).toBe(before)
  })

  it('Codex 顶层 notify（含多行写法）一律不碰：打开、关掉前后都原样', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'ss-home-'))
    delete process.env.CLAUDE_CONFIG_DIR
    await mkdir(path.join(home, '.codex'), { recursive: true })
    const notify = 'notify = [\n  "/Applications/Some Tool/bin",\n  "turn-ended",\n]\n'
    await writeFile(path.join(home, '.codex', 'config.toml'), `model = "gpt-5"\n${notify}\n[features]\nhooks = true\n`)
    const svc = loadFresh(home)
    await svc.installSessionStatus()
    const on = await readFile(path.join(home, '.codex', 'config.toml'), 'utf-8')
    expect(on.match(/^notify\s*=/gm)).toHaveLength(1)
    expect(on).toContain(notify)
    await svc.uninstallSessionStatus()
    const off = await readFile(path.join(home, '.codex', 'config.toml'), 'utf-8')
    expect(off).toContain(notify)
    expect(off).not.toContain('codex-hook.sh')
  })

  it('两个工具都没装：不做任何事，算成功', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'ss-home-'))
    const svc = loadFresh(home)
    expect(await svc.installSessionStatus()).toEqual({ success: true, tools: { claude: false, codex: false }, failures: [] })
    await expect(readdir(path.join(home, '.claude'))).rejects.toThrow()
  })

  it('配置根不支持且只有 Claude：在任何副作用之前拒绝', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'ss-home-'))
    await mkdir(path.join(home, '.claude'), { recursive: true })
    process.env.CLAUDE_CONFIG_DIR = path.join(home, 'elsewhere')
    const svc = loadFresh(home)
    const result = await svc.installSessionStatus()
    expect(result.success).toBe(false)
    expect(result.failures[0]).toMatchObject({ tool: 'claude' })
    expect(result.failures[0].error).toMatch(/CLAUDE_CONFIG_DIR/)
    expect(await readdir(path.join(home, '.claude'))).toEqual([])
  })

  it('读状态时带上「问什么」', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'ss-home-'))
    const dir = path.join(home, '.claude', 'k28-status-light', 'states')
    await mkdir(dir, { recursive: true })
    const epoch = Math.floor(Date.now() / 1000)
    await writeFile(path.join(dir, 'k1.txt'), `attention\t${epoch}\tskills\tCodex\n`)
    await writeFile(path.join(dir, 'k1.task'), '整理 ISSUES')
    await writeFile(path.join(dir, 'k1.ask'), '要不要删掉旧分支？')
    const svc = loadFresh(home)
    const { sessions } = await svc.listSessions()
    expect(sessions[0]).toMatchObject({ key: 'k1', state: 'attention', name: 'skills', source: 'Codex', task: '整理 ISSUES', ask: '要不要删掉旧分支？' })
  })
})
