// @vitest-environment node
/**
 * 对话索引封顶（#102）：超过 10000 条时，按同样顺序再列一次，前 10000 条照样复用，不轮流失效
 *
 * 单独一个文件：索引是模块级的，别的测试留下的条目会占名额。
 *
 * @module tests/sessions/sessionIndexLimit.test
 */

import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { L, stamp, makeProjectsDir } from './fixtures'

const require = createRequire(import.meta.url)
const svc = require('../../electron/services/sessionBrowserService')
const reader = require('../../electron/services/sessionFileReader')

let p
beforeAll(() => {
  p = makeProjectsDir()
  const body = stamp([L.user('hello')], { cwd: '/fixture/project' }).map((l) => JSON.stringify(l)).join('\n') + '\n'
  for (let d = 0; d < 11; d++) {
    const dir = path.join(p.dir, `-p${d}`)
    fs.mkdirSync(dir)
    for (let i = 0; i < 1000 && d * 1000 + i < 10_001; i++) fs.writeFileSync(path.join(dir, `s${i}.jsonl`), body)
  }
})
afterAll(() => p.cleanup())

it('10001 条没变的对话，第二次列表只重读放不下的那 1 条', async () => {
  const options = { projectsDir: p.dir }
  const first = await svc.listRecent(options)
  expect(first.sessions).toHaveLength(10_001)
  expect(svc.metadataIndexSizeForTests()).toBe(10_000)
  reader.resetReaderStats()
  const second = await svc.listRecent(options)
  expect(second.sessions).toHaveLength(10_001)
  const oneFile = fs.statSync(path.join(p.dir, '-p0', 's0.jsonl')).size
  expect(reader.getReaderStats().bytesRead).toBeLessThanOrEqual(oneFile * 2)
}, 60_000)

it('索引满了，放不下的那条在读的途中被删，这一次不列出来', async () => {
  const options = { projectsDir: p.dir }
  const realStat = fsp.stat.bind(fsp)
  const calls = new Map()
  let removed = null
  // 收录了的文件每次列表只核对一次属性；放不下的那条读前读后各一次，第二次之前把它删掉
  const spy = vi.spyOn(fsp, 'stat').mockImplementation(async (file, ...rest) => {
    const n = (calls.get(file) || 0) + 1
    calls.set(file, n)
    if (n === 2 && !removed) { removed = file; fs.unlinkSync(file) }
    return realStat(file, ...rest)
  })
  try {
    const { sessions } = await svc.listRecent(options)
    expect(removed).not.toBeNull()
    expect(sessions).toHaveLength(10_000)
  } finally {
    spy.mockRestore()
  }
}, 60_000)

