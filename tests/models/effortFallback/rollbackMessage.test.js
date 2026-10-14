/** @vitest-environment node
 * v2.1.24 TC-004（#72）：保存第二步（重新生成审核配置）失败、设置已按字节退回成功，只是恢复记录删不掉时，
 * 报的是第二步本身的错（写不进去），不是「也没能退回原来的设置」；不把记录改成「要退回」。
 * 留下的「保存中」记录在下一次写入时按已落盘（已退回）的设置处理掉。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { makeSandbox, KEY } from '../helpers'

const require = createRequire(import.meta.url)
const { createReviewCenter } = await import('../../../electron/modules/models/reviewCenter.js')
const store = require('../../../electron/modules/models/store.js')

let sb, center
const file = (name) => path.join(sb.models, name)
const bytes = (name) => (fs.existsSync(file(name)) ? fs.readFileSync(file(name)) : null)
const read = (name) => JSON.parse(fs.readFileSync(file(name), 'utf8'))
function caught(fn) {
  try {
    fn()
  } catch (error) {
    return error
  }
  return null
}

beforeEach(() => {
  sb = makeSandbox()
  for (const [k, v] of Object.entries(sb.env)) vi.stubEnv(k, v)
  store.setKey('deepseek', KEY)
  store.writeStatus('deepseek', 'deepseek-flash', { ok: true, source: 'test' })
  center = null
})
afterEach(() => {
  center?.stop()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  sb.cleanup()
})

it('TC-004 退回成功但删恢复记录失败：报第二步的写不进去，不报没能退回；记录不改成要退回，下次写入照常', () => {
  center = createReviewCenter({ homeDir: sb.home, env: sb.env, locateClaude: () => null, locateCodex: () => null })
  center.reconcile()
  center.list()
  const before = bytes('hub.json')
  expect(read('review-config.json').models.map((m) => m.id)).toEqual(['deepseek:deepseek-flash'])
  const journalPath = file('.save-journal.json')
  const configPath = file('review-config.json')
  const realRename = fs.renameSync
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (to === configPath) throw Object.assign(new Error('test write denied'), { code: 'EACCES' })
    return realRename(from, to)
  })
  const realRm = fs.rmSync
  vi.spyOn(fs, 'rmSync').mockImplementation((target, ...rest) => {
    if (target === journalPath && fs.existsSync(journalPath)) throw Object.assign(new Error('test cleanup denied'), { code: 'EPERM' })
    return realRm(target, ...rest)
  })
  const error = caught(() => center.setEnabled({ id: 'deepseek:deepseek-flash', enabled: false }))
  expect(error?.code, 'ROLLBACK_MISREPORTED 设置已退回却报没能退回').toBe('write_denied')
  expect(error.message).not.toContain('也没能退回')
  expect(bytes('hub.json').equals(before)).toBe(true)
  expect(read('.save-journal.json').state).toBe('saving')
  vi.restoreAllMocks()
  expect(center.setEnabled({ id: 'deepseek:deepseek-flash', enabled: false })).toEqual({ id: 'deepseek:deepseek-flash', enabled: false })
  expect(fs.existsSync(journalPath)).toBe(false)
  expect(read('review-config.json').models).toEqual([])
})
