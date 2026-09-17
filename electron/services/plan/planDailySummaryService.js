/**
 * Subscription projection of the shared source/day Token authority.
 * - No independent cache, scanner, timer or pricing logic.
 * @module services/plan/planDailySummaryService
 */
/** @param {object} deps App-owned common statistics service. @returns {object} Trusted cycle query adapter. */
function createPlanDailySummaryService({statistics}={}) {
  if(!statistics)throw Error('SHARED_STATISTICS_REQUIRED')
  return {query:(planId,cycle)=>statistics.getPlanTokens(planId,cycle)}
}
module.exports={createPlanDailySummaryService}
