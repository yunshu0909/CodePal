/** Heavy transcript parsing stays outside Electron's event loop. */
const { parentPort } = require('worker_threads')
const { aggregateUsage, listUsageRecords } = require('./usageEngine')
parentPort.on('message', async ({ id, action, deps, options }) => {
  try {
    const data = await (action === 'records'
      ? listUsageRecords(deps, options)
      : aggregateUsage(deps, options))
    parentPort.postMessage({ id, data })
  } catch (error) {
    parentPort.postMessage({ id, error: error.message || 'SKILL_USAGE_FAILED' })
  }
})
