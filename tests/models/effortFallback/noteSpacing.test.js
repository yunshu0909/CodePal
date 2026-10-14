/** @vitest-environment node
 * v2.1.24 TC-005（#72）：模型接入详情「思考强度」后面的小字「终端手动用」，左间距在设计总纲 3.17 的间距档位上
 * （2 / 4 / 8 / 12 / 16 / 20 / 24），取最接近原 6px 观感的 4px。
 */
import fs from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'

const css = fs.readFileSync(path.resolve(__dirname, '../../../src/features/models/models.css'), 'utf8')
const LADDER = [2, 4, 8, 12, 16, 20, 24]

it('TC-005 「终端手动用」小字的左间距在间距档位上（4px）', () => {
  const block = css.match(/\.mj-page \.mj-note\s*\{([^}]*)\}/)
  expect(block, '.mj-note 规则还在').not.toBeNull()
  const margin = block[1].match(/margin-left:\s*(\d+)px/)
  expect(margin, '.mj-note 有左间距').not.toBeNull()
  const px = Number(margin[1])
  expect(LADDER.includes(px), `NOTE_OFF_LADDER 左间距 ${px}px 不在档位`).toBe(true)
  expect(px).toBe(4)
})
