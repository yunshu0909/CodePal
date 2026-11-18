/** @vitest-environment node
 * v2.1.28 TC-013（代码审核第 2 轮）：新建项目模板里「审核派谁、付费看哪里」各章节说法一致
 *
 * - 第 6 节：新任务的审核模型、顺序、轮次、付费看 CodePal 审核清单；project-defaults.json 管私人路径，
 *   它里面的审核路线和付费授权只在不挂任务的独立送审、裁决席、模型体检里当后备
 * - 第 8 节知识地图：审核派谁、顺序、轮次、付费的正本是 CodePal 审核清单；私人路径另起一行
 * - 第 3 节：设计审查通过后改包的再确认不占次数
 */
import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const dir = path.resolve(__dirname, '..', '..', 'templates', 'project-init-v4')
const read = (name) => readFileSync(path.join(dir, name), 'utf8')
function section(text, from, to) {
  const start = text.indexOf(from)
  const end = text.indexOf(to)
  return start >= 0 && end > start ? text.slice(start, end) : ''
}

it('TC-013 模板各章节对审核派谁、付费看哪里说法一致；第 3 节写明通过后改包的再确认不占次数', () => {
  const text = read('CLAUDE.md')
  expect(read('AGENTS.md')).toBe(text)
  const six = section(text, '## 6. dev-workflow 项目参数', '## 7. 代码规范')
  expect(six).toContain('CodePal 审核清单')
  expect(six).toContain('独立送审')
  expect(six).toContain('裁决席')
  expect(six).toContain('模型体检')
  expect(six).not.toMatch(/审核路线、付费授权、私人路径看/)
  const eight = section(text, '## 8. 知识地图', '## 9. 本协议怎么维护')
  const rows = eight.split('\n').filter((line) => line.startsWith('|'))
  const review = rows.find((line) => line.includes('付费'))
  expect(review, '知识地图有审核与付费那一行').toBeTruthy()
  expect(review).toContain('CodePal 审核清单')
  expect(review).toContain('裁决席')
  expect(rows.some((line) => line.startsWith('| 私人路径 |') && line.includes('project-defaults.json'))).toBe(true)
  const three = section(text, '## 3. 红线与必须先问', '## 4. 遇事去哪')
  expect(three).toContain('通过后改包的再确认不占次数')
})

it('#88 第 6 条 三节说到 project-defaults.json 当后备时，用到的地方和后备哪几项说法一致', () => {
  const text = read('CLAUDE.md')
  const three = section(text, '## 3. 红线与必须先问', '## 4. 遇事去哪')
  const money = three.split('\n').find((line) => line.startsWith('- 花钱'))
  const six = section(text, '## 6. dev-workflow 项目参数', '## 7. 代码规范')
  const eight = section(text, '## 8. 知识地图', '## 9. 本协议怎么维护')
  const review = eight.split('\n').find((line) => line.startsWith('|') && line.includes('付费'))
  for (const [name, part] of [['第 3 节花钱', money], ['第 6 节', six], ['第 8 节知识地图', review]]) {
    for (const word of ['独立送审', '裁决席', '模型体检', '审核顺序', '套餐声明', '排除路线', '付费授权'])
      expect(part, `${name}要写「${word}」`).toContain(word)
  }
})
