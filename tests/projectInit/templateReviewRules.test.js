/** @vitest-environment node
 * v2.1.28 TC-007（#87）：新建项目模板的协议第 3 节补上审核相关的通用条款
 *
 * - 两份协议（CLAUDE.md / AGENTS.md）全文一致，抬头写协议 v4.2
 * - 第 3 节：花钱按 CodePal 审核清单授权；旧任务按清单自动加，新任务在上限内收尾（保留兼容分界）；
 *   审核意见由写代码的 AI 裁决、一般意见默认留到下一版；用户原话放行、AI 不替用户放行
 * - 只写通用条款：不带本项目的日期、原话出处和私人路径；只保留必要的插件兼容分界
 */
import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const dir = path.resolve(__dirname, '..', '..', 'templates', 'project-init-v4')
const read = (name) => readFileSync(path.join(dir, name), 'utf8')

/** 第 3 节正文（到第 4 节标题为止） */
function sectionThree(text) {
  const start = text.indexOf('## 3. 红线与必须先问')
  const end = text.indexOf('## 4. 遇事去哪')
  return start >= 0 && end > start ? text.slice(start, end) : ''
}

it('TC-007 模板协议第 3 节写了审核相关的通用条款，两份一致、抬头协议 v4.2、不带本项目的日期和出处', () => {
  const claude = read('CLAUDE.md')
  expect(read('AGENTS.md')).toBe(claude)
  expect(claude).toContain('协议 v4.2（由 CodePal「新建项目」生成）')
  const three = sectionThree(claude)
  for (const phrase of [
    'CodePal 审核清单',
    '轮次用完',
    '自动加',
    '需求对齐',
    '边界审查',
    '对账复核',
    '0.13.3 起开工的任务',
    '到顶即止，不加轮、不找用户',
    '第 2 轮起只核上一轮意见',
    '最后一道须整套测试全过',
    '写代码的 AI 裁决',
    '一般意见默认留到下一版',
    '原话放行',
    'AI 不替用户放行',
  ])
    expect(three, phrase).toContain(phrase)
  expect(three).not.toMatch(/20\d\d-\d\d-\d\d|\b\d{1,2}-\d{2} 用户|0\.12\.\d+|\/Users\//)
})
