/**
 * DSH 用量事件归属：主进程与备用前端共用的无 I/O 解析器。
 *
 * 负责：
 * - 从会话日志行提取逐步用量记录（v0–v2 与 v3 两代格式同构）
 * - 按 `(sessionId, turn, step)` 去重，同组保留合计最大的样本
 * - 同一目录并存两代日志时只取最高代，避免整段翻倍
 * - seeded fork 继承的祖先前缀事件不重复计量
 *
 * 不做任何 I/O：压缩解压由 zstdFrames 负责，文件发现由扫描层负责。
 * 记录形状与 Codex 侧保持一致，便于共用聚合与展示。
 *
 * @module electron/services/dshUsageRecords
 */

import path from 'node:path'

/** 会话日志文件名：session.v3.jsonl.zstd / session.jsonl.zstd */
const SESSION_LOG_PATTERN = /^session(?:\.v(\d+))?\.jsonl\.zstd$/i

/**
 * 非负整数归一化
 * @param {unknown} value - 原始值
 * @returns {number}
 */
function toSafeInt(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return 0
  return Math.floor(parsed)
}

/**
 * 解析日志文件的代次；识别不了时返回 -1
 * @param {string} filePath - 文件路径
 * @returns {number}
 */
function logGeneration(filePath) {
  const match = SESSION_LOG_PATTERN.exec(path.basename(String(filePath || '')))
  if (!match) return -1
  return match[1] ? Number(match[1]) : 0
}

/**
 * 每个会话目录只保留最高代的日志
 *
 * DSH 升级会让同一目录同时留下旧代与新代日志；两代都读会把整段用量算两遍。
 *
 * @param {Array<{path: string}>} files - 候选日志
 * @returns {Array<object>} 择代后的日志
 */
export function selectHighestGenerationFiles(files) {
  const byDirectory = new Map()
  const unrecognized = []

  for (const file of files || []) {
    const generation = logGeneration(file?.path)

    // 不认识的文件名不参与择代，各自独立保留，避免被误合并
    if (generation < 0) {
      unrecognized.push(file)
      continue
    }

    const directory = path.dirname(String(file?.path || ''))
    const current = byDirectory.get(directory)

    if (!current || generation > current.generation) {
      byDirectory.set(directory, { generation, file })
    }
  }

  return [...Array.from(byDirectory.values(), (entry) => entry.file), ...unrecognized]
}

/**
 * 从会话日志行构造逐事件用量记录
 *
 * 时间来源只用事件自身的 `time`（Unix epoch 毫秒）；不用文件 mtime 或会话创建时间，
 * 因为一个会话可以跨天，只有逐步时间戳能精确归属日期。
 *
 * @param {Array<{path: string, lines: string[]}>} files - 已解压的日志行
 * @param {Date} start - 窗口开始（含）
 * @param {Date} end - 窗口结束（不含）
 * @returns {Array<{timestamp: Date, model: string, project: string, input: number, output: number, cacheRead: number, cacheCreate: number, sessionId: string|null}>} 用量记录
 */
export function collectDshUsageRecords(files, start, end) {
  const records = []

  for (const file of selectHighestGenerationFiles(files)) {
    // 同 (turn, step) 可能有流式中间态与最终态，按合计最大者保留
    const samples = new Map()
    let sessionId = null
    let project = '未知项目'
    let inheritedEvents = 0
    let contextModel = null

    for (const rawLine of file?.lines || []) {
      let event
      try {
        event = JSON.parse(rawLine)
      } catch {
        continue
      }
      if (!event || typeof event !== 'object') continue

      if (event.type === 'session') {
        if (typeof event.id === 'string' && event.id.trim()) sessionId = event.id
        if (typeof event.cwd === 'string' && event.cwd.trim()) {
          project = event.cwd.split(/[\\/]/).filter(Boolean).pop() || '未知项目'
        }
        // seeded fork 会把祖先前缀事件复制进来，前 inheritedEventCount 条不重复计量
        inheritedEvents = toSafeInt(event.inheritedEventCount)
        continue
      }

      if (event.type === 'request/context') {
        const model = event.data?.model
        if (typeof model === 'string' && model.trim()) contextModel = model
        continue
      }

      if (event.type !== 'assistant/message') continue

      const usage = event.data?.usage
      if (!usage || typeof usage !== 'object') continue
      if (inheritedEvents > 0 && toSafeInt(event.seq) < inheritedEvents) continue

      const time = Number(event.time)
      if (!Number.isFinite(time)) continue

      const sourceModel = event.data?.message?.source?.model
      const model = (typeof sourceModel === 'string' && sourceModel.trim())
        ? sourceModel
        : (contextModel || 'unknown')

      const buckets = {
        input: toSafeInt(usage.inputTokens),
        output: toSafeInt(usage.outputTokens),
        cacheRead: toSafeInt(usage.cacheReadTokens),
        cacheCreate: toSafeInt(usage.cacheWriteTokens),
      }
      const total = buckets.input + buckets.output + buckets.cacheRead + buckets.cacheCreate

      const turn = event.data?.turn
      const step = event.data?.step
      // 缺 turn/step 的格式用 seq 兜底，避免不同步的样本被错误合并
      const key = (turn === undefined || step === undefined)
        ? `seq:${toSafeInt(event.seq)}`
        : `${turn}:${step}`

      const current = samples.get(key)
      if (current && current.total >= total) continue

      samples.set(key, { ...buckets, total, time, model })
    }

    for (const sample of samples.values()) {
      if (sample.total <= 0) continue

      const timestamp = new Date(sample.time)
      if (Number.isNaN(timestamp.getTime())) continue
      if (timestamp < start || timestamp >= end) continue

      records.push({
        timestamp,
        model: sample.model,
        project,
        input: sample.input,
        output: sample.output,
        cacheRead: sample.cacheRead,
        cacheCreate: sample.cacheCreate,
        sessionId,
      })
    }
  }

  return records
}
