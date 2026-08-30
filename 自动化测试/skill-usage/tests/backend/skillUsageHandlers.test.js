/**
 * Skill usage IPC — aggregate 扫描、detail 零 transcript 读取测试
 *
 * @module 自动化测试/skill-usage/tests/backend/skillUsageHandlers.test
 */

import path from 'node:path'
import os from 'node:os'
import fsPromises from 'node:fs/promises'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { registerSkillUsageHandlers } = require('../../../../electron/handlers/registerSkillUsageHandlers')

async function writeJsonl(file, records) {
  await fsPromises.mkdir(path.dirname(file), { recursive: true })
  await fsPromises.writeFile(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n')
}

describe('registerSkillUsageHandlers', () => {
  let home
  let handlers
  let now

  beforeEach(async () => {
    home = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'skill-usage-ipc-'))
    handlers = new Map()
    now = new Date('2026-07-26T12:00:00.000Z')
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await fsPromises.rm(home, { recursive: true, force: true })
  })

  it('detail IPC 只读 ledger + access，不创建 transcript read stream', async () => {
    const file = path.join(home, '.claude', 'projects', 'proj', 'ipc-session.jsonl')
    await writeJsonl(file, [{
      type: 'user',
      timestamp: '2026-07-25T12:00:00.000Z',
      sessionId: 'ipc-session',
      message: { content: '<command-name>/goal-setter</command-name> 收敛' },
    }])
    registerSkillUsageHandlers({
      ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
      pathExists: async () => true,
      homeDir: home,
      nowFn: () => now,
    })

    const aggregate = await handlers.get('aggregate-skill-usage')(null, {
      windowDays: 30,
      skillNames: ['goal-setter'],
    })
    expect(aggregate.success).toBe(true)
    expect(aggregate.data.totals.total).toBe(1)

    const streamSpy = vi.spyOn(fs, 'createReadStream')
    const detail = await handlers.get('list-skill-run-samples')(null, {
      windowDays: 30,
      skillName: 'goal-setter',
    })

    expect(detail.success).toBe(true)
    expect(detail.data.records).toHaveLength(1)
    expect(streamSpy).not.toHaveBeenCalled()
    expect(JSON.stringify(aggregate.data)).not.toContain(home)
    expect(JSON.stringify(detail.data)).not.toContain(home)
  })

  it('legacy ledger 的 detail IPC 保留 migrationRequired 状态', async () => {
    const ledger = path.join(home, 'Documents', 'SkillManager', '.codepal', 'skill-runs.jsonl')
    await writeJsonl(ledger, [{
      sampleId: 'legacy',
      skillRequested: 'goal-setter',
      timestamp: '2026-07-25T12:00:00.000Z',
      isUsable: true,
      tool: 'codex',
    }])
    registerSkillUsageHandlers({
      ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
      pathExists: async () => true,
      homeDir: home,
      nowFn: () => now,
    })

    const detail = await handlers.get('list-skill-run-samples')(null, {
      windowDays: 30,
      skillName: 'goal-setter',
    })

    expect(detail).toMatchObject({
      success: true,
      data: { records: [], migrationRequired: true },
    })
    expect(JSON.stringify(detail.data)).not.toContain(home)
  })
})
