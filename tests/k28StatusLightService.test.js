/**
 * K28 状态灯服务回归测试
 *
 * 负责：
 * - 验证 Claude Code dynamic workflow 运行中时会进入活跃 session（按真实落盘结构）
 * - 验证已出现完成快照的 workflow 不会被误算为活跃任务
 * - 验证心跳超时的僵尸 run 不会一直挂在进行中
 * - 验证缺脚本 meta 时回退到 runId
 *
 * 关键事实源（SSH 只读勘察确认）：运行态实时写在
 * <session>/subagents/workflows/wf_<id>/（journal.jsonl + agent-*.jsonl 流式增长），
 * 完成后才把快照写到 <session>/workflows/<id>.json 并盖 status:"completed"。
 *
 * @module tests/k28StatusLightService
 */

import { mkdir, mkdtemp, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { createRequire } from 'module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { _private } = require('../electron/services/k28StatusLightService')

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

describe('k28StatusLightService', () => {
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

describe('K28 安装入口：不支持的配置根必须提前拒绝', () => {
  it('设置非等价 CLAUDE_CONFIG_DIR 后，公开入口在产生任何副作用之前拒绝', async () => {
    const mod = require('../electron/services/k28StatusLightService')
    const original = process.env.CLAUDE_CONFIG_DIR
    const home = await mkdtemp(path.join(os.tmpdir(), 'k28-root-'))
    const originalHome = process.env.HOME
    try {
      process.env.CLAUDE_CONFIG_DIR = path.join(home, 'elsewhere')
      const result = await mod.installK28StatusLight()

      expect(result.success).toBe(false)
      expect(result.error).toMatch(/CLAUDE_CONFIG_DIR/)
      // 关键：不得先跑复制模板 / 装依赖 —— 那会留下半完成状态
      const ids = (result.steps || []).map((s) => s.id)
      expect(ids).not.toContain('copy-template')
      expect(ids).not.toContain('python-env')
    } finally {
      if (original === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = original
      if (originalHome === undefined) delete process.env.HOME
      else process.env.HOME = originalHome
    }
  })
})
