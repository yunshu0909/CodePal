/** @vitest-environment node
 * v2.1.17 · 能来审的模型数与两条提醒（A-008、B8、A3）
 * 按 Claude Code 写、Codex 写两种情况分别算；自审关着时减去写代码那一家；同一家的不同模型分别算
 */
import { expect, it } from 'vitest'
import {
  reviewCapacity,
  capacityWarning,
  singleFamilyWarning,
} from '../../src/features/modelHub/reviewCapacity.js'

const m = (vendor, slug = vendor) => ({ vendor, id: `${vendor}:${slug}` })
const gates = (values) =>
  Object.fromEntries(
    ['lite.G0', 'lite.G1', 'formal.G1', 'formal.G2b', 'formal.G3', 'formal.G4'].map((id, i) => [
      id,
      { reviewers: values[i] ?? 1, rounds: 3 },
    ]),
  )

it('SC-015 只开了一家订阅且自审关：提示用这家写代码时没有别家来审；两家都开、只开接入、自审开都不提示', () => {
  expect(singleFamilyWarning([m('codex', 'gpt-6.1-sol')], false)).toBe(
    '只开了 Codex：用 Codex 写代码时，没有别家模型来审',
  )
  expect(singleFamilyWarning([m('codex', 'a'), m('codex', 'b')], false)).toBe(
    '只开了 Codex：用 Codex 写代码时，没有别家模型来审',
  )
  expect(singleFamilyWarning([m('claude', 'opus')], false)).toBe(
    '只开了 Claude：用 Claude Code 写代码时，没有别家模型来审',
  )
  expect(singleFamilyWarning([m('claude', 'opus')], true)).toBeNull()
  expect(singleFamilyWarning([m('codex'), m('claude')], false)).toBeNull()
  expect(singleFamilyWarning([m('deepseek')], false)).toBeNull()
  expect(singleFamilyWarning([m('deepseek'), m('mimo-api')], false)).toBeNull()
  expect(singleFamilyWarning([], false)).toBeNull()
})

it('SC-028 两种情况人数相同：合成一句，写设成几个的关只会派几个', () => {
  // 定稿 W7：开 Opus、GPT、deepseek，自审关，代码审核设 3 个
  const on = [m('claude', 'opus'), m('codex', 'gpt-6.1-sol'), m('deepseek')]
  expect(reviewCapacity(on, false)).toEqual({ claude: 2, codex: 2 })
  expect(capacityWarning(on, false, gates([1, 3, 1, 1, 1, 2]))).toBe(
    '不管用 Claude Code 还是 Codex 写代码，都只有 2 个模型能来审；设成 3 个的关只会派 2 个',
  )
})

it('SC-028 两种情况人数不同：分开写两种情况', () => {
  const on = [m('claude', 'opus'), m('claude', 'sonnet'), m('codex', 'gpt-6.1-sol')]
  expect(reviewCapacity(on, false)).toEqual({ claude: 1, codex: 2 })
  expect(capacityWarning(on, false, gates([1, 3, 1, 1, 1, 2]))).toBe(
    '用 Claude Code 写代码时只有 1 个模型能来审，用 Codex 写代码时只有 2 个；设成 2 个、3 个的关只会派这么多',
  )
})

it('SC-028 只有一种情况不够：只写那一种；几道关设的个数不同只列超过的', () => {
  const on = [m('claude', 'opus'), m('codex', 'a'), m('codex', 'b'), m('deepseek')]
  expect(reviewCapacity(on, false)).toEqual({ claude: 3, codex: 2 })
  expect(capacityWarning(on, false, gates([1, 3, 1, 1, 1, 2]))).toBe(
    '用 Codex 写代码时只有 2 个模型能来审；设成 3 个的关只会派 2 个',
  )
  const few = [m('claude', 'opus'), m('codex', 'a')]
  expect(capacityWarning(few, false, gates([1, 3, 1, 1, 2, 2]))).toBe(
    '不管用 Claude Code 还是 Codex 写代码，都只有 1 个模型能来审；设成 2 个、3 个的关只会派 1 个',
  )
  // 都够：不提示
  expect(capacityWarning(on, false, gates([1, 2, 1, 1, 1, 2]))).toBeNull()
})

it('SC-028 一个都没有：也照样提示只会派 0 个（dev 会停下说审核不了）', () => {
  expect(capacityWarning([], false, gates([1, 2, 1, 1, 1, 2]))).toBe(
    '不管用 Claude Code 还是 Codex 写代码，都只有 0 个模型能来审；设成 1 个、2 个的关只会派 0 个',
  )
})

it('SC-032 自审开着：写代码那一家也算进来，仍不够照样提示', () => {
  const one = [m('codex', 'gpt-6.1-sol')]
  expect(reviewCapacity(one, true)).toEqual({ claude: 1, codex: 1 })
  expect(capacityWarning(one, true, gates([1, 3, 1, 1, 1, 2]))).toBe(
    '不管用 Claude Code 还是 Codex 写代码，都只有 1 个模型能来审；设成 2 个、3 个的关只会派 1 个',
  )
  const enough = [m('claude', 'opus'), m('codex', 'gpt-6.1-sol'), m('deepseek')]
  expect(capacityWarning(enough, true, gates([1, 3, 1, 1, 1, 2]))).toBeNull()
  expect(capacityWarning(enough, false, gates([1, 3, 1, 1, 1, 2]))).not.toBeNull()
  // 自审开着时「只开了一家」不再出现
  expect(singleFamilyWarning(one, true)).toBeNull()
})
