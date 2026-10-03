/**
 * 收进 / 撤回 / 继续恢复
 *
 * 负责：
 * - 收进一份（定稿状态清单 C1–C4、C21）：分五步——备份原件、处理资产库（新放 / 留资产库的 / 换成这一份）、
 *   移走原件（全局的换成链接、项目里的移走）、在工具的全局位置建指向资产库的链接、在来源工具里打开；
 *   动第一个文件之前记录落盘，每一步记做之前 / 做之后；建不成链接按失败；任何一步失败倒着恢复
 * - 结果真实：还没动用户文件就失败 → not-run（不留记录）；失败且全部恢复 → rolled-back；恢复也失败 → partial
 * - 撤回（C6、C7、C23）：恢复到收进之前；动手前先核对，资产库位置变了、备份不完整、原位置被占、资产库正文被改、
 *   动过的配置被改都不撤；这次新放进资产库、别的工具后来也链到它时先要确认；资产库条目已删只放回原件
 * - 继续恢复（C20）：没做完的收进或撤回，一步步核对现场等于「做之后」才倒回去，对不上就停在这一步；
 *   撤回的范围（资产库已删只放回原件）和连带别的工具的计划在动手前落盘，继续恢复照同一份计划做
 * - 资产库只用核对过的备份放；移走原件前再核对一次，备份之后原件又被改就停下、原样放回（SOURCE_CHANGED）
 * - 撤回与继续恢复动手前先核对恢复要用的备份（原件、被换掉的旧资产库）和原项目还在不在
 * - 同名后一次没撤回时前一次不能撤（C9、C24）
 * 失败注入经 deps.collectHook(stepId, phase)；phase 为 apply-before / apply-unsaved / apply-after / revert-before / revert-after，
 * 以及两处中间点 remove-source apply-moved（原件挪走、还没核对）、library revert-between（新版挪进备份、旧版还没放回），
 * 抛带 crash:true 的错误模拟强退（不走恢复，记录停在进行中）。
 *
 * @module electron/modules/skills/collectService
 */

const fs = require('fs/promises')
const path = require('path')
const { readEntries, contentDigest, fullDigest, isRuntimePath } = require('./skillDigest')
const { backupDir } = require('./skillsDataDir')
const journal = require('./operationJournal')
const { slotPaths, isLibraryLink, assertSlotFree } = require('./slotGuard')

function codedError(code, extra = {}) {
  return Object.assign(new Error(code), { code, ...extra })
}

const notRun = (code, extra) => codedError(code, { outcome: 'not-run', ...extra })

async function exists(target) {
  try { await fs.lstat(target); return true } catch { return false }
}

async function realpathOrNull(target) {
  try { return await fs.realpath(target) } catch { return null }
}

/** 一个位置现在的样子：在不在、是不是链接（目标）、正文摘要、完整摘要 */
async function probe(target, deps) {
  let stat
  try { stat = await fs.lstat(target) } catch { return { exists: false } }
  const out = { exists: true, isLink: stat.isSymbolicLink() }
  if (out.isLink) out.target = await fs.readlink(target).catch(() => null)
  try {
    const entries = await readEntries(target, deps)
    out.digest = contentDigest(entries)
    out.full = fullDigest(entries)
  } catch {
    out.digest = null
    out.full = null
  }
  return out
}

async function hook(deps, stepId, phase) {
  if (deps.collectHook) await deps.collectHook(stepId, phase)
}

/** 名字下没做完的记录 */
async function partialOf(homeDir, name) {
  const ops = await journal.listOperations(homeDir)
  return ops.find((op) => op.name === name && journal.isPartial(homeDir, op)) || null
}

/**
 * 这个名字有没做完的收进或撤回时，其他写操作一律先停着
 * @throws {Error} OPERATION_PARTIAL
 */
async function assertNoPartial(homeDir, name) {
  if (await partialOf(homeDir, name)) throw notRun('OPERATION_PARTIAL')
}

// ---------- Claude / Codex 的开关 ----------

function claudeSettingsPath(homeDir) {
  return path.join(homeDir, '.claude', 'settings.json')
}

async function readClaudeOverride(homeDir, name) {
  const { readSettings, overrideState } = require('../../services/skillAdapters/claudeSkillAdapter')
  return overrideState(await readSettings(claudeSettingsPath(homeDir)), name)
}

async function writeClaudeOverride(homeDir, name, state) {
  const { setSkillOverride } = require('../../services/skillAdapters/claudeSkillAdapter')
  await setSkillOverride(claudeSettingsPath(homeDir), name, state)
  const after = await readClaudeOverride(homeDir, name)
  if (after !== state) throw codedError('NOT_EFFECTIVE')
}

async function readCodexEnabled(homeDir, slot, deps) {
  const { getCodexSkillApi, resolveForCodex } = require('../../services/codexSkillApi')
  const listed = await getCodexSkillApi(deps).list({ homeDir })
  const target = resolveForCodex(path.join(slot, 'SKILL.md'))
  const hit = listed.find((item) => item.path === target)
  return hit ? hit.enabled !== false : null
}

async function writeCodexEnabled(homeDir, name, slot, enabled, deps) {
  const { applyCodexCommand } = require('../../services/skillAdapters/codexSkillAdapter')
  await applyCodexCommand({ action: 'set-enabled', enabled, homeDir, skillName: name, source: { absolutePath: slot } }, deps)
}

// ---------- 每一步：做、核对、倒回去 ----------

function libraryPathOf(op) {
  return op.library.path
}

/**
 * 把一份内容放进资产库：先放进临时目录，完整了再改名。
 * 目录里的链接照原样放（不展开），和算摘要时的读法一致，也不会把目录外的内容复制进来
 * @param {string} from - 要放的那份的真实目录（核对过的备份，或链接来源指向的目录）
 * @param {string} target - 资产库里这个名字的位置
 */
async function materializeInto(from, target) {
  const staging = `${path.join(path.dirname(target), `.${path.basename(target)}`)}.codepal-${Date.now()}.tmp`
  await fs.rm(staging, { recursive: true, force: true })
  await fs.cp(from, staging, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false })
  await fs.rename(staging, target)
}

const stepOf = (op, id) => op.steps.find((step) => step.id === id)
const settled = (step) => !step || step.status === 'pending' || step.status === 'reverted'

async function fullDigestOf(dir, deps) {
  try { return fullDigest(await readEntries(dir, deps)) } catch { return null }
}

/**
 * 恢复要用的备份还完整吗（原件备份、「换成这一份」挪走的旧资产库）
 * @param {object} op
 * @param {object} ctx
 * @param {string[]|null} only - 这次只倒回哪几步（资产库已删时不用旧资产库）
 * @returns {Promise<string|null>} 不完整时为 'backup-incomplete'
 */
async function checkBackups(op, ctx, only) {
  const dir = backupDir(ctx.homeDir, op.operationId)
  const wanted = (id) => !only || only.includes(id)
  if (!op.from.isLink && wanted('remove-source') && !settled(stepOf(op, 'remove-source'))) {
    const recorded = stepOf(op, 'backup-source').after?.backupFull
    if (!recorded || (await fullDigestOf(path.join(dir, 'source'), ctx.deps)) !== recorded) return 'backup-incomplete'
  }
  const libraryStep = stepOf(op, 'library')
  if (op.libraryMode === 'replace' && wanted('library') && !settled(libraryStep)) {
    const saved = path.join(dir, 'library-before')
    if (await exists(saved)) {
      if (libraryStep.before?.full && (await fullDigestOf(saved, ctx.deps)) !== libraryStep.before.full) return 'backup-incomplete'
    } else if ((await probe(libraryPathOf(op), ctx.deps)).digest !== libraryStep.before?.digest) {
      // 旧版不在备份里、资产库里也不是旧版：放不回去
      return 'backup-incomplete'
    }
  }
  return null
}

/** 原件要放回项目里，而那个项目整个不在了：不重建项目（C7） */
async function projectGone(op, only) {
  if (only && !only.includes('remove-source')) return false
  if (op.from.scope !== 'project' || !op.from.projectPath) return false
  if (settled(stepOf(op, 'remove-source'))) return false
  return !(await exists(op.from.projectPath))
}

const STEPS = {
  'backup-source': {
    async apply(op, step, ctx) {
      const dir = backupDir(ctx.homeDir, op.operationId)
      await fs.mkdir(dir, { recursive: true, mode: 0o700 })
      if (op.from.isLink) {
        await fs.writeFile(path.join(dir, 'source-link.json'), JSON.stringify({ target: op.from.linkTarget }))
        step.after = { link: op.from.linkTarget }
        return
      }
      const saved = path.join(dir, 'source')
      await fs.cp(op.from.absolutePath, saved, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false })
      const [original, copy] = await Promise.all([readEntries(op.from.absolutePath, ctx.deps), readEntries(saved, ctx.deps)])
      if (fullDigest(original) !== fullDigest(copy)) throw codedError('BACKUP_VERIFY_FAILED')
      // 备份必须就是确认时的那一版：之后放资产库、移走前核对、撤回时核对都认这一个摘要
      if (fullDigest(copy) !== stepOf(op, 'remove-source').before?.full) throw codedError('SOURCE_CHANGED')
      step.after = { backupFull: fullDigest(copy) }
    },
    // 备份留着，不倒回
    async state() { return 'before' },
    async revert() {},
  },

  library: {
    async apply(op, step, ctx) {
      const target = libraryPathOf(op)
      if (op.libraryMode === 'keep') {
        step.after = { noop: true }
        return
      }
      if (op.libraryMode === 'create') {
        await fs.mkdir(op.library.repoPath, { recursive: true })
        // 第一次收进时资产库是这一步建的：建好后才记得下它的真实位置（撤回时核对资产库有没有换位置）
        op.library.repoReal = await realpathOrNull(op.library.repoPath)
      } else {
        const saved = path.join(backupDir(ctx.homeDir, op.operationId), 'library-before')
        await fs.rename(target, saved)
        if (step.before?.full && (await fullDigestOf(saved, ctx.deps)) !== step.before.full) throw codedError('BACKUP_VERIFY_FAILED')
      }
      // 项目或全局里的真文件夹：用第一步核对过的备份放，备份之后原件再怎么变都不会混进来
      const from = op.from.isLink ? op.from.real : path.join(backupDir(ctx.homeDir, op.operationId), 'source')
      await materializeInto(from, target)
      const now = await probe(target, ctx.deps)
      step.after = { exists: true, digest: now.digest }
    },
    async state(op, step, ctx) {
      if (op.libraryMode === 'keep') return 'before'
      const now = await probe(libraryPathOf(op), ctx.deps)
      // 做完之后的样子：记录里有就用记录的；改完还没来得及记就强退的，按这一份原件的正文摘要认
      const expected = step.after?.digest || op.from.digest
      if (now.exists && now.digest === expected) return 'after'
      const savedBefore = await exists(path.join(backupDir(ctx.homeDir, op.operationId), 'library-before'))
      if (op.libraryMode === 'create' && !now.exists) return 'before'
      if (op.libraryMode === 'replace') {
        // 旧版已挪进备份、新版还没放进来时强退：倒回去就是把旧版挪回来
        if (!now.exists && savedBefore) return 'after'
        if (now.exists && now.digest === step.before.digest && !savedBefore) return 'before'
      }
      return 'other'
    },
    async revert(op, step, ctx) {
      const target = libraryPathOf(op)
      const dir = backupDir(ctx.homeDir, op.operationId)
      if (op.libraryMode === 'keep') return
      // 收进后新增的运行数据（使用记录、缓存）不删，挪进备份
      const extras = []
      try {
        const entries = await readEntries(target, ctx.deps)
        for (const key of entries.keys()) if (isRuntimePath(key)) extras.push(key)
      } catch { /* 读不出就没有可挪的 */ }
      if (op.libraryMode === 'create') {
        for (const key of extras) {
          const destination = path.join(dir, 'runtime-after', key)
          await fs.mkdir(path.dirname(destination), { recursive: true })
          await fs.cp(path.join(target, key), destination, { force: true })
        }
        await fs.rm(target, { recursive: true, force: true })
        if (!op.library.repoExisted) {
          const left = await fs.readdir(op.library.repoPath).catch(() => null)
          if (left && left.length === 0) await fs.rmdir(op.library.repoPath).catch(() => {})
        }
        return
      }
      // 换掉的新版挪进备份（含收进后新增的使用记录），旧版放回；两次改名之间断了再来时，已经挪进备份的不删
      const after = path.join(dir, 'library-after')
      if (await exists(target)) {
        if (await exists(after)) await fs.rename(after, `${after}-${Date.now()}`)
        await fs.rename(target, after)
        await hook(ctx.deps, 'library', 'revert-between')
      }
      await fs.rename(path.join(dir, 'library-before'), target)
    },
    reason: 'library-changed',
  },

  'remove-source': {
    async apply(op, step, ctx) {
      if (op.from.isLink) {
        await fs.unlink(op.from.absolutePath)
        return
      }
      // 先整个改名挪走（一步完成，不会删到一半），核对挪走的和备份一字不差才删；
      // 备份之后原件又被改过：原样放回、这一步算没做，整个收进停下恢复（新写的内容不能丢）
      // source-removed 是还没核对的原件：中途断了，恢复时原样放回它（可能含备份后的改动），不拿旧备份顶替；
      // 核对过再改名成 source-removed-verified 才删，删到一半断了也不会被当成原件放回
      const dir = backupDir(ctx.homeDir, op.operationId)
      const moved = path.join(dir, 'source-removed')
      await fs.rename(op.from.absolutePath, moved)
      await hook(ctx.deps, 'remove-source', 'apply-moved')
      if ((await fullDigestOf(moved, ctx.deps)) !== stepOf(op, 'backup-source').after?.backupFull) {
        await fs.rename(moved, op.from.absolutePath)
        step.status = 'pending'
        await journal.saveOperation(ctx.homeDir, op)
        throw codedError('SOURCE_CHANGED')
      }
      const verified = path.join(dir, 'source-removed-verified')
      await fs.rename(moved, verified)
      await fs.rm(verified, { recursive: true, force: true })
    },
    async state(op, step, ctx) {
      const source = op.from.absolutePath
      const now = await probe(source, ctx.deps)
      if (!now.exists) return 'after'
      // 全局那份的位置后来被换成了这次建的链接：由建链接那一步负责
      if (op.from.isSlot && now.isLink && now.target === libraryPathOf(op)) return 'after'
      if (op.from.isLink) return now.isLink && now.target === op.from.linkTarget ? 'before' : 'other'
      return !now.isLink && now.full === step.before.full ? 'before' : 'other'
    },
    async revert(op, step, ctx) {
      const source = op.from.absolutePath
      if (op.from.isLink) {
        await fs.symlink(op.from.linkTarget, source, 'dir')
        return
      }
      const saved = path.join(backupDir(ctx.homeDir, op.operationId), 'source')
      if (await projectGone(op, null)) throw codedError('STEP_MISMATCH', { reason: 'project-gone' })
      await fs.mkdir(path.dirname(source), { recursive: true })
      const unverified = path.join(backupDir(ctx.homeDir, op.operationId), 'source-removed')
      if (await exists(unverified)) {
        await fs.rename(unverified, source)
        return
      }
      await fs.cp(saved, source, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false })
      const restored = await readEntries(source, ctx.deps)
      if (fullDigest(restored) !== step.before.full) throw codedError('RESTORE_VERIFY_FAILED')
    },
    reason: 'source-occupied',
  },

  link: {
    // 动手前记下这个位置原来是不是已经链着资产库（是的话这一步什么都不做，倒回时也不拿掉）
    async prepare(op, step) {
      step.before = { ...(step.before || {}), wasLibraryLink: await isLibraryLink(op.slot, libraryPathOf(op)) }
    },
    async apply(op, step, ctx) {
      const slot = op.slot
      const target = libraryPathOf(op)
      if (step.before?.wasLibraryLink) {
        step.after = { noop: true }
        return
      }
      if (await exists(slot)) throw codedError('SLOT_OCCUPIED')
      await fs.mkdir(path.dirname(slot), { recursive: true })
      try {
        await (ctx.deps.symlinkFn || fs.symlink)(target, slot, 'dir')
      } catch (error) {
        throw codedError('LINK_UNAVAILABLE', { cause: error })
      }
      if (!(await isLibraryLink(slot, target))) {
        await fs.rm(slot, { recursive: true, force: true }).catch(() => {})
        throw codedError('LINK_UNAVAILABLE')
      }
      step.after = { link: target }
    },
    async state(op, step) {
      if (step.after?.noop || step.before?.wasLibraryLink) return 'before'
      let stat
      try { stat = await fs.lstat(op.slot) } catch { return 'before' }
      if (!stat.isSymbolicLink()) return 'other'
      const target = await fs.readlink(op.slot).catch(() => null)
      return target === libraryPathOf(op) ? 'after' : 'other'
    },
    async revert(op) {
      await fs.unlink(op.slot)
    },
    reason: 'slot-changed',
  },

  enable: {
    // 原值在动手前落盘：写完配置、还没记进度就强退，也知道该改回什么
    async prepare(op, step, ctx) {
      if (op.toolId === 'claude-code') {
        const before = await readClaudeOverride(ctx.homeDir, op.name)
        if (before === 'invalid') throw codedError('INVALID_SETTINGS_JSON')
        step.before = { override: before }
        return
      }
      step.before = { enabled: await readCodexEnabled(ctx.homeDir, op.slot, ctx.deps) }
    },
    async apply(op, step, ctx) {
      if (op.toolId === 'claude-code') {
        await writeClaudeOverride(ctx.homeDir, op.name, 'enabled')
        step.after = { override: 'enabled' }
        return
      }
      await writeCodexEnabled(ctx.homeDir, op.name, op.slot, true, ctx.deps)
      step.after = { enabled: true }
    },
    async state(op, step, ctx) {
      if (!step.before) return 'before'
      if (op.toolId === 'claude-code') {
        const now = await readClaudeOverride(ctx.homeDir, op.name)
        if (now === 'enabled') return step.before.override === 'enabled' ? 'before' : 'after'
        if (now === step.before.override) return 'before'
        return 'other'
      }
      // Codex 原来没有这一项（链接是这次建的）：拿掉链接就等于回去了
      if (step.before?.enabled === null || step.before?.enabled === undefined) return 'before'
      const now = await readCodexEnabled(ctx.homeDir, op.slot, ctx.deps).catch(() => null)
      if (now === true) return step.before.enabled === true ? 'before' : 'after'
      if (now === step.before.enabled) return 'before'
      return 'other'
    },
    async revert(op, step, ctx) {
      if (op.toolId === 'claude-code') {
        const previous = step.before.override === 'enabled' ? 'enabled' : step.before.override
        await writeClaudeOverride(ctx.homeDir, op.name, previous)
        return
      }
      await writeCodexEnabled(ctx.homeDir, op.name, op.slot, step.before.enabled, ctx.deps)
    },
    reason: 'config-changed',
  },
}

const STEP_ORDER = ['backup-source', 'library', 'remove-source', 'link', 'enable']
// 资产库那份已经删了：撤回只把原件放回原处（连同可能留下的空链接）
const LIBRARY_DELETED_STEPS = ['link', 'remove-source']

/**
 * 倒回一步：现场等于做之前就当已经回去了；等于做之后才动手；都不是就停下
 * @throws {Error} code=STEP_MISMATCH，reason 为这一步对不上时的原因
 */
async function revertStep(op, step, ctx) {
  if (step.status === 'pending' || step.status === 'reverted') return
  const handler = STEPS[step.id]
  const state = await handler.state(op, step, ctx)
  if (state === 'before') {
    step.status = 'reverted'
    await journal.saveOperation(ctx.homeDir, op)
    return
  }
  if (state !== 'after') throw codedError('STEP_MISMATCH', { reason: handler.reason })
  await hook(ctx.deps, step.id, 'revert-before')
  await handler.revert(op, step, ctx)
  step.status = 'reverted'
  await journal.saveOperation(ctx.homeDir, op)
  await hook(ctx.deps, step.id, 'revert-after')
}

async function revertAll(op, ctx, only) {
  for (const id of [...STEP_ORDER].reverse()) {
    if (only && !only.includes(id)) continue
    const step = op.steps.find((item) => item.id === id)
    if (step) await revertStep(op, step, ctx)
  }
}

async function cleanupOperation(homeDir, operationId) {
  await fs.rm(backupDir(homeDir, operationId), { recursive: true, force: true }).catch(() => {})
  await journal.deleteOperation(homeDir, operationId).catch(() => {})
}

/**
 * 收进一份
 * @param {object} params
 * @param {string} params.skillName
 * @param {string} params.sourceId
 * @param {'library'|'source'} [params.keep] - 不一样时留哪份，必须给
 * @param {{sourceDigest?: string, libraryDigest?: string|null}} [params.expect] - 确认框打开时看到的版本
 * @param {object} ctx - { homeDir, repoPath, deps, findCopy(name, sourceId) }
 * @returns {Promise<{outcome: 'done', operationId: string}>}
 * @throws {Error} 带 outcome（not-run / rolled-back / partial）与 operationId
 */
async function collect(params, ctx) {
  const { homeDir, repoPath, deps } = ctx
  const name = params.skillName
  const copy = await ctx.findCopy(name, params.sourceId)
  if (!copy || copy.name !== name) throw notRun('SOURCE_NOT_FOUND')
  await assertNoPartial(homeDir, name)
  const libraryPath = path.join(repoPath, name)
  const libraryExists = await exists(path.join(libraryPath, 'SKILL.md'))
  const relation = libraryExists ? copy.relation : 'none'
  if (relation === 'diff' && !['library', 'source'].includes(params.keep)) throw notRun('KEEP_REQUIRED')
  if (params.expect) {
    const libraryDigest = libraryExists ? contentDigest(await readEntries(libraryPath, deps)) : null
    if (params.expect.sourceDigest !== undefined && params.expect.sourceDigest !== copy.digest) throw notRun('CONTENT_CHANGED')
    if (params.expect.libraryDigest !== undefined && (params.expect.libraryDigest ?? null) !== libraryDigest) throw notRun('CONTENT_CHANGED')
  }
  await assertSlotFree({ homeDir, toolId: copy.toolId, name, libraryPath, except: copy.absolutePath })
  if (copy.toolId === 'codex') await deps.beforeCodexWriteFn?.()

  const slot = slotPaths(homeDir, copy.toolId, name)[0]
  const op = {
    schemaVersion: 1,
    operationId: journal.newOperationId(),
    kind: 'collect',
    name,
    toolId: copy.toolId,
    relation,
    keep: params.keep || null,
    libraryMode: !libraryExists ? 'create' : relation === 'diff' && params.keep === 'source' ? 'replace' : 'keep',
    from: {
      scope: copy.scope,
      origin: copy.origin,
      projectName: copy.projectName,
      projectPath: copy.projectPath,
      absolutePath: copy.absolutePath,
      displayPath: copy.displayPath,
      isLink: copy.isLink,
      linkTarget: copy.linkTarget,
      real: copy.real,
      digest: copy.digest,
      isSlot: copy.absolutePath === slot,
    },
    library: { path: libraryPath, repoPath, repoReal: await realpathOrNull(repoPath), repoExisted: await exists(repoPath) },
    slot,
    at: new Date().toISOString(),
    state: 'running',
    steps: STEP_ORDER.map((id) => ({ id, status: 'pending', before: null, after: null })),
  }
  op.steps.find((step) => step.id === 'backup-source').before = { source: await probe(copy.absolutePath, deps) }
  const libraryNow = libraryExists ? await probe(libraryPath, deps) : null
  op.steps.find((step) => step.id === 'library').before = libraryNow ? { exists: true, digest: libraryNow.digest, full: libraryNow.full } : { exists: false }
  op.steps.find((step) => step.id === 'remove-source').before = { full: (await probe(copy.absolutePath, deps)).full }
  op.steps.find((step) => step.id === 'link').before = { slotExists: await exists(slot) }

  journal.markActive(homeDir, op.operationId)
  let current = null
  try {
    await journal.saveOperation(homeDir, op)
    for (const step of op.steps) {
      current = step
      await hook(deps, step.id, 'apply-before')
      if (STEPS[step.id].prepare) await STEPS[step.id].prepare(op, step, ctx)
      step.status = 'started'
      await journal.saveOperation(homeDir, op)
      await STEPS[step.id].apply(op, step, ctx)
      // 文件或配置已经改了、进度还没落盘的那一瞬间（测试在这里模拟强退）
      await hook(deps, step.id, 'apply-unsaved')
      step.status = 'done'
      await journal.saveOperation(homeDir, op)
      await hook(deps, step.id, 'apply-after')
    }
    op.state = 'done'
    await journal.saveOperation(homeDir, op)
    return { outcome: 'done', operationId: op.operationId }
  } catch (error) {
    if (error?.crash) throw Object.assign(error, { operationId: op.operationId })
    const touchedUser = op.steps.some((step) => step.id !== 'backup-source' && (step.status === 'done' || step.status === 'started'))
    if (!touchedUser) {
      await cleanupOperation(homeDir, op.operationId)
      throw codedError(error?.code || 'COLLECT_FAILED', { outcome: 'not-run', cause: error })
    }
    try {
      await revertAll(op, ctx)
    } catch (revertError) {
      if (revertError?.crash) throw Object.assign(revertError, { operationId: op.operationId })
      op.state = 'partial'
      op.partialKind = 'collect'
      op.reason = revertError?.reason || revertError?.code || 'RESTORE_FAILED'
      op.failedStep = current?.id || null
      await journal.saveOperation(homeDir, op)
      throw codedError(error?.code || 'COLLECT_FAILED', { outcome: 'partial', operationId: op.operationId, cause: error })
    }
    await cleanupOperation(homeDir, op.operationId)
    throw codedError(error?.code || 'COLLECT_FAILED', { outcome: 'rolled-back', cause: error })
  } finally {
    journal.markInactive(homeDir, op.operationId)
  }
}

/** 其他工具里指向这次新放进资产库那份的链接（撤回要连带它们时先确认） */
async function dependentTools(op, homeDir) {
  if (op.libraryMode !== 'create') return []
  const tools = []
  for (const toolId of ['claude-code', 'codex']) {
    if (toolId === op.toolId) continue
    for (const slot of slotPaths(homeDir, toolId, op.name)) {
      if (await isLibraryLink(slot, op.library.path)) {
        tools.push(toolId)
        break
      }
    }
  }
  return tools
}

/**
 * 撤回前的核对（也给快照显示收进记录的状态用）
 * @param {object} op
 * @param {object} ctx - { homeDir, repoPath, deps }
 * @param {object} [options] - checkConfig: 是否核对动过的配置（Codex 要调接口，快照里可以跳过）
 * @returns {Promise<{state: 'undoable'|'blocked'|'library-deleted', reason?: string, needsConfirm?: {toolIds: string[]}}>}
 */
async function assessUndo(op, ctx, { checkConfig = true } = {}) {
  const { homeDir, repoPath, deps } = ctx
  if (await realpathOrNull(repoPath) !== op.library.repoReal) return { state: 'blocked', reason: 'library-moved' }
  const libraryGone = !(await exists(path.join(op.library.path, 'SKILL.md')))
  const only = libraryGone ? LIBRARY_DELETED_STEPS : null
  const backupReason = await checkBackups(op, ctx, only)
  if (backupReason) return { state: 'blocked', reason: backupReason }
  if (await projectGone(op, only)) return { state: 'blocked', reason: 'project-gone' }
  const sourceStep = op.steps.find((step) => step.id === 'remove-source')
  if ((await STEPS['remove-source'].state(op, sourceStep, ctx)) !== 'after') return { state: 'blocked', reason: 'source-occupied' }
  if (libraryGone) return { state: 'library-deleted' }
  const linkStep = op.steps.find((step) => step.id === 'link')
  if ((await STEPS.link.state(op, linkStep, ctx)) === 'other') return { state: 'blocked', reason: 'slot-changed' }
  const libraryStep = op.steps.find((step) => step.id === 'library')
  if ((await STEPS.library.state(op, libraryStep, ctx)) === 'other') return { state: 'blocked', reason: 'library-changed' }
  if (checkConfig || op.toolId === 'claude-code') {
    const enableStep = op.steps.find((step) => step.id === 'enable')
    const enableState = await STEPS.enable.state(op, enableStep, ctx).catch(() => 'other')
    if (enableState === 'other') return { state: 'blocked', reason: 'config-changed' }
  }
  const toolIds = await dependentTools(op, homeDir)
  return toolIds.length > 0 ? { state: 'undoable', needsConfirm: { toolIds } } : { state: 'undoable' }
}

/** 同名还有更晚、没撤回的收进 */
async function laterOperation(op, homeDir) {
  const ops = await journal.listOperations(homeDir)
  return ops.find((item) => item.name === op.name && item.operationId !== op.operationId
    && String(item.at) > String(op.at) && item.state !== 'undone' && item.state !== 'rolled-back') || null
}

/**
 * 连带拿掉一个别的工具里的这一项：先清配置（Claude 回到继承；Codex 里关掉的那一项删掉），再拿掉指向这次新放进那份的链接。
 * 可重复执行：已经清掉的不再动，继续恢复时照同一份计划再做一遍不会出错
 */
async function removeDependent(op, toolId, ctx) {
  const slots = []
  for (const slot of slotPaths(ctx.homeDir, toolId, op.name)) {
    if (await isLibraryLink(slot, op.library.path)) slots.push(slot)
  }
  if (toolId === 'claude-code') {
    if ((await readClaudeOverride(ctx.homeDir, op.name)) !== 'inherit') await writeClaudeOverride(ctx.homeDir, op.name, 'inherit')
  } else {
    // Codex 的关是按 SKILL.md 记的一条配置：链接还在时把它删掉（写成开），链接拿掉后就再也找不到它了
    for (const slot of slots) {
      if ((await readCodexEnabled(ctx.homeDir, slot, ctx.deps)) === false) await writeCodexEnabled(ctx.homeDir, op.name, slot, true, ctx.deps)
    }
  }
  for (const slot of slots) await fs.unlink(slot)
}

/** 照落盘的撤回计划连带清掉别的工具，每个工具做完记一次 */
async function runDependents(op, ctx) {
  for (const dependent of op.undoPlan?.dependents || []) {
    if (dependent.status === 'done') continue
    await hook(ctx.deps, `dependent:${dependent.toolId}`, 'apply-before')
    await removeDependent(op, dependent.toolId, ctx)
    dependent.status = 'done'
    await journal.saveOperation(ctx.homeDir, op)
    await hook(ctx.deps, `dependent:${dependent.toolId}`, 'apply-after')
  }
}

/**
 * 撤回一次收进
 * @param {{operationId: string, confirmed?: boolean}} params
 * @param {object} ctx - { homeDir, repoPath, deps }
 * @returns {Promise<{outcome: 'done'}|{outcome: 'needs-confirm', needsConfirm: {toolIds: string[]}}>}
 * @throws {Error} UNDO_BLOCKED（带 reason，什么都没动）/ OPERATION_PARTIAL / 撤到一半失败（outcome=partial）
 */
async function undo(params, ctx) {
  const { homeDir } = ctx
  const op = await journal.readOperation(homeDir, params.operationId)
  if (op.state === 'undone') return { outcome: 'done' }
  if (journal.isPartial(homeDir, op)) throw notRun('OPERATION_PARTIAL')
  if (op.state !== 'done') throw notRun('OPERATION_NOT_UNDOABLE')
  if (await laterOperation(op, homeDir)) throw notRun('UNDO_BLOCKED', { reason: 'later-operation' })
  const assessment = await assessUndo(op, ctx)
  if (assessment.state === 'blocked') throw notRun('UNDO_BLOCKED', { reason: assessment.reason })
  if (assessment.needsConfirm && !params.confirmed) return { outcome: 'needs-confirm', needsConfirm: assessment.needsConfirm }
  if (op.toolId === 'codex' || assessment.needsConfirm?.toolIds.includes('codex')) await ctx.deps.beforeCodexWriteFn?.()

  journal.markActive(homeDir, op.operationId)
  op.state = 'undoing'
  op.undoStartedAt = new Date().toISOString()
  // 这次撤回做哪些先落盘：中途断了，继续恢复照同一份计划做，不会多做也不会漏做
  op.undoPlan = {
    only: assessment.state === 'library-deleted' ? LIBRARY_DELETED_STEPS : null,
    dependents: (assessment.needsConfirm?.toolIds || []).map((toolId) => ({ toolId, status: 'pending' })),
  }
  await journal.saveOperation(homeDir, op)
  try {
    await runDependents(op, ctx)
    await revertAll(op, ctx, op.undoPlan.only)
    op.state = 'undone'
    op.undoneAt = new Date().toISOString()
    await journal.saveOperation(homeDir, op)
    return { outcome: 'done' }
  } catch (error) {
    if (error?.crash) throw Object.assign(error, { operationId: op.operationId })
    op.state = 'partial'
    op.partialKind = 'undo'
    op.reason = error?.reason || error?.code || 'UNDO_FAILED'
    await journal.saveOperation(homeDir, op)
    throw codedError(error?.code || 'UNDO_FAILED', { outcome: 'partial', operationId: op.operationId, reason: error?.reason })
  } finally {
    journal.markInactive(homeDir, op.operationId)
  }
}

/**
 * 继续恢复没做完的收进或撤回：一步步核对现场，对得上才倒回去，对不上就停在这一步
 * @param {{operationId: string}} params
 * @param {object} ctx
 * @returns {Promise<{outcome: 'done'}>}
 * @throws {Error} RESUME_BLOCKED（带 reason，停在这一步）
 */
async function resume(params, ctx) {
  const { homeDir } = ctx
  const op = await journal.readOperation(homeDir, params.operationId)
  if (op.state === 'undone' || !journal.isPartial(homeDir, op)) return { outcome: 'done' }
  const only = op.undoPlan?.only || null
  // 动手前先核对：恢复要用的备份不完整、原项目不在了，就什么都不动
  const blocked = (await checkBackups(op, ctx, only)) || ((await projectGone(op, only)) ? 'project-gone' : null)
  if (blocked) {
    op.reason = blocked
    await journal.saveOperation(homeDir, op)
    throw codedError('RESUME_BLOCKED', { outcome: 'partial', operationId: op.operationId, reason: blocked })
  }
  if (op.toolId === 'codex' || (op.undoPlan?.dependents || []).some((item) => item.toolId === 'codex')) await ctx.deps.beforeCodexWriteFn?.()
  journal.markActive(homeDir, op.operationId)
  try {
    await runDependents(op, ctx)
    await revertAll(op, ctx, only)
    op.state = 'undone'
    op.undoneAt = new Date().toISOString()
    delete op.reason
    await journal.saveOperation(homeDir, op)
    return { outcome: 'done' }
  } catch (error) {
    if (error?.crash) throw Object.assign(error, { operationId: op.operationId })
    op.state = 'partial'
    op.partialKind = op.partialKind || (op.undoStartedAt ? 'undo' : 'collect')
    op.reason = error?.reason || error?.code || 'RESUME_FAILED'
    await journal.saveOperation(homeDir, op)
    throw codedError('RESUME_BLOCKED', { outcome: 'partial', operationId: op.operationId, reason: op.reason })
  } finally {
    journal.markInactive(homeDir, op.operationId)
  }
}

/**
 * 给快照用的收进记录：每条一个状态（可撤回 / 先撤上面那次 / 没做完 / 撤不了 / 资产库已删 / 已撤回）
 * @param {object} ctx - { homeDir, repoPath, deps }
 * @param {object} [options] - names: 只重新核对这几个名字；cached: 其余名字沿用的上次结果
 * @returns {Promise<object[]>} 时间从晚到早
 */
async function describeOperations(ctx, { names, cached } = {}) {
  const { homeDir } = ctx
  const ops = (await journal.listOperations(homeDir)).filter((op) => op.state !== 'rolled-back')
  const latestLive = new Map()
  for (const op of ops) {
    if (op.state === 'undone') continue
    const previous = latestLive.get(op.name)
    if (!previous || String(op.at) > String(previous.at)) latestLive.set(op.name, op)
  }
  const out = []
  for (const op of ops) {
    const base = {
      operationId: op.operationId,
      name: op.name,
      kind: op.kind,
      from: { toolId: op.toolId, scope: op.from.scope, projectName: op.from.projectName, displayPath: op.from.displayPath },
      at: op.at,
    }
    if (op.state === 'undone') {
      out.push({ ...base, state: 'undone', undoneAt: op.undoneAt })
      continue
    }
    if (journal.isPartial(homeDir, op)) {
      out.push({ ...base, state: 'partial', partialKind: op.partialKind || (op.undoStartedAt ? 'undo' : 'collect'), reason: op.reason || null })
      continue
    }
    if (op.state !== 'done') continue
    if (latestLive.get(op.name)?.operationId !== op.operationId) {
      out.push({ ...base, state: 'waiting' })
      continue
    }
    if (names && !names.includes(op.name) && cached?.has(op.operationId)) {
      out.push(cached.get(op.operationId))
      continue
    }
    const assessment = await assessUndo(op, ctx, { checkConfig: false }).catch(() => ({ state: 'blocked', reason: 'backup-incomplete' }))
    out.push({ ...base, state: assessment.state, ...(assessment.reason ? { reason: assessment.reason } : {}), ...(assessment.needsConfirm ? { needsConfirm: assessment.needsConfirm } : {}) })
  }
  return out.sort((left, right) => String(right.at).localeCompare(String(left.at)))
}

module.exports = { collect, undo, resume, describeOperations, assertNoPartial, partialOf }
