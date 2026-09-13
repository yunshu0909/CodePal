/**
 * settings.json 写收口 — 行为测试
 *
 * 负责：
 * - writeClaudeSettingsFile：产物格式、备份落 backups/、入参校验、并发串行
 * - 四个原直写者迁移后端到端回归：permissionMode / modelConfig / usageStatus（时序）/ k28 hooks
 *
 * 手法：先把 HOME 指到临时目录，再 createRequire 加载被测模块
 * （各模块的 settings 路径常量在 require 时从 os.homedir() 求值）
 *
 * @module tests/safety/settingsWriteConsolidation.behavior.test
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)

let tempHome
let claudeDir
let settingsPath
let backupsDir
let writeClaudeSettingsFile
let mutateClaudeSettingsFile
let __testing
let setPermissionMode
let setModelConfig
let createClaudeUsageStatusService
let k28Private

const pathExists = async (p) => {
  try { await fs.access(p); return true } catch { return false }
}

async function readSettings() {
  return JSON.parse(await fs.readFile(settingsPath, 'utf-8'))
}

async function listBackups() {
  try { return await fs.readdir(backupsDir) } catch { return [] }
}

beforeAll(async () => {
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'v198-home-'))
  process.env.HOME = tempHome
  claudeDir = path.join(tempHome, '.claude')
  settingsPath = path.join(claudeDir, 'settings.json')
  backupsDir = path.join(claudeDir, 'backups')
  await fs.mkdir(claudeDir, { recursive: true })

  // HOME 就位后再加载：模块级路径常量在 require 时求值
  ;({ writeClaudeSettingsFile, mutateClaudeSettingsFile, __testing } = require('../../electron/services/claudeSettingsService'))
  ;({ setPermissionMode } = require('../../electron/handlers/permissionModeHandlers'))
  ;({ setModelConfig } = require('../../electron/handlers/modelConfigHandlers'))
  ;({ createClaudeUsageStatusService } = require('../../electron/services/claudeUsageStatusService'))
  k28Private = require('../../electron/services/k28StatusLightService')._private
})

afterAll(async () => {
  await fs.rm(tempHome, { recursive: true, force: true })
})

beforeEach(async () => {
  // 每个用例从干净的 settings 状态开始（backups 保留累计无碍，各用例按增量断言）
  await fs.rm(settingsPath, { force: true })
})

describe('V1.9.8 writeClaudeSettingsFile（唯一写入口）', () => {
  it('SW-1: 事务创建 → 2 空格格式化 JSON + 尾换行 + 私有权限 + 无 tmp 残留；二次 create 返冲突', async () => {
    const result = await mutateClaudeSettingsFile(
      () => ({ ok: true, next: { model: 'opus' }, create: true, updateExisting: false }),
    )
    expect(result.success).toBe(true)
    const raw = await fs.readFile(settingsPath, 'utf-8')
    expect(raw).toBe(`${JSON.stringify({ model: 'opus' }, null, 2)}\n`)
    // 私有权限：settings 0600（settings 可能含 API key）
    expect((await fs.stat(settingsPath)).mode & 0o777).toBe(0o600)
    // 临时文件不得残留：新临时文件形如 `<target>.codepal-<pid>-<ts>-<rand>.tmp`，
    // 因此既要查 `.tmp` 结尾（旧写法 `includes('.tmp.')` 漏掉这种命名），也要查 `.codepal-` 前缀标记
    const claudeFiles = await fs.readdir(claudeDir)
    expect(claudeFiles.filter((f) => f.endsWith('.tmp') || f.includes('.codepal-'))).toEqual([])

    // create-only：文件已存在时必须冲突，绝不覆盖
    const again = await mutateClaudeSettingsFile(
      () => ({ ok: true, next: { model: 'other' }, create: true, updateExisting: false }),
    )
    expect(again.success).toBe(false)
    expect(again.errorCode).toBe('SETTINGS_ALREADY_EXISTS')
    expect(JSON.parse(await fs.readFile(settingsPath, 'utf-8')).model).toBe('opus')
  })

  it('SW-2b: 备份后目录必须是 0700（即使它此前是宽松的）', async () => {
    // 覆盖范围（如实说明）：本用例能拦住「既不做 mkdir mode、也不 chmod」的实现，
    // 但**无法**区分「chmod 失败被吞」与「chmod 失败即中止」——普通临时目录上
    // chmod 不会失败，那条分支不可达。该分支目前靠代码审查保证，不靠本用例。
    await fs.mkdir(backupsDir, { recursive: true })
    await fs.chmod(backupsDir, 0o755)
    expect((await fs.stat(backupsDir)).mode & 0o777).toBe(0o755)

    await fs.writeFile(settingsPath, `${JSON.stringify({ a: 1 }, null, 2)}\n`, 'utf-8')
    const result = await mutateClaudeSettingsFile(
      ({ data }) => ({ ok: true, next: { ...data, b: 2 } }),
      { backupSuffix: 'tighten-test' },
    )
    expect(result.success).toBe(true)
    expect((await fs.stat(backupsDir)).mode & 0o777).toBe(0o700)
  })

  it('SW-2: 事务更新 → 先备份盘上已验证的真实内容，再替换', async () => {
    // 必须**先建立真实旧文件**：备份的是 broker 事务内读到的字节，
    // 不再接受调用方凭空传入的 previousContent。
    const original = `${JSON.stringify({ old: true, env: { KEEP: '1' } }, null, 2)}\n`
    await fs.writeFile(settingsPath, original, 'utf-8')

    const before = await listBackups()
    const result = await mutateClaudeSettingsFile(
      ({ data }) => ({ ok: true, next: { ...data, a: 1 } }),
      { backupSuffix: 'unit-test' },
    )
    expect(result.success).toBe(true)
    expect(result.backupPath).toBeTruthy()

    const fresh = (await listBackups()).filter((f) => !before.includes(f))
    expect(fresh).toHaveLength(1)
    expect(fresh[0].startsWith('settings-unit-test-')).toBe(true)
    // 备份目录必须私有（0700）：mkdir 的 mode 只影响新目录，已存在的必须显式收紧
    expect((await fs.stat(path.join(claudeDir, 'backups'))).mode & 0o777).toBe(0o700)
    // 备份文件也必须私有（0600）
    expect((await fs.stat(path.join(backupsDir, fresh[0]))).mode & 0o777).toBe(0o600)
    // 备份内容 === 替换前盘上的真实内容（逐字节）
    expect(await fs.readFile(path.join(backupsDir, fresh[0]), 'utf-8')).toBe(original)
    // 替换后：改了目标字段，邻居字段保留
    const after = JSON.parse(await fs.readFile(settingsPath, 'utf-8'))
    expect(after.a).toBe(1)
    expect(after.env.KEEP).toBe('1')
  })

  it('SW-3: 非普通对象入参 → INVALID_SETTINGS_DATA 且不落盘（新旧入口都覆盖）', async () => {
    for (const bad of [null, [], 'str', 42]) {
      const result = await writeClaudeSettingsFile(bad)
      expect(result.success).toBe(false)
      expect(result.errorCode).toBe('INVALID_SETTINGS_DATA')
    }
    // 事务入口的同类校验：mutator 返回非普通对象必须被拦下（旧入口的断言管不到新路径）
    await fs.writeFile(settingsPath, `${JSON.stringify({ keep: true }, null, 2)}\n`, 'utf-8')
    const beforeRaw = await fs.readFile(settingsPath, 'utf-8')
    for (const bad of [null, [], 'str', 42]) {
      const result = await mutateClaudeSettingsFile(({ data }) => ({ ok: true, next: bad, create: true }))
      expect(result.success).toBe(false)
      expect(result.errorCode).toBe('INVALID_SETTINGS_DATA')
    }
    expect(await fs.readFile(settingsPath, 'utf-8')).toBe(beforeRaw)
  })

  it('SW-12: CLAUDE_CONFIG_DIR 指向别处时拒绝写入（绝不悄悄写错位置）', async () => {
    const original = process.env.CLAUDE_CONFIG_DIR
    try {
      process.env.CLAUDE_CONFIG_DIR = path.join(tempHome, 'somewhere-else')
      const result = await mutateClaudeSettingsFile(({ data }) => ({ ok: true, next: { ...data, a: 1 }, create: true }))
      expect(result.success).toBe(false)
      expect(result.errorCode).toBe('SETTINGS_CUSTOM_ROOT_UNSUPPORTED')
      expect(fsSync.existsSync(settingsPath)).toBe(false)

      // 指向默认根（等价）时不应拒绝
      process.env.CLAUDE_CONFIG_DIR = claudeDir
      const ok = await mutateClaudeSettingsFile(({ data }) => ({ ok: true, next: { ...data, a: 1 }, create: true }))
      expect(ok.success).toBe(true)

      // 等价写法不得绕过守卫：`…/.claude/./settings.json` 解析后就是默认目标
      process.env.CLAUDE_CONFIG_DIR = path.join(tempHome, 'somewhere-else')
      const dotted = path.join(claudeDir, '.', 'settings.json')
      const viaDotted = await mutateClaudeSettingsFile(
        ({ data }) => ({ ok: true, next: { ...data, a: 2 }, create: true }),
        { filePath: dotted },
      )
      expect(viaDotted.success).toBe(false)
      expect(viaDotted.errorCode).toBe('SETTINGS_CUSTOM_ROOT_UNSUPPORTED')

      // 符号链接别名同样不得绕过：/alias → .claude，走别名应等价于走默认根
      const alias = path.join(tempHome, 'claude-alias')
      await fs.symlink(claudeDir, alias)
      const viaAlias = await mutateClaudeSettingsFile(
        ({ data }) => ({ ok: true, next: { ...data, a: 3 }, create: true }),
        { filePath: path.join(alias, 'settings.json') },
      )
      expect(viaAlias.success).toBe(false)
      expect(viaAlias.errorCode).toBe('SETTINGS_CUSTOM_ROOT_UNSUPPORTED')
    } finally {
      if (original === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = original
    }
  })

  it('SW-13: 托管设置覆盖目标字段时必须被报告（不谎报已生效）', async () => {
    const managedPath = path.join(tempHome, 'managed-settings.json')
    await fs.writeFile(managedPath, `${JSON.stringify({
      permissions: { defaultMode: 'plan' },
      model: 'claude-opus-5',
    }, null, 2)}\n`, 'utf-8')

    // 权限页：permissions.defaultMode 被托管 → 必须报告覆盖
    const perm = await setPermissionMode('acceptEdits', pathExists, { managedPaths: [managedPath] })
    expect(perm.success).toBe(true)
    expect(perm.managedOverride).toBe(true)
    expect(perm.managedNotice).toBeTruthy()

    // 模型页：model 被托管 → 报告
    const model = await setModelConfig('model', 'claude-sonnet-5', pathExists, { managedPaths: [managedPath] })
    expect(model.success).toBe(true)
    expect(model.managedOverride).toBe(true)

    // 反向防误报：effortLevel **未被**托管 → 不得报告覆盖
    // （把 managedOverride 改成恒真后，本断言必须失败）
    const effort = await setModelConfig('effortLevel', 'low', pathExists, { managedPaths: [managedPath] })
    expect(effort.success).toBe(true)
    expect(effort.managedOverride).toBe(false)
    expect(effort.managedNotice).toBe(null)

    // 反向防误报：没有托管文件时，permission 也不得报告覆盖
    const noManaged = await setPermissionMode('plan', pathExists, { managedPaths: [path.join(tempHome, 'none.json')] })
    expect(noManaged.success).toBe(true)
    expect(noManaged.managedOverride).toBe(false)

    // 没有托管文件时不得误报
    const plain = await mutateClaudeSettingsFile(
      ({ data }) => ({ ok: true, next: { ...data, x: 1 }, create: true }),
      { managedPaths: [path.join(tempHome, 'nonexistent-managed.json')] },
    )
    expect(plain.success).toBe(true)
    expect(plain.managed).toBe(null)
  })

  it('SW-14: 创建原语本身必须 no-replace——目标已存在时绝不覆盖（直接测原语，不经 broker 存在性检查）', async () => {
    // SW-10 只能证明"队列内恰好一次成功"：后四个请求在 broker 的存在性检查就被拦下了，
    // 因此它无法证明**文件系统发布本身**是 no-replace。这里直接打原语。
    const existing = `${JSON.stringify({ who: 'B', keep: true }, null, 2)}\n`
    await fs.writeFile(settingsPath, existing, 'utf-8')

    const result = await __testing.createSettingsFileExclusive(
      settingsPath,
      Buffer.from(`${JSON.stringify({ who: 'A' }, null, 2)}\n`, 'utf-8'),
    )

    expect(result.success).toBe(false)
    expect(result.committed).toBe(false)
    expect(result.errorCode).toBe('SETTINGS_ALREADY_EXISTS')
    // B 的内容必须逐字节保留（把 link 换成覆盖式 rename 后，本断言必须失败）
    expect(await fs.readFile(settingsPath, 'utf-8')).toBe(existing)
  })

  it('SW-15: 提交前复验必须比「文件身份」，不只是字节', async () => {
    // 构造：事务读到内容后，把目标以**相同字节**删除重建（inode 变化）。
    // 只比字节的实现会放行；比身份的实现必须拒绝。
    await fs.writeFile(settingsPath, `${JSON.stringify({ keep: 1 }, null, 2)}\n`, 'utf-8')
    const originalBytes = await fs.readFile(settingsPath)

    const result = await mutateClaudeSettingsFile(async ({ data }) => {
      // 模拟"事务读之后、提交之前"的外部变化：同字节重建 + 改 mode
      await fs.rm(settingsPath, { force: true })
      await fs.writeFile(settingsPath, originalBytes)
      await fs.chmod(settingsPath, 0o400)
      return { ok: true, next: { ...data, added: true } }
    })
    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('SETTINGS_CONFLICT')
    // 外部那份内容没有被覆盖
    expect((await fs.readFile(settingsPath)).equals(originalBytes)).toBe(true)
  })

  it('SW-11: 不存在的目标必须显式声明创建意图（静默复活防线）', async () => {
    // 目标不存在，mutator 却没说 create → 必须拒绝，不能顺手建出文件
    const refused = await mutateClaudeSettingsFile(({ data }) => ({ ok: true, next: { ...data, a: 1 } }))
    expect(refused.success).toBe(false)
    expect(refused.errorCode).toBe('SETTINGS_MISSING')
    expect(fsSync.existsSync(settingsPath)).toBe(false)

    // 显式声明后可创建
    const created = await mutateClaudeSettingsFile(({ data }) => ({ ok: true, next: { ...data, a: 1 }, create: true }))
    expect(created.success).toBe(true)
    expect(JSON.parse(await fs.readFile(settingsPath, 'utf-8')).a).toBe(1)
  })

  it('SW-9: 确定性 race（C.6 构造）——A 在进入 broker 前暂停，B 完整提交后 A 必须看到 B 的结果', async () => {
    // 构造要点（评审 C.6 原意）：
    //  1) A 先**预读**一次（拿到旧快照），据此决定要改什么
    //  2) A 在**进入 broker 队列之前**暂停（不是暂停在事务内，否则会占住队列）
    //  3) B 通过同一个 broker 完整提交（读 → 改 → 备份 → 提交）
    //  4) 放行 A，A 进入事务
    // 断言的核心：**A 的 mutator 拿到的是 B 提交之后的最新数据**
    //   —— 若写入口把调用方的预读快照交给 mutator（或 A 用自己那份旧快照），
    //   A 就会看不到 model，最终把它覆盖掉。
    await fs.writeFile(settingsPath, `${JSON.stringify({ env: { KEEP: '1' } }, null, 2)}\n`, 'utf-8')

    // A 的预读（这一步正是"调用方持有旧快照"的来源）
    const staleSnapshot = JSON.parse(await fs.readFile(settingsPath, 'utf-8'))
    expect(staleSnapshot.model).toBeUndefined()

    let releaseA
    const aGate = new Promise((resolve) => { releaseA = resolve })
    let dataSeenByA = null

    // A：先在队列外暂停，再进入 broker（不在事务内 await，避免自锁）
    const runA = (async () => {
      await aGate
      return mutateClaudeSettingsFile(({ data }) => {
        dataSeenByA = data
        const next = { ...data }
        next.permissions = { ...(next.permissions || {}), defaultMode: 'plan' }
        return { ok: true, next, create: true }
      })
    })()

    // B：完整提交
    const resultB = await mutateClaudeSettingsFile(({ data }) => ({ ok: true, next: { ...data, model: 'opus' }, create: true }))
    expect(resultB.success).toBe(true)

    releaseA()
    const resultA = await runA
    expect(resultA.success).toBe(true)

    // 关键断言：A 在事务内看到了 B 写入的字段（证明拿到的是最新状态，不是自己的旧快照）
    expect(dataSeenByA.model).toBe('opus')

    const finalData = await readSettings()
    expect(finalData.model).toBe('opus')
    expect(finalData.permissions.defaultMode).toBe('plan')
    expect(finalData.env.KEEP).toBe('1')
  })

  it('SW-10: create-only 并发 5 次恰好一次成功（no-replace 语义）', async () => {
    await fs.rm(settingsPath, { force: true })
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        mutateClaudeSettingsFile(({ data }) => ({
          ok: true,
          next: { ...data, [`k${i}`]: i },
          create: true,
          updateExisting: false,
        }))
      )
    )
    expect(results.filter((r) => r.success)).toHaveLength(1)
    expect(results.filter((r) => r.errorCode === 'SETTINGS_ALREADY_EXISTS')).toHaveLength(4)
  })

  it('SW-4: 并发 10 个 mutator 各改一个字段 → 十项全部保留（无相互覆盖）', async () => {
    // 原断言"10 次 blind write 都成功、最终文件合法"只能证明不写坏文件，
    // 证明不了不丢更新。改为十个不同字段并发修改，断言十项一个不少。
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        mutateClaudeSettingsFile(({ data }) => ({
          ok: true,
          next: { ...data, [`field${i}`]: 'x'.repeat(50) },
          create: true,
        }))
      )
    )
    expect(results.every((r) => r.success)).toBe(true)
    const finalData = await readSettings()
    for (let i = 0; i < 10; i += 1) {
      expect(finalData[`field${i}`]).toBe('x'.repeat(50))
    }
  })
})

describe('V1.9.8 直写者迁移回归', () => {
  it('SW-5: setPermissionMode 写对字段、返回结构不变、备份进 backups/', async () => {
    await fs.writeFile(settingsPath, `${JSON.stringify({ env: { KEEP: '1' } }, null, 2)}\n`, 'utf-8')
    const result = await setPermissionMode('plan', pathExists)
    expect(result.success).toBe(true)
    expect(result.backupPath).toContain(path.join('.claude', 'backups'))
    const data = await readSettings()
    expect(data.permissions.defaultMode).toBe('plan')
    expect(data.env.KEEP).toBe('1')
  })

  it('SW-6: setModelConfig 写对字段、备份进 backups/', async () => {
    await fs.writeFile(settingsPath, `${JSON.stringify({ permissions: { defaultMode: 'plan' } }, null, 2)}\n`, 'utf-8')
    const result = await setModelConfig('model', 'opus', pathExists)
    expect(result.success).toBe(true)
    expect(result.backupPath).toContain(path.join('.claude', 'backups'))
    const data = await readSettings()
    expect(data.model).toBe('opus')
    expect(data.permissions.defaultMode).toBe('plan')
  })

  it('SW-7: usageStatus 安装时序——settings 写发生在状态栏脚本落盘之后', async () => {
    const scriptPath = path.join(claudeDir, 'codepal-usage-statusline.sh')
    let scriptExistedAtSettingsWrite = null
    const fakeSettingsService = {
      readClaudeSettingsFile: async () => ({ success: true, exists: false, content: '', data: {}, errorCode: null, error: null, backupPath: null }),
      // 事务接口：在"提交"这一刻观察脚本是否已落盘
      mutateClaudeSettingsFile: async (mutator) => {
        const outcome = await mutator({
          state: { kind: 'missing', exists: false, errorCode: null, error: null, raw: '' },
          data: {},
          raw: '',
          exists: false,
          kind: 'missing',
        })
        if (!outcome || outcome.ok !== true) {
          return { success: false, backupPath: null, errorCode: (outcome && outcome.errorCode) || 'MUTATION_REFUSED', error: null, exists: false }
        }
        scriptExistedAtSettingsWrite = fsSync.existsSync(scriptPath)
        expect(outcome.next.statusLine).toBeTruthy()
        return { success: true, backupPath: null, errorCode: null, error: null, exists: true }
      },
    }
    const service = createClaudeUsageStatusService({ pathExists, claudeSettingsService: fakeSettingsService })
    // 首次安装属于用户显式接入：只有 intent='explicit' 才允许在 settings.json 不存在时创建
    await service.ensureUsageStatusInstalled({ force: true, intent: 'explicit' })
    expect(scriptExistedAtSettingsWrite).toBe(true)
  })

  it('SW-8: k28 installClaudeHooks 写入 6 组 hooks，备份归位 backups/ 不再散落 .claude 根', async () => {
    await fs.writeFile(settingsPath, `${JSON.stringify({ env: { KEEP: '1' } }, null, 2)}\n`, 'utf-8')
    const before = await listBackups()
    await k28Private.installClaudeHooks()
    const data = await readSettings()
    for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd']) {
      expect(Array.isArray(data.hooks[event]), `缺 ${event} hook`).toBe(true)
    }
    expect(data.env.KEEP).toBe('1')
    const after = await listBackups()
    expect(after.filter((f) => f.startsWith('settings-k28-hooks-')).length)
      .toBeGreaterThan(before.filter((f) => f.startsWith('settings-k28-hooks-')).length)
    // 旧行为的散落备份（~/.claude/settings-k28-<ts>.json）不再产生
    const claudeFiles = await fs.readdir(claudeDir)
    expect(claudeFiles.some((f) => /^settings-k28-\d+\.json$/.test(f))).toBe(false)
  })
})
