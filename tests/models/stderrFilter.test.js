/**
 * @vitest-environment node
 *
 * 模型接入 · 标准错误过滤的边角（问题池 #90 复查）
 *
 * 负责：
 * - 诊断行换一种等价的 JSON 写法（多空格、字段换顺序）也认得出
 * - 超长的候选行不管怎么分块到达，结果都一样（一律原样放行）
 *
 * @module tests/models/stderrFilter.test
 */

import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createStderrFilter } = require('../../electron/modules/models/stderrFilter.js')

const MARK = '[claude-code:unrecognized_model]'

/** 把若干块依次喂进过滤器，返回透传出来的全部字节 */
function run(chunks, modelName = 'deepseek-flash') {
  const out = []
  const filter = createStderrFilter({ modelName, write: (b) => out.push(Buffer.from(b)) })
  for (const c of chunks) filter.push(Buffer.isBuffer(c) ? c : Buffer.from(c, 'utf8'))
  filter.end()
  return Buffer.concat(out).toString('utf8')
}

describe('#90 等价写法与超长行', () => {
  it.each([
    ['冒号后多空格', `${MARK} {"model": "deepseek-flash", "query_source": "sdk"}\n`],
    ['字段换顺序', `${MARK} {"query_source":"sdk","model":"deepseek-flash"}\n`],
    ['前缀后两个空格', `${MARK}  {"model":"deepseek-flash","query_source":"sdk"}\n`],
  ])('%s也去掉', (_, line) => {
    expect(run(['a\n', line, 'b\n'])).toBe('a\nb\n')
  })

  it('字段换顺序、分块到达也去掉', () => {
    const line = `${MARK} {"query_source":"sdk","model":"deepseek-flash"}\n`
    expect(run(['a\n', line.slice(0, 20), line.slice(20, 50), line.slice(50), 'b\n'])).toBe('a\nb\n')
  })

  it('超过 64KB 的候选行：换行和正文一起到、或单独到，结果一样（原样放行）', () => {
    const line = `${MARK} {"model":"deepseek-flash","query_source":"${'x'.repeat(70000)}"}`
    const together = run([line.slice(0, 1000), line.slice(1000) + '\n'])
    const apart = run([line.slice(0, 1000), line.slice(1000), '\n'])
    expect(together).toBe(`${line}\n`)
    expect(apart).toBe(`${line}\n`)
  })
})
