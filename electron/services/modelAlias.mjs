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
 * Claude 模型 id → 可读展示名（主进程 / 渲染进程共用，只有这一份实现）
 *
 * - `claude-opus-5` → `Claude Opus 5`：**没有 minor 的型号也要可读**，
 *   否则会退化成原始 id，和 `Claude Fable 5.1` 混在一张表里显得不一致
 * - `claude-opus-4-7` → `Claude Opus 4.7`
 * - `claude-haiku-4-5-20251001` → `Claude Haiku 4.5`（吃掉日期后缀）
 * - 其他写法（如 `claude-3-5-sonnet` 这种老顺序）原样返回，不猜
 *
 * @param {string} model - 原始模型 id
 * @returns {string} 展示名；空值返回 'unknown'
 */
export function normalizeClaudeModelName(model) {
  if (!model || typeof model !== 'string') return 'unknown'

  // major 必填；minor 只允许 1-2 位且后面不能再跟数字，避免把 8 位日期吃成 minor
  const match = model.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2})(?!\d))?(?:-\d{8,})?$/i)
  if (!match) return model

  const tier = match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase()
  const version = match[3] ? `${match[2]}.${match[3]}` : match[2]
  return `Claude ${tier} ${version}`
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
 * 把同一上游模型的多个别名合并成一行，并把 Claude 原始 id 变成可读展示名
 *
 * token 逐项相加；原始 id 与各自用量保留在 `sourceModels`，需要看"路由明细"时直接读它，
 * 信息不丢。合并前后总量不变，因此下游的占比/费用口径不受影响。
 *
 * 展示名在这里再做一次（幂等）：解析层已经归一过的新数据原样通过，而**已缓存**的日汇总里
 * 仍是 `claude-opus-5` 这类原始 id，这一层兜住才能让新旧数据在同一张表里名字一致。
 *
 * @param {Array<object>} models - 模型行数组
 * @param {Record<string, string>} aliases - 别名表
 * @param {Set<string>|null} [knownKeys] - 已知 canonical key 集合
 * @returns {Array<object>} 合并后的模型行数组
 */
export function mergeAliasedModels(models, aliases, knownKeys = null) {
  const merged = new Map()

  for (const model of models || []) {
    const displayName = normalizeClaudeModelName(model.name)
    const canonical = resolveCanonicalName(displayName, aliases, knownKeys)
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
