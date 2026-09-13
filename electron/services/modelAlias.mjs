/**
 * 模型别名归一（主进程 / 渲染进程共享的纯函数）
 *
 * 背景：日志里的模型 id 是**调用端写的别名**，不是模型自报的。同一个上游模型在不同
 * 客户端（DSH / Claude Code / Codex）与不同版本、不同时间点会写成不同字符串，例如
 * deepseek-flash、deepseek-v4-flash、deepseek-v4.1-flash-expires-on-0910 其实是同一个
 * DeepSeek Flash。不归一就会在明细表里裂成多行，且没登记价格的行显示 `--`。
 *
 * 归一规则来自 pricing.json 的 `aliases`（keys 与 canonical 都是 normalizeModelKey 之后
 * 或可直接归一的形式）。这里只做纯函数，不关心价格从哪来，避免两套口径。
 *
 * @module electron/services/modelAlias
 */

/**
 * 模型名归一化为定价表 key：小写 + 空格/点 → 连字符
 * @param {string} name - 原始模型名
 * @returns {string} 归一化 key
 */
export function normalizeModelKey(name) {
  return String(name ?? '').toLowerCase().replace(/[\s.]+/g, '-')
}

/**
 * 把别名解析成 canonical 名字
 *
 * 只有 canonical 能在 `knownKeys` 里命中时才归一：别名表写错目标时宁可各行独立可见，
 * 也不要把互不相干的模型并成一团。
 *
 * @param {string} name - 日志里的原始模型名
 * @param {Record<string, string>} aliases - 别名表（normalized alias → canonical）
 * @param {Set<string>|null} [knownKeys] - 已知的 canonical key 集合；null 表示不校验
 * @returns {string} canonical 名字（无别名时原样返回）
 */
export function resolveCanonicalName(name, aliases, knownKeys = null) {
  if (typeof name !== 'string' || !name) return name
  if (!aliases || typeof aliases !== 'object') return name

  const target = aliases[normalizeModelKey(name)]
  if (typeof target !== 'string' || !target.trim()) return name

  const canonical = target.trim()
  if (knownKeys && !knownKeys.has(normalizeModelKey(canonical))) return name
  return canonical
}

/**
 * 取一行模型的用量字段（不含 name/color 等展示字段）
 * @param {object} model - 模型行
 * @returns {{name: string, input: number, output: number, cacheRead: number, cacheCreate: number, total: number}}
 */
function pickUsage(model) {
  return {
    name: model.name,
    input: model.input,
    output: model.output,
    cacheRead: model.cacheRead,
    cacheCreate: model.cacheCreate,
    total: model.total,
  }
}

/**
 * 把同一上游模型的多个别名合并成一行
 *
 * token 逐项相加；原始 id 与各自用量保留在 `sourceModels`，需要看"路由明细"时直接读它，
 * 信息不丢。合并前后总量不变，因此下游的占比/费用口径不受影响。
 *
 * @param {Array<object>} models - 模型行数组
 * @param {Record<string, string>} aliases - 别名表
 * @param {Set<string>|null} [knownKeys] - 已知 canonical key 集合
 * @returns {Array<object>} 合并后的模型行数组
 */
export function mergeAliasedModels(models, aliases, knownKeys = null) {
  const merged = new Map()

  for (const model of models || []) {
    const canonical = resolveCanonicalName(model.name, aliases, knownKeys)
    const current = merged.get(canonical)

    if (!current) {
      merged.set(canonical, {
        ...model,
        name: canonical,
        sourceModels: canonical === model.name ? [] : [pickUsage(model)],
      })
      continue
    }

    // canonical 行自己的用量也要进 sourceModels（必须在累加之前取，否则记下的是合并后的合计）
    if (current.sourceModels.length === 0) current.sourceModels.push(pickUsage(current))

    current.input += model.input
    current.output += model.output
    current.cacheRead += model.cacheRead
    current.cacheCreate += model.cacheCreate
    current.total += model.total
    current.sourceModels.push(pickUsage(model))
  }

  return Array.from(merged.values())
}
