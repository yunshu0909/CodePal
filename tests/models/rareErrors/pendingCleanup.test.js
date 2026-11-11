/** @vitest-environment node
 * v2.1.29 TC-002（#78）：老用户升级后，上一个版本留下「保存中」记录；这次保存先按记录重新生成成功、但删不掉记录时：
 * - 保存照常成功，不报「也没能退回原来的设置」；设置和审核配置一致；记录留着，下一次写入照常处理掉；
 * - 目录连这次的新记录也写不进去：保存失败、报写不进去这一类（不是没能退回），这次的改动一点没写（和处理完旧记录之后的字节一样）；
 * - 旧记录是「要退回」且还原失败、或按记录重新生成失败：不开始这次保存，旧记录原样留着；
 * - 继续保存后这次的第二步和退回又都失败、「要退回」记录写得进去：记录改成「要退回」、存这次保存前的字节，重启后按它还原。
 * （连「要退回」都写不进时照 v2.1.17 既有规则以磁盘上的设置为准，由 TC-006 守着。）
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { makeSandbox, KEY } from '../helpers'

const require = createRequire(import.meta.url)
const { createReviewCenter } = await import('../../../electron/modules/models/reviewCenter.js')
const store = require('../../../electron/modules/models/store.js')

const ROLLBACK_MESSAGE = '保存失败，也没能退回原来的设置；检查配置目录的权限后重启 CodePal'
const ID = 'deepseek:deepseek-flash'
let sb, center
const file = (name) => path.join(sb.models, name)
const bytes = (name) => (fs.existsSync(file(name)) ? fs.readFileSync(file(name)) : null)
const read = (name) => JSON.parse(fs.readFileSync(file(name), 'utf8'))
const configIds = () => read('review-config.json').models.map((m) => m.id)
const open = () => createReviewCenter({ homeDir: sb.home, env: sb.env, locateClaude: () => null, locateCodex: () => null })
function caught(fn) {
  try {
    fn()
  } catch (error) {
    return error
  }
  return null
}

/** 上一个版本留下的恢复记录（直接写文件，就像升级前那一版中途停下） */
function leftover(state, before) {
  fs.writeFileSync(
    file('.save-journal.json'),
    JSON.stringify({ schemaVersion: 1, state, file: 'hub.json', before: before.toString('base64'), startedAt: '2026-10-01T00:00:00.000Z' }) + '\n',
  )
}

/** 删恢复记录一律失败 */
function journalUndeletable() {
  const journalPath = file('.save-journal.json')
  const realRm = fs.rmSync
  vi.spyOn(fs, 'rmSync').mockImplementation((target, ...rest) => {
    if (target === journalPath) throw Object.assign(new Error('test journal cleanup denied'), { code: 'EPERM' })
    return realRm(target, ...rest)
  })
}

/** 替换到这些目标的写入失败；hubFailFrom 表示第几次替换设置文件起失败（1 = 第一次就失败） */
function renameFails({ journal = null, config = null, hubFailFrom = null } = {}) {
  const realRename = fs.renameSync
  let hubWrites = 0
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (journal && to === file('.save-journal.json')) throw Object.assign(new Error('test journal write failed'), { code: journal })
    if (config && to === file('review-config.json')) throw Object.assign(new Error('test config write failed'), { code: config })
    if (hubFailFrom && to === file('hub.json')) {
      hubWrites += 1
      if (hubWrites >= hubFailFrom) throw Object.assign(new Error('test settings write failed'), { code: 'EACCES' })
    }
    return realRename(from, to)
  })
}

beforeEach(() => {
  sb = makeSandbox()
  for (const [k, v] of Object.entries(sb.env)) vi.stubEnv(k, v)
  store.setKey('deepseek', KEY)
  store.writeStatus('deepseek', 'deepseek-flash', { ok: true, source: 'test' })
  center = open()
  center.reconcile()
  center.list()
  expect(configIds()).toEqual([ID])
})
afterEach(() => {
  center?.stop()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  sb.cleanup()
})

it('TC-002 老用户升级后：旧「保存中」记录处理好了只是删不掉，这次保存照常成功，设置和审核配置一致；下一次写入处理掉记录', () => {
  leftover('saving', bytes('hub.json'))
  journalUndeletable()
  const error = caught(() => center.setEnabled({ id: ID, enabled: false }))
  expect(error?.message ?? null, 'PENDING_CLEANUP_BLOCKS 旧记录删不掉就拒绝了这次保存').toBeNull()
  expect(read('hub.json').reviewEnabled[ID]).toBe(false)
  expect(configIds()).toEqual([])
  expect(fs.existsSync(file('.save-journal.json')), '删不掉的记录留着').toBe(true)
  vi.restoreAllMocks()
  expect(center.setEnabled({ id: ID, enabled: true })).toEqual({ id: ID, enabled: true })
  expect(fs.existsSync(file('.save-journal.json'))).toBe(false)
  expect(configIds()).toEqual([ID])
})

it('TC-002 老用户升级后：旧记录删不掉、这次的新记录也写不进去：保存失败、不报没能退回，这次的改动一点没写', () => {
  leftover('saving', bytes('hub.json'))
  const settings = bytes('hub.json')
  const config = bytes('review-config.json')
  journalUndeletable()
  renameFails({ journal: 'ENOSPC' })
  const error = caught(() => center.setEnabled({ id: ID, enabled: false }))
  expect(error, 'PENDING_CLEANUP_BLOCKS 应该报这次写不进去').not.toBeNull()
  expect(error.code, 'PENDING_CLEANUP_BLOCKS 不是没能退回').not.toBe('ROLLBACK_FAILED')
  expect(error.message).not.toBe(ROLLBACK_MESSAGE)
  expect(error.code).toBe('ENOSPC')
  expect(bytes('hub.json').equals(settings), '设置是处理完旧记录之后的字节').toBe(true)
  expect(bytes('review-config.json').equals(config), '审核配置是处理完旧记录之后的字节').toBe(true)
})

it('TC-002 旧记录是「要退回」且还原失败：不开始这次保存、旧记录原样留着', () => {
  const settings = bytes('hub.json')
  leftover('rollback', Buffer.from('{"older": true}\n'))
  const record = bytes('.save-journal.json')
  renameFails({ hubFailFrom: 1 })
  const error = caught(() => center.setEnabled({ id: ID, enabled: false }))
  expect(error?.code).toBe('ROLLBACK_FAILED')
  expect(bytes('.save-journal.json').equals(record)).toBe(true)
  expect(bytes('hub.json').equals(settings)).toBe(true)
})

it('TC-002 旧「保存中」记录按设置重新生成失败：不开始这次保存、旧记录原样留着', () => {
  // 先让磁盘上的设置和审核配置不一致（关掉模型但配置还是旧的），记录要求按设置重新生成
  const before = bytes('hub.json')
  const prefs = read('hub.json')
  prefs.reviewEnabled[ID] = false
  fs.writeFileSync(file('hub.json'), JSON.stringify(prefs))
  leftover('saving', before)
  const record = bytes('.save-journal.json')
  const settings = bytes('hub.json')
  renameFails({ config: 'EACCES' })
  const error = caught(() => center.setEnabled({ id: ID, enabled: true }))
  expect(error?.code).toBe('ROLLBACK_FAILED')
  expect(bytes('.save-journal.json').equals(record)).toBe(true)
  expect(bytes('hub.json').equals(settings)).toBe(true)
})

it('TC-002 老用户升级后继续保存，这次第二步和退回又都失败：记录改成要退回、存这次保存前的字节，重启后按它还原', () => {
  leftover('saving', bytes('hub.json'))
  const settings = bytes('hub.json')
  journalUndeletable()
  // 第一次替换设置文件（这次保存的第一步）成功，第二次（退回）失败；审核配置写不进
  renameFails({ config: 'EACCES', hubFailFrom: 2 })
  const error = caught(() => center.setEnabled({ id: ID, enabled: false }))
  expect(error?.code, 'PENDING_CLEANUP_BLOCKS 这次保存根本没开始').toBe('ROLLBACK_FAILED')
  expect(error.message).toBe(ROLLBACK_MESSAGE)
  const record = read('.save-journal.json')
  expect(record.state).toBe('rollback')
  expect(Buffer.from(record.before, 'base64').equals(settings), '记录存的是这次保存前的字节').toBe(true)
  vi.restoreAllMocks()
  center.stop()
  center = open()
  center.reconcile()
  expect(bytes('hub.json').equals(settings), '重启后按记录还原').toBe(true)
  expect(configIds()).toEqual([ID])
  expect(fs.existsSync(file('.save-journal.json'))).toBe(false)
})

it('TC-002 旧「要退回」记录还原成功但删不掉：改成「保存中」留着，之后写进设置的内容不再被旧字节退回（G1 第 1 轮 F-002）', () => {
  const older = bytes('hub.json')
  // 上一次保存没退回成：磁盘上是关掉模型的设置，记录要求退回到 older
  const prefs = read('hub.json')
  prefs.reviewEnabled[ID] = false
  fs.writeFileSync(file('hub.json'), JSON.stringify(prefs))
  leftover('rollback', older)
  journalUndeletable()
  center.reconcile()
  expect(bytes('hub.json').equals(older), '按记录退回了').toBe(true)
  expect(read('.save-journal.json').state, 'PENDING_CLEANUP_BLOCKS 删不掉的「要退回」记录没改成「保存中」').toBe('saving')
  // 之后有别的写入改了设置（就像接入模型后自动补档），再走一次处理记录
  const later = Buffer.from(JSON.stringify({ ...read('hub.json'), reviewEnabled: { [ID]: false } }))
  fs.writeFileSync(file('hub.json'), later)
  center.reconcile()
  expect(bytes('hub.json').equals(later), 'PENDING_CLEANUP_BLOCKS 留着的记录又把设置退回了旧字节').toBe(true)
})

it('TC-002 旧记录读不出、也删不掉：不开始这次保存、记录原样留着（G1 第 1 轮 F-001）', () => {
  fs.writeFileSync(file('.save-journal.json'), '{not json')
  const record = bytes('.save-journal.json')
  const settings = bytes('hub.json')
  journalUndeletable()
  const error = caught(() => center.setEnabled({ id: ID, enabled: false }))
  expect(error?.code, 'PENDING_CLEANUP_BLOCKS 读不出的记录删不掉也放行了这次保存').toBe('ROLLBACK_FAILED')
  expect(bytes('.save-journal.json').equals(record), '记录原样留着').toBe(true)
  expect(bytes('hub.json').equals(settings)).toBe(true)
})

it('TC-002 有效的「要退回」记录这次读不出（I/O 出错）：不重新生成、不删记录、不开始这次保存，重试也如实报没写进去（G1 第 2 轮 I-001）', () => {
  const older = bytes('hub.json')
  const prefs = read('hub.json')
  prefs.reviewEnabled[ID] = false
  fs.writeFileSync(file('hub.json'), JSON.stringify(prefs))
  leftover('rollback', older)
  const record = bytes('.save-journal.json')
  const settings = bytes('hub.json')
  const config = bytes('review-config.json')
  const journalPath = file('.save-journal.json')
  const realRead = fs.readFileSync
  vi.spyOn(fs, 'readFileSync').mockImplementation((target, ...rest) => {
    if (target === journalPath) throw Object.assign(new Error('test journal read failed'), { code: 'EIO' })
    return realRead(target, ...rest)
  })
  const error = caught(() => center.setEnabled({ id: ID, enabled: true }))
  expect(error?.code, 'PENDING_CLEANUP_BLOCKS 读不出的记录被当成没有、放行了这次保存').toBe('ROLLBACK_FAILED')
  expect(center.republish().exportOk, 'PENDING_CLEANUP_BLOCKS 恢复没做完，重试却报写进去了').toBe(false)
  vi.restoreAllMocks()
  expect(fs.existsSync(journalPath) && bytes('.save-journal.json').equals(record), 'PENDING_CLEANUP_BLOCKS 读不出的记录被删了或改了').toBe(true)
  expect(bytes('hub.json').equals(settings)).toBe(true)
  expect(bytes('review-config.json').equals(config), 'PENDING_CLEANUP_BLOCKS 没还原就按磁盘设置重新生成了审核配置').toBe(true)
})

it('TC-002 旧「要退回」记录（原来没有设置文件）还原后删不掉也改不了：不写初始化的设置，下次处理时不会把写进去的设置再退回（G1 第 2 轮 I-002）', () => {
  // 上一次保存前还没有设置文件：记录要求退回到「没有这个文件」
  const record = JSON.stringify({ schemaVersion: 1, state: 'rollback', file: 'hub.json', before: null, startedAt: '2026-10-01T00:00:00.000Z' }) + '\n'
  fs.writeFileSync(file('.save-journal.json'), record)
  journalUndeletable()
  renameFails({ journal: 'ENOSPC' })
  center.reconcile()
  expect(fs.existsSync(file('hub.json')), 'PENDING_CLEANUP_BLOCKS 记录还没失效就写了初始化的设置（之后会被它再退回）').toBe(false)
  expect(read('.save-journal.json').state).toBe('rollback')
  // 目录恢复正常：这次还原、记录失效、再写初始化的设置
  vi.restoreAllMocks()
  center.reconcile()
  expect(fs.existsSync(file('.save-journal.json'))).toBe(false)
  expect(Array.isArray(read('hub.json').order)).toBe(true)
  expect(configIds()).toEqual([ID])
})

it('TC-002 「要退回」记录还没失效时打开模型页、规则页：初始设置不落盘、红字照实（G1 第 3 轮 I-002）', () => {
  const record = JSON.stringify({ schemaVersion: 1, state: 'rollback', file: 'hub.json', before: null, startedAt: '2026-10-01T00:00:00.000Z' }) + '\n'
  fs.writeFileSync(file('.save-journal.json'), record)
  journalUndeletable()
  renameFails({ journal: 'ENOSPC' })
  center.reconcile()
  center.list()
  const rules = center.rulesGet()
  expect(fs.existsSync(file('hub.json')), 'PENDING_CLEANUP_BLOCKS 页面读取时记录还没失效就写了初始设置').toBe(false)
  expect(rules.exportOk, 'PENDING_CLEANUP_BLOCKS 恢复没做完，页面读取把红字清掉了').toBe(false)
  expect(read('.save-journal.json').state).toBe('rollback')
})

it('TC-002 「要退回」记录读不出（I/O 出错）时打开规则页：初始设置不落盘、红字照实（G1 第 3 轮 I-002）', () => {
  const older = bytes('hub.json')
  fs.rmSync(file('hub.json'))
  leftover('rollback', older)
  const journalPath = file('.save-journal.json')
  const realRead = fs.readFileSync
  vi.spyOn(fs, 'readFileSync').mockImplementation((target, ...rest) => {
    if (target === journalPath) throw Object.assign(new Error('test journal read failed'), { code: 'EIO' })
    return realRead(target, ...rest)
  })
  expect(center.republish().exportOk).toBe(false)
  expect(center.rulesGet().exportOk, 'PENDING_CLEANUP_BLOCKS 记录读不出，页面读取却把红字清掉了').toBe(false)
  expect(fs.existsSync(file('hub.json')), 'PENDING_CLEANUP_BLOCKS 记录读不出时写了初始设置').toBe(false)
})

it('TC-002 「要退回」还原后重新生成失败：记录原样留着，目录恢复后再处理一遍（G1 第 3 轮 F-002）', () => {
  // 记录要求退回到「关掉模型」的设置：还原后审核配置要跟着变，而审核配置写不进
  const prefs = read('hub.json')
  prefs.reviewEnabled[ID] = false
  const older = Buffer.from(JSON.stringify(prefs))
  leftover('rollback', older)
  const record = bytes('.save-journal.json')
  renameFails({ config: 'EACCES' })
  const error = caught(() => center.setEnabled({ id: ID, enabled: true }))
  expect(error?.code, 'PENDING_CLEANUP_BLOCKS 还原后重新生成失败，却开始了这次保存').toBe('ROLLBACK_FAILED')
  expect(fs.existsSync(file('.save-journal.json')) && bytes('.save-journal.json').equals(record), 'PENDING_CLEANUP_BLOCKS 重新生成失败，记录却已经删了或改了').toBe(true)
  vi.restoreAllMocks()
  center.reconcile()
  expect(bytes('hub.json').equals(older)).toBe(true)
  expect(fs.existsSync(file('.save-journal.json'))).toBe(false)
  expect(configIds()).toEqual([])
})

it('TC-002 打开页面时检查完恢复记录、拿到锁之前，另一个 CodePal 存了设置又留下「要退回」记录：不拿旧的初始值覆盖（G1 第 4 轮 I-002）', () => {
  const confirmed = bytes('hub.json')
  fs.rmSync(file('hub.json'))
  // 就在这次去拿写入锁的那一刻（看锁文件归谁 / 建锁文件），另一个 CodePal 写进了设置，随后一次保存没退回成
  const lockPath = file('.write.lock')
  let interleaved = false
  const otherCodePal = () => {
    if (interleaved) return
    interleaved = true
    fs.writeFileSync(file('hub.json'), confirmed)
    leftover('rollback', confirmed)
  }
  const realRead = fs.readFileSync
  vi.spyOn(fs, 'readFileSync').mockImplementation((target, ...rest) => {
    if (target === lockPath) otherCodePal()
    return realRead(target, ...rest)
  })
  const realLink = fs.linkSync
  vi.spyOn(fs, 'linkSync').mockImplementation((from, to) => {
    if (to === lockPath) otherCodePal()
    return realLink(from, to)
  })
  center.list()
  vi.restoreAllMocks()
  expect(interleaved, '测试没走到拿锁那一步').toBe(true)
  expect(bytes('hub.json')?.equals(confirmed), 'PENDING_CLEANUP_BLOCKS 拿到锁后没再看一遍，旧的初始值盖掉了另一个 CodePal 写进的设置').toBe(true)
  expect(read('.save-journal.json').state).toBe('rollback')
})
