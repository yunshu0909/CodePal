/**
 * Codex 用量事件归属：后端和备用前端共用的无 I/O 解析器。
 * - 累计快照先求新增量，再按事件时间和当时的模型归属。
 * - 保留旧扫描器的累计高水位与 fork 回放兼容规则。
 * @module electron/services/codexUsageRecords
 */
const REPLAY_WINDOW_MS = 5000
const number = value => Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : 0

/**
 * 从完整日志构造逐事件用量记录；不把后续模型追溯应用到旧用量。
 * @param {Array<{path:string,lines:string[]}>} files - 日志文件
 * @param {Date} start - 含边界
 * @param {Date} end - 不含边界
 * @returns {Array<object>} 用量记录
 */
export function collectCodexUsageRecords(files, start, end) {
  const sessions = new Map()
  const records = []
  for (const file of files || []) {
    const stem = String(file.path || '').split(/[\\/]/).pop().replace(/\.jsonl$/i, '')
    const id = (stem.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i)?.[1] || stem).toLowerCase()
    const state = sessions.get(id) || { input: 0, output: 0, cache: 0, model: 'codex', project: '未知项目', fork: false, firstTime: null }
    sessions.set(id, state)
    for (const line of file.lines || []) {
      let data
      try { data = JSON.parse(line) } catch { continue }
      if (data.type === 'turn_context') {
        if (typeof data.payload?.model === 'string' && data.payload.model.trim()) state.model = data.payload.model
        if (typeof data.payload?.cwd === 'string') state.project = data.payload.cwd.split(/[\\/]/).filter(Boolean).pop() || '未知项目'
      }
      if (data.type === 'session_meta' && data.payload?.forked_from_id) state.fork = true
      if (data.type !== 'event_msg' || data.payload?.type !== 'token_count') continue
      const usage = data.payload.info?.total_token_usage
      const timestamp = new Date(data.timestamp)
      if (!usage || !data.timestamp || Number.isNaN(timestamp.getTime())) continue
      if (state.firstTime === null) state.firstTime = timestamp.getTime()
      // 高水位兼容既有去重行为：重复或倒退的累计量不产生额外费用。
      // 计数器 reset 的完整证据处理属于独立 Agent 账本任务。
      const input = Math.max(state.input, number(usage.input_tokens))
      const output = Math.max(state.output, number(usage.output_tokens))
      const cache = Math.max(state.cache, Math.min(number(usage.cached_input_tokens), number(usage.input_tokens)))
      const addedCache = Math.min(input - state.input, cache - state.cache)
      const record = {
        timestamp, model: state.model, project: state.project,
        input: Math.max(0, input - state.input - addedCache),
        output: output - state.output, cacheRead: addedCache, cacheCreate: 0,
      }
      state.input = input; state.output = output; state.cache = cache
      if (state.fork && timestamp.getTime() - state.firstTime < REPLAY_WINDOW_MS) continue
      if (timestamp < start || timestamp >= end) continue
      if (record.input + record.output + record.cacheRead > 0) records.push(record)
    }
  }
  return records
}
