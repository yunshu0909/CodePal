/**
 * 能来审的模型数与两条提醒（A-008、状态清单 A3 / B8）
 *
 * - 分别算用 Claude Code 写代码、用 Codex 写代码两种情况：能来审的 = 打开且能用的模型数，
 *   自审关着时减去写代码那一家的模型（那家没开就不减）；同一家的不同模型分别算
 * - 某道关设的个数大于能来审的数，就在自审开关下用橙字说明实际只会派几个（照样保存）
 * - 只开了 Claude 或只开了 Codex、自审关着时，模型页签卡下橙字提醒
 *
 * 文案只在这里定义一份，页面和测试都引用它。纯函数。
 *
 * @module features/modelHub/reviewCapacity
 */

const SIDE_NAME = { claude: 'Claude Code', codex: 'Codex' }

/**
 * @param {Array<{vendor: string}>} models 审核在用里打开且能用的模型
 * @param {boolean} selfReview 写代码的那家也参与审核
 * @returns {{claude: number, codex: number}} 两种情况下能来审的模型数
 */
export function reviewCapacity(models, selfReview) {
  const count = (vendor) => models.filter((model) => model.vendor === vendor).length
  return {
    claude: models.length - (selfReview ? 0 : count('claude')),
    codex: models.length - (selfReview ? 0 : count('codex')),
  }
}

const joinCounts = (values) => values.map((n) => `${n} 个`).join('、')

/**
 * 自审开关下的橙字；都够时返回 null
 * @param {Array<{vendor: string}>} models
 * @param {boolean} selfReview
 * @param {Record<string, {reviewers: number}>} gates 各道关设的个数
 * @returns {string|null}
 */
export function capacityWarning(models, selfReview, gates) {
  const { claude, codex } = reviewCapacity(models, selfReview)
  const wanted = [...new Set(Object.values(gates).map((gate) => gate.reviewers))].sort((a, b) => a - b)
  const over = (available) => wanted.filter((n) => n > available)
  const claudeShort = over(claude)
  const codexShort = over(codex)
  if (claudeShort.length && codexShort.length) {
    if (claude === codex)
      return `不管用 Claude Code 还是 Codex 写代码，都只有 ${claude} 个模型能来审；设成 ${joinCounts(claudeShort)}的关只会派 ${claude} 个`
    return `用 Claude Code 写代码时只有 ${claude} 个模型能来审，用 Codex 写代码时只有 ${codex} 个；设成 ${joinCounts(over(Math.min(claude, codex)))}的关只会派这么多`
  }
  if (claudeShort.length) return `用 ${SIDE_NAME.claude} 写代码时只有 ${claude} 个模型能来审；设成 ${joinCounts(claudeShort)}的关只会派 ${claude} 个`
  if (codexShort.length) return `用 ${SIDE_NAME.codex} 写代码时只有 ${codex} 个模型能来审；设成 ${joinCounts(codexShort)}的关只会派 ${codex} 个`
  return null
}

/**
 * 模型页签卡下的橙字：打开的全是同一家订阅（Claude 或 Codex）且自审关着
 * @returns {string|null}
 */
export function singleFamilyWarning(models, selfReview) {
  if (selfReview || models.length === 0) return null
  const vendors = new Set(models.map((model) => model.vendor))
  if (vendors.size !== 1) return null
  if (vendors.has('claude')) return '只开了 Claude：用 Claude Code 写代码时，没有别家模型来审'
  if (vendors.has('codex')) return '只开了 Codex：用 Codex 写代码时，没有别家模型来审'
  return null
}
