/**
 * Transcript locator — root、relative path、fallback 与 availability 测试
 *
 * @module 自动化测试/skill-usage/tests/backend/transcriptLocator.test
 */

import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const require = createRequire(import.meta.url)
const {
  getTranscriptRoot,
  toTranscriptRelativePath,
  resolveRelativeTranscriptPath,
  getInvocationSourceAvailability,
  findUniqueTranscriptBySessionId,
} = require('../../../../electron/services/transcriptLocatorService')

describe('transcriptLocatorService', () => {
  let home

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'transcript-locator-'))
  })

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true })
  })

  it('支持默认与自定义 CLAUDE_CONFIG_DIR / CODEX_HOME', () => {
    expect(getTranscriptRoot('claude', { homeDir: home, env: {} }))
      .toBe(path.join(home, '.claude', 'projects'))
    expect(getTranscriptRoot('codex', { homeDir: home, env: {} }))
      .toBe(path.join(home, '.codex', 'sessions'))
    expect(getTranscriptRoot('claude', {
      homeDir: home,
      env: { CLAUDE_CONFIG_DIR: path.join(home, 'claude-custom') },
    })).toBe(path.join(home, 'claude-custom', 'projects'))
    expect(getTranscriptRoot('codex', {
      homeDir: home,
      env: { CODEX_HOME: path.join(home, 'codex-custom') },
    })).toBe(path.join(home, 'codex-custom', 'sessions'))
  })

  it('relative path 使用 POSIX 分隔并阻止逃逸 root', () => {
    const root = path.join(home, '.codex', 'sessions')
    const file = path.join(root, '2026', '07', 'rollout.jsonl')
    expect(toTranscriptRelativePath(root, file)).toBe('2026/07/rollout.jsonl')
    expect(resolveRelativeTranscriptPath(root, '2026/07/rollout.jsonl')).toBe(file)
    expect(resolveRelativeTranscriptPath(root, '../../secret')).toBeNull()
  })

  it('详情 availability 只调用一次 access，不做目录扫描或内容读取', async () => {
    const accessFn = vi.fn().mockResolvedValue(undefined)
    const record = {
      tool: 'codex',
      session: { relativePath: '2026/07/rollout.jsonl' },
    }
    const status = await getInvocationSourceAvailability(record, {
      homeDir: home,
      env: {},
      accessFn,
    })
    expect(status).toBe('available')
    expect(accessFn).toHaveBeenCalledTimes(1)
    expect(accessFn).toHaveBeenCalledWith(path.join(home, '.codex', 'sessions', '2026', '07', 'rollout.jsonl'))
  })

  it('源删除为 missing；session ID fallback 只接受唯一文件', async () => {
    const id = '70000000-0000-4000-8000-000000000001'
    const paths = [
      path.join(home, '2026', `rollout-${id}.jsonl`),
      path.join(home, '2026', 'other.jsonl'),
    ]
    expect(findUniqueTranscriptBySessionId(id, paths)).toBe(paths[0])
    expect(findUniqueTranscriptBySessionId(id, [...paths, path.join(home, 'copy', `${id}.jsonl`)]))
      .toBeNull()

    const status = await getInvocationSourceAvailability({
      tool: 'claude',
      session: { relativePath: 'missing.jsonl' },
    }, { homeDir: home, env: {} })
    expect(status).toBe('missing')
  })
})
