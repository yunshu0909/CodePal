/* @vitest-environment node */
/**
 * 模型别名归一（共享纯函数）测试
 *
 * 覆盖：
 * - 归一化规则（大小写 / 空格 / 点）
 * - 别名解析 + canonical 必须存在的护栏
 * - 合并语义：token 相加、总量不变、原始 id 保留在 sourceModels
 * - 顺序无关：canonical 先出现 vs 别名先出现，结果一致（回归：先出现的分支曾记错用量）
 *
 * @module tests/modelAlias
 */

import { describe, it, expect } from 'vitest'
import { normalizeModelKey, resolveCanonicalName, mergeAliasedModels } from '../electron/services/modelAlias.mjs'

const ALIASES = {
  'deepseek-v4-flash': 'deepseek-v4.1-flash',
  'deepseek-flash': 'deepseek-v4.1-flash',
}
const KNOWN = new Set(['deepseek-v4-1-flash', 'deepseek-v4-flash-vision-exp', 'glm-5-3'])

const row = (name, total) => ({
  name,
  input: total,
  output: 0,
  cacheRead: 0,
  cacheCreate: 0,
  total,
})

describe('normalizeModelKey', () => {
  it('小写 + 空格/点 → 连字符', () => {
    expect(normalizeModelKey('Claude Opus 4.7')).toBe('claude-opus-4-7')
    expect(normalizeModelKey('deepseek-v4.1-flash')).toBe('deepseek-v4-1-flash')
    expect(normalizeModelKey('glm-5.3')).toBe('glm-5-3')
  })

  it('空值不抛错', () => {
    expect(normalizeModelKey(null)).toBe('')
    expect(normalizeModelKey(undefined)).toBe('')
  })
})

describe('resolveCanonicalName', () => {
  it('别名归一到 canonical，canonical 自身原样返回', () => {
    expect(resolveCanonicalName('deepseek-flash', ALIASES, KNOWN)).toBe('deepseek-v4.1-flash')
    expect(resolveCanonicalName('deepseek-v4.1-flash', ALIASES, KNOWN)).toBe('deepseek-v4.1-flash')
  })

  it('canonical 不在已知集合里时不归一（护栏：宁可各行可见）', () => {
    expect(resolveCanonicalName('ghost', { ghost: 'not-a-real-model' }, KNOWN)).toBe('ghost')
    // 不传 knownKeys 时按别名表直接归一（调用方自行保证表正确）
    expect(resolveCanonicalName('ghost', { ghost: 'anything' })).toBe('anything')
  })

  it('无别名表的模型名原样返回', () => {
    expect(resolveCanonicalName('glm-5.3', ALIASES, KNOWN)).toBe('glm-5.3')
    expect(resolveCanonicalName('', ALIASES, KNOWN)).toBe('')
  })
})

describe('mergeAliasedModels', () => {
  it('别名先出现：合并成一行，token 相加，sourceModels 保留全部原始 id', () => {
    const merged = mergeAliasedModels(
      [row('deepseek-flash', 60), row('deepseek-v4-flash', 6), row('glm-5.3', 5)],
      ALIASES,
      KNOWN
    )

    expect(merged.map((m) => m.name)).toEqual(['deepseek-v4.1-flash', 'glm-5.3'])
    expect(merged[0].total).toBe(66)
    expect(merged[0].input).toBe(66)
    expect(merged[0].sourceModels.map((s) => s.name)).toEqual(['deepseek-flash', 'deepseek-v4-flash'])
    expect(merged[1].sourceModels).toEqual([])
  })

  it('canonical 先出现：sourceModels 记录的是累加前的原始用量（顺序无关）', () => {
    const merged = mergeAliasedModels(
      [row('deepseek-v4.1-flash', 100), row('deepseek-flash', 60)],
      ALIASES,
      KNOWN
    )

    expect(merged).toHaveLength(1)
    expect(merged[0].total).toBe(160)
    // 回归点：canonical 那一条必须记 100（而不是合并后的 160）
    expect(merged[0].sourceModels).toEqual([
      expect.objectContaining({ name: 'deepseek-v4.1-flash', total: 100 }),
      expect.objectContaining({ name: 'deepseek-flash', total: 60 }),
    ])
  })

  it('vision / pro / 其他厂商不被误并', () => {
    const merged = mergeAliasedModels(
      [row('deepseek-v4-flash-vision-exp', 3), row('deepseek-v4-pro', 2), row('glm-5.3', 1)],
      ALIASES,
      KNOWN
    )

    expect(merged.map((m) => m.name).sort()).toEqual([
      'deepseek-v4-flash-vision-exp',
      'deepseek-v4-pro',
      'glm-5.3',
    ])
  })

  it('合并前后总量不变（占比与费用口径不受影响）', () => {
    const rows = [row('deepseek-v4-flash', 6), row('deepseek-flash', 60), row('glm-5.3', 5)]
    const before = rows.reduce((sum, r) => sum + r.total, 0)
    const after = mergeAliasedModels(rows, ALIASES, KNOWN).reduce((sum, r) => sum + r.total, 0)
    expect(after).toBe(before)
  })

  it('空输入 / 别名表缺失时安全返回', () => {
    expect(mergeAliasedModels([], ALIASES, KNOWN)).toEqual([])
    expect(mergeAliasedModels(null, ALIASES, KNOWN)).toEqual([])
    expect(mergeAliasedModels([row('deepseek-flash', 1)], null, null)).toHaveLength(1)
  })
})
