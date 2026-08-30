/**
 * Skill invocation ledger — v2 schema、原子写与迁移测试
 *
 * 覆盖冻结合同：精确 9 字段、坏行容错、幂等/并发 upsert、v1 备份重建、
 * fork 幽灵不继承、迁移失败保旧与写入中断不替换正式文件。
 *
 * @module 自动化测试/skill-usage/tests/backend/skillInvocationLedger.test
 */

import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'

const require = createRequire(import.meta.url)
const {
  defaultLedgerPath,
  readInvocationLedger,
  atomicWriteInvocationLedger,
  upsertInvocations,
  removeInvocationsById,
  ensureV2InvocationLedger,
  isV2Invocation,
} = require('../../../../electron/services/skillInvocationLedgerService')

function invocation(id, overrides = {}) {
  return {
    schemaVersion: 2,
    invocationId: id,
    skillName: 'goal-setter',
    tool: 'codex',
    triggerType: 'codex_dollar',
    triggeredAt: '2026-07-25T10:00:00.000Z',
    session: {
      id: '10000000-0000-4000-8000-000000000001',
      relativePath: '2026/07/25/rollout.jsonl',
    },
    sourceLine: 10,
    classifierVersion: 'skill-invocation-v2',
    ...overrides,
  }
}

describe('skillInvocationLedgerService', () => {
  let home
  let ledgerPath

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-invocation-ledger-'))
    ledgerPath = defaultLedgerPath(home)
  })

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true })
  })

  it('v2 record 必须精确为冻结 9 字段，读取时跳过坏行和额外字段', async () => {
    const good = invocation('inv-good')
    const extra = { ...invocation('inv-extra'), userGoalPreview: '不得落盘' }
    await fs.mkdir(path.dirname(ledgerPath), { recursive: true })
    await fs.writeFile(ledgerPath, [
      JSON.stringify(good),
      '{bad json',
      JSON.stringify(extra),
      '',
    ].join('\n'))

    const result = await readInvocationLedger({ homeDir: home })

    expect(isV2Invocation(good)).toBe(true)
    expect(isV2Invocation(extra)).toBe(false)
    expect(result.records).toEqual([good])
    expect(result.unparsableLineCount).toBe(1)
    expect(result.legacyLineCount).toBe(1)
    expect(Object.keys(result.records[0])).toEqual([
      'schemaVersion',
      'invocationId',
      'skillName',
      'tool',
      'triggerType',
      'triggeredAt',
      'session',
      'sourceLine',
      'classifierVersion',
    ])
  })

  it('重复与并发 upsert 幂等，两个并发新增都不会丢', async () => {
    const first = invocation('inv-1')
    const second = invocation('inv-2', { triggeredAt: '2026-07-25T11:00:00.000Z' })
    await Promise.all([
      upsertInvocations({ homeDir: home, records: [first] }),
      upsertInvocations({ homeDir: home, records: [second] }),
    ])
    await upsertInvocations({ homeDir: home, records: [first, second] })

    const result = await readInvocationLedger({ homeDir: home })
    expect(result.records.map((record) => record.invocationId)).toEqual(['inv-1', 'inv-2'])
  })

  it('v1 迁移先备份再从 transcript 重建，旧 fork 幽灵不进入 v2', async () => {
    const legacy = [
      { sampleId: 'legacy-real', skillRequested: 'goal-setter', timestamp: '2026-07-25T10:00:00.000Z' },
      { sampleId: 'legacy-fork-ghost', skillRequested: 'goal-setter', timestamp: '2026-07-25T10:00:01.000Z' },
    ]
    await fs.mkdir(path.dirname(ledgerPath), { recursive: true })
    const legacyContent = legacy.map((record) => JSON.stringify(record)).join('\n') + '\n'
    await fs.writeFile(ledgerPath, legacyContent)

    const rebuilt = invocation('rebuilt-real')
    const result = await ensureV2InvocationLedger({
      homeDir: home,
      nowFn: () => new Date('2026-07-26T12:00:00.000Z'),
      rebuildFn: async () => [rebuilt],
    })

    expect(result.migrated).toBe(true)
    expect(result.migrationFailed).toBe(false)
    expect(result.records).toEqual([rebuilt])
    expect(await fs.readFile(result.backupPath, 'utf-8')).toBe(legacyContent)
    expect((await readInvocationLedger({ homeDir: home })).records).toEqual([rebuilt])
  })

  it('迁移失败保持 v1 正式文件不变，并把旧记录交给 fallback', async () => {
    const legacyContent = `${JSON.stringify({
      sampleId: 'legacy',
      skillRequested: 'goal-setter',
      timestamp: '2026-07-25T10:00:00.000Z',
      isUsable: true,
      tool: 'codex',
    })}\n`
    await fs.mkdir(path.dirname(ledgerPath), { recursive: true })
    await fs.writeFile(ledgerPath, legacyContent)

    const result = await ensureV2InvocationLedger({
      homeDir: home,
      rebuildFn: async () => { throw new Error('rebuild failed') },
    })

    expect(result.migrationFailed).toBe(true)
    expect(result.legacyRecords).toHaveLength(1)
    expect(await fs.readFile(ledgerPath, 'utf-8')).toBe(legacyContent)
  })

  it('相同 v1 内容重复迁移失败时复用同一份备份', async () => {
    const legacyContent = `${JSON.stringify({ sampleId: 'legacy-same-content' })}\n`
    await fs.mkdir(path.dirname(ledgerPath), { recursive: true })
    await fs.writeFile(ledgerPath, legacyContent)
    const params = {
      homeDir: home,
      nowFn: () => new Date('2026-07-26T12:00:00.000Z'),
      rebuildFn: async () => { throw new Error('still failing') },
    }

    const first = await ensureV2InvocationLedger(params)
    const second = await ensureV2InvocationLedger(params)
    const backups = (await fs.readdir(path.dirname(ledgerPath)))
      .filter((name) => name.startsWith('skill-runs.v1.backup-'))

    expect(first.backupReused).toBe(false)
    expect(second.backupReused).toBe(true)
    expect(second.backupPath).toBe(first.backupPath)
    expect(backups).toHaveLength(1)
  })

  it('mixed ledger 重建时保留 source 已消失的有效 v2 记录', async () => {
    const retained = invocation('retained-without-source')
    const rebuilt = invocation('rebuilt-from-source', {
      triggeredAt: '2026-07-25T11:00:00.000Z',
    })
    await fs.mkdir(path.dirname(ledgerPath), { recursive: true })
    await fs.writeFile(ledgerPath, [
      JSON.stringify(retained),
      JSON.stringify({ sampleId: 'legacy' }),
      '',
    ].join('\n'))

    const result = await ensureV2InvocationLedger({
      homeDir: home,
      rebuildFn: async () => [rebuilt],
    })

    expect(result.records.map((record) => record.invocationId)).toEqual([
      'retained-without-source',
      'rebuilt-from-source',
    ])
    expect((await readInvocationLedger({ homeDir: home })).state).toBe('v2')
  })

  it('可按 invocationId 原子删除已确认的 fork replay 幽灵', async () => {
    await atomicWriteInvocationLedger({
      homeDir: home,
      records: [invocation('keep'), invocation('remove')],
    })

    const result = await removeInvocationsById({
      homeDir: home,
      invocationIds: ['remove', 'not-found'],
    })

    expect(result.removedCount).toBe(1)
    expect((await readInvocationLedger({ homeDir: home })).records.map((item) => item.invocationId)).toEqual(['keep'])
  })

  it('原子写在 rename 前失败时不替换正式 ledger', async () => {
    const original = invocation('original')
    await atomicWriteInvocationLedger({ homeDir: home, records: [original] })

    await expect(atomicWriteInvocationLedger({
      homeDir: home,
      records: [invocation('replacement')],
      beforeRename: async () => { throw new Error('interrupt') },
    })).rejects.toThrow('interrupt')

    expect((await readInvocationLedger({ homeDir: home })).records).toEqual([original])
    const names = await fs.readdir(path.dirname(ledgerPath))
    expect(names.filter((name) => name.includes('.tmp-'))).toEqual([])
  })
})
