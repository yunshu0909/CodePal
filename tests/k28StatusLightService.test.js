/**
 * K28 状态灯服务回归测试
 *
 * 负责：
 * - 验证 Claude Code dynamic workflow 运行中时会进入活跃 session
 * - 验证已结束 workflow 不会被误算为活跃任务
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
 * 写入临时 Claude workflow JSON
 * @param {string} projectsDir - 临时 ~/.claude/projects 目录
 * @param {object} workflow - workflow JSON
 * @returns {Promise<string>}
 */
async function writeWorkflow(projectsDir, workflow) {
  const workflowsDir = path.join(projectsDir, '-tmp-project', 'session-1', 'workflows')
  await mkdir(workflowsDir, { recursive: true })
  const filePath = path.join(workflowsDir, `${workflow.runId}.json`)
  await writeFile(filePath, `${JSON.stringify(workflow)}\n`, 'utf-8')
  return filePath
}

describe('k28StatusLightService', () => {
  it('includes running Claude dynamic workflows as active sessions', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'codepal-k28-status-'))
    const projectsDir = path.join(tempDir, '.claude', 'projects')
    const nowMs = Date.now()

    await writeWorkflow(projectsDir, {
      runId: 'wf_release_review',
      workflowName: 'release-review-v193',
      status: 'running',
      summary: '校核 v1.9.3 两功能发版就绪',
      startTime: nowMs - 10000,
      agentCount: 5,
      workflowProgress: [
        { type: 'workflow_agent', status: 'done' },
        { type: 'workflow_agent', status: 'done' },
        { type: 'workflow_agent', status: 'done' },
        { type: 'workflow_agent', status: 'done' },
        { type: 'workflow_agent', status: 'running' },
      ],
    })

    const states = await _private.readClaudeWorkflowStates({
      projectsDir,
      nowMs,
      maxAgeMs: 60000,
    })

    expect(states).toHaveLength(1)
    expect(states[0]).toMatchObject({
      key: 'claude-workflow:wf_release_review',
      state: 'busy',
      name: 'release-review-v193',
      source: 'Claude',
    })
    expect(states[0].task).toContain('校核 v1.9.3 两功能发版就绪')
    expect(states[0].task).toContain('4/5 agents done')
  })

  it('ignores completed Claude dynamic workflows', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'codepal-k28-status-'))
    const projectsDir = path.join(tempDir, '.claude', 'projects')
    const nowMs = Date.now()

    await writeWorkflow(projectsDir, {
      runId: 'wf_completed',
      workflowName: 'release-review-v193',
      status: 'completed',
      summary: '已经结束的 workflow',
      startTime: nowMs - 30000,
      durationMs: 10000,
      agentCount: 1,
      workflowProgress: [{ type: 'workflow_agent', status: 'done' }],
    })

    const states = await _private.readClaudeWorkflowStates({
      projectsDir,
      nowMs,
      maxAgeMs: 60000,
    })

    expect(states).toEqual([])
  })

  it('falls back to workflow script meta when name and summary are missing', () => {
    const state = _private.toClaudeWorkflowState({
      runId: 'wf_meta',
      status: 'queued',
      script: "const meta = { name: 'queued-workflow', description: '等待执行的动态工作流' }",
      startTime: 1780838272455,
    }, {
      filePath: '/tmp/wf_meta.json',
      mtimeMs: 1780838272455,
    })

    expect(state).toMatchObject({
      key: 'claude-workflow:wf_meta',
      state: 'busy',
      name: 'queued-workflow',
      task: '等待执行的动态工作流',
      source: 'Claude',
    })
  })
})
