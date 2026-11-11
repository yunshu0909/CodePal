/** @vitest-environment node
 * v2.1.29 TC-001（#78）：保存第一步写设置文件失败、删恢复记录也失败时，报的是第一步自己的错误，
 * 不被删除的错误盖掉：权限类报写不进去（write_denied），磁盘满这类别的错误照原有翻译规则报它自己；设置文件字节不变。
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
  center = createReviewCenter({ homeDir: sb.home, env: sb.env, locateClaude: () => null, locateCodex: () => null })
  center.reconcile()
  center.list()
})
afterEach(() => {
  center?.stop()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  sb.cleanup()
})

/** 写设置文件（替换那一步）按给定的错误失败，删恢复记录按另一种错误失败 */
function failFirstStep(writeCode) {
  const hubPath = file('hub.json')
  const journalPath = file('.save-journal.json')
  const realRename = fs.renameSync
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (to === hubPath) throw Object.assign(new Error('test settings write failed'), { code: writeCode })
    return realRename(from, to)
  })
  const realRm = fs.rmSync
  vi.spyOn(fs, 'rmSync').mockImplementation((target, ...rest) => {
    if (target === journalPath) throw Object.assign(new Error('test journal cleanup busy'), { code: 'EBUSY' })
    return realRm(target, ...rest)
  })
}

it('TC-001 第一步权限写不进、删记录也失败：报写不进去，不是删除的错误；设置文件字节不变', () => {
  const before = bytes('hub.json')
  failFirstStep('EACCES')
  const error = caught(() => center.setEnabled({ id: 'deepseek:deepseek-flash', enabled: false }))
  expect(error?.code, 'FIRST_STEP_MASKED 第一步的写入错误被删恢复记录的错误盖掉了').toBe('write_denied')
  expect(bytes('hub.json').equals(before)).toBe(true)
})

it('TC-001 第一步磁盘满、删记录也失败：照原有翻译规则报磁盘满本身，不是删除的错误；设置文件字节不变', () => {
  const before = bytes('hub.json')
  failFirstStep('ENOSPC')
  const error = caught(() => center.setEnabled({ id: 'deepseek:deepseek-flash', enabled: false }))
  expect(error?.code, 'FIRST_STEP_MASKED 第一步的写入错误被删恢复记录的错误盖掉了').toBe('ENOSPC')
  expect(error.message).toBe('test settings write failed')
  expect(bytes('hub.json').equals(before)).toBe(true)
})
