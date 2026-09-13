/**
 * V1.9.11 满载率趋势下线回归测试
 *
 * @module 自动化测试/V1.9.11/tests/usageTrendRemoval.test
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import ClaudeUsageStatusPage from '../../../src/pages/ClaudeUsageStatusPage'

const readSource = (relativePath) => fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')
const require = createRequire(import.meta.url)
const claudeUsageService = require('../../../electron/services/claudeUsageStatusService')

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('V1.9.11 满载率趋势下线', () => {
  it('RM-TC-01: UI、IPC 与服务层不再保留趋势取数入口', () => {
    const page = readSource('src/pages/ClaudeUsageStatusPage.jsx')
    const claudeHook = readSource('src/pages/usage/useClaudeUsageStatus.js')
    const codexHook = readSource('src/pages/usage/useCodexUsageStatus.js')
    const preload = readSource('electron/preload.js')
    const claudeHandlers = readSource('electron/handlers/registerClaudeUsageStatusHandlers.js')
    const codexHandlers = readSource('electron/handlers/registerCodexUsageStatusHandlers.js')
    const codexService = readSource('electron/services/codexUsageStatusService.js')

    expect(page).not.toContain('DualTrendCard')
    expect(page).not.toContain('满载率趋势')
    expect(claudeHook).not.toContain('getClaudeUsageHistory')
    expect(codexHook).not.toContain('getCodexUsageTrend')
    expect(preload).not.toContain('getClaudeUsageHistory')
    expect(preload).not.toContain('getCodexUsageTrend')
    expect(claudeHandlers).not.toContain('claude-usage-status:get-history')
    expect(codexHandlers).not.toContain('codex-usage-status:get-trend')
    expect(codexService).not.toContain('getCodexUsageTrend')
    expect(codexService).not.toContain('TREND_LOOKBACK_DAYS')
  })

  it('RM-TC-02: statusLine 升级后停止写历史，但继续生成当前额度脚本', () => {
    const service = readSource('electron/services/claudeUsageStatusService.js')
    const template = readSource('electron/services/claudeUsageStatusScript.tpl')

    expect(service).toContain('const SCRIPT_VERSION = 9')
    expect(service).not.toContain('STATUS_HISTORY_PATH')
    expect(service).not.toContain('getUsageHistory')
    expect(template).not.toContain('__HISTORY_PATH__')
    expect(template).not.toContain('update_history')
    expect(template).toContain('write_snapshot(snapshot)')
  })

  it('RM-TC-02b: 真实运行当前版本脚本只更新快照，不修改已有 history 文件', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codepal-v1911-statusline-'))
    try {
      const configPath = path.join(tempDir, 'config.json')
      const snapshotPath = path.join(tempDir, 'snapshot.json')
      const historyPath = path.join(tempDir, 'codepal-usage-history.json')
      const scriptPath = path.join(tempDir, 'statusline.sh')
      const originalHistory = '{"version":1,"completedCycles":[{"peakPercentage":88}]}\n'
      fs.writeFileSync(configPath, '{"displayMode":"always","fiveHourThreshold":70,"sevenDayThreshold":70}\n')
      fs.writeFileSync(historyPath, originalHistory)
      const historyMtimeBefore = fs.statSync(historyPath).mtimeMs

      const script = claudeUsageService.buildStatusScriptContent()
        .split(claudeUsageService.STATUS_CONFIG_PATH).join(configPath)
        .split(claudeUsageService.STATUS_SNAPSHOT_PATH).join(snapshotPath)
      fs.writeFileSync(scriptPath, script, { mode: 0o700 })

      const now = Math.floor(Date.now() / 1000)
      const payload = JSON.stringify({
        model: { display_name: 'Claude Code', id: 'claude-test' },
        rate_limits: {
          five_hour: { used_percentage: 21, resets_at: now + 3600 },
          seven_day: { used_percentage: 34, resets_at: now + 86400 },
        },
      })
      const result = spawnSync('bash', [scriptPath], { input: payload, encoding: 'utf8' })

      expect(result.status, result.stderr).toBe(0)
      expect(JSON.parse(fs.readFileSync(snapshotPath, 'utf8')).sevenDayUsedPercentage).toBe(34)
      expect(fs.readFileSync(historyPath, 'utf8')).toBe(originalHistory)
      expect(fs.statSync(historyPath).mtimeMs).toBe(historyMtimeBefore)
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('RM-TC-03: 页面只请求当前额度，Claude/Codex 双栏继续展示', async () => {
    const now = Math.floor(Date.now() / 1000)
    const getClaudeUsageHistory = vi.fn()
    const getCodexUsageTrend = vi.fn()
    window.electronAPI = {
      getClaudeUsageStatusState: vi.fn().mockResolvedValue({
        success: true,
        integrationState: 'ready',
        claudeInstalled: true,
        usesManagedStatusLine: true,
        scriptOutdated: false,
        config: { displayMode: 'always', fiveHourThreshold: 70, sevenDayThreshold: 70 },
        snapshot: {
          hasRateLimits: true,
          fiveHourUsedPercentage: 21,
          sevenDayUsedPercentage: 34,
          resetsAt: now + 3600,
          sevenDayResetsAt: now + 86400,
          updatedAt: now,
        },
      }),
      getCodexUsageStatusState: vi.fn().mockResolvedValue({
        success: true,
        integrationState: 'ready',
        snapshot: {
          hasRateLimits: true,
          fiveHourUsedPercentage: 13,
          sevenDayUsedPercentage: 55,
          resetsAt: now + 1800,
          sevenDayResetsAt: now + 7200,
          updatedAt: now,
        },
      }),
      getClaudeUsageHistory,
      getCodexUsageTrend,
    }

    render(<ClaudeUsageStatusPage />)

    await waitFor(() => {
      expect(window.electronAPI.getClaudeUsageStatusState).toHaveBeenCalledTimes(1)
      expect(window.electronAPI.getCodexUsageStatusState).toHaveBeenCalledTimes(1)
    })
    expect(screen.getAllByText('5 小时额度')).toHaveLength(2)
    expect(screen.getAllByText('7 天额度')).toHaveLength(2)
    expect(screen.queryByText('满载率趋势')).toBeNull()
    expect(getClaudeUsageHistory).not.toHaveBeenCalled()
    expect(getCodexUsageTrend).not.toHaveBeenCalled()
  })
})
