/* @vitest-environment node */
/**
 * DSH 用量记录构造器测试（TC-02 ~ TC-06）
 *
 * 覆盖：同 (turn,step) 去重与 stream chunk 不叠加、同目录双代日志择代、
 * **legacy-only 目录必须计入**、事件时间精确保留并按北京时间分桶、
 * 项目归属取 header cwd 末段、子会话（delegationDepth=1）与 seeded fork 不重复计量、
 * 以及真实语料里 usage **不含 cacheWriteTokens** 时不得产出 NaN。
 *
 * 全部用构造的日志行做 fixture，不读真实 ~/.dsh。
 *
 * @module tests/dshUsageRecords
 */

import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { collectDshUsageRecords, selectHighestGenerationFiles } from '../electron/services/dshUsageRecords.mjs'

const require = createRequire(import.meta.url)
const { dayKey: getBeijingDayKey } = require('../electron/services/sharedUsageStatistics')

const WINDOW_START = new Date('2026-08-01T00:00:00+08:00')
const WINDOW_END = new Date('2026-09-01T00:00:00+08:00')
/** 窗口内的时间基准（北京 2026-08-13 10:00）；不能用 1970 附近的毫秒数，否则会被窗口裁掉 */
const BASE = Date.parse('2026-08-13T10:00:00+08:00')
const at = (seconds) => BASE + seconds * 1000

/** 构造一条会话事件行 */
function line(payload) {
  return JSON.stringify(payload)
}

/** 构造 header 行 */
function header({ id = 'session-test', cwd = '/Users/u/Documents/proj-a', depth = 0, parent = undefined } = {}) {
  const base = { type: 'session', version: 3, id, cwd, isSeeded: false, delegationDepth: depth }
  return line(parent ? { ...base, parentSession: parent } : base)
}

/** 构造 legacy 代（version 0）的 header 行 */
function legacyHeader({ id = 'session-legacy', cwd = '/Users/u/Documents/proj-legacy' } = {}) {
  return line({ type: 'session', version: 0, id, cwd })
}

/**
 * 构造 assistant/message 行
 * @param {{streamChunk?: boolean, omitCacheWrite?: boolean}} [options] - streamChunk 追加流式副本；omitCacheWrite 模拟真实语料（usage 无 cacheWriteTokens 键）
 */
function assistantMessage({ turn, step, time, model = 'deepseek-v4-flash', usage, streamChunk = false, omitCacheWrite = false }) {
  const data = {
    turn,
    step,
    message: { role: 'assistant', content: [], source: model === null ? {} : { provider: 'deepseek-official', model } },
    usage,
  }
  if (omitCacheWrite && usage && typeof usage === 'object') {
    const { cacheWriteTokens, ...rest } = usage
    data.usage = rest
  }
  if (streamChunk) data.stream = [{ chunk: { type: 'usage', usage: { ...data.usage, inputTokens: 1, outputTokens: 1 } } }]
  return line({ type: 'assistant/message', seq: 1, time, data })
}

const u = (input, output, cacheRead) => ({ inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: 0 })

function file(path, lines) {
  return { path, lines }
}

describe('TC-02 同 (turn,step) 去重且不叠加 stream chunk', () => {
  it('同一 (turn,step) 的多个样本只计一次，取合计最大者', () => {
    const lines = [
      header(),
      assistantMessage({ turn: 1, step: 1, time: at(0), usage: u(100, 10, 500) }),
      assistantMessage({ turn: 1, step: 1, time: at(2), usage: u(400, 20, 900) }), // 同组更晚且更大
      assistantMessage({ turn: 1, step: 2, time: at(4), usage: u(50, 5, 100) }),
    ]
    const records = collectDshUsageRecords([file('/d/session-a/session.v3.jsonl.zstd', lines)], WINDOW_START, WINDOW_END)

    expect(records).toHaveLength(2)
    // 「取第一条」会得到 100；必须得到更大的 400，用例才具备判别力
    expect(records[0]).toMatchObject({ input: 400, output: 20, cacheRead: 900 })
    expect(records[1]).toMatchObject({ input: 50, output: 5, cacheRead: 100 })
  })

  it('同事件 data.stream 内的 usage chunk 不被叠加', () => {
    const plain = collectDshUsageRecords(
      [file('/d/session-a/session.v3.jsonl.zstd', [header(), assistantMessage({ turn: 1, step: 1, time: at(0), usage: u(100, 10, 500) })])],
      WINDOW_START,
      WINDOW_END,
    )
    const withChunk = collectDshUsageRecords(
      [file('/d/session-a/session.v3.jsonl.zstd', [header(), assistantMessage({ turn: 1, step: 1, time: at(0), usage: u(100, 10, 500), streamChunk: true })])],
      WINDOW_START,
      WINDOW_END,
    )

    expect(withChunk).toEqual(plain)
  })

  it('无 usage 的 assistant/message 被跳过，不计为 0 也不产生记录', () => {
    const lines = [
      header(),
      assistantMessage({ turn: 1, step: 1, time: at(0), usage: undefined }),
      assistantMessage({ turn: 1, step: 2, time: at(4), usage: u(50, 5, 100) }),
    ]
    const records = collectDshUsageRecords([file('/d/session-a/session.v3.jsonl.zstd', lines)], WINDOW_START, WINDOW_END)

    expect(records).toHaveLength(1)
    expect(records[0].input).toBe(50)
  })

  it('真实语料形态：usage 无 cacheWriteTokens 键时产出 0 而非 NaN', () => {
    // 实测 76 个日志的 usage 只含 inputTokens/outputTokens/cacheReadTokens/reasoningTokens/totalTokens；
    // 一旦产出 NaN，renderer 的 calculateTotalTokens 会把整条模型滤掉（今日不含 DSH）
    const records = collectDshUsageRecords(
      [file('/d/session-a/session.v3.jsonl.zstd', [header(), assistantMessage({ turn: 1, step: 1, time: at(0), usage: u(100, 10, 500), omitCacheWrite: true })])],
      WINDOW_START,
      WINDOW_END,
    )

    expect(records).toHaveLength(1)
    expect(records[0].cacheCreate).toBe(0)
    expect(Number.isNaN(records[0].cacheCreate)).toBe(false)
    for (const field of ['input', 'output', 'cacheRead', 'cacheCreate']) {
      expect(Number.isFinite(records[0][field])).toBe(true)
    }
  })
})

describe('TC-03 同目录双代日志只读最高代；legacy-only 目录必须计入', () => {
  it('selectHighestGenerationFiles 只保留每个目录的最高代', () => {
    const files = [
      file('/d/session-x/session.jsonl.zstd', []),
      file('/d/session-x/session.v3.jsonl.zstd', []),
      file('/d/session-y/session.jsonl.zstd', []),
    ]
    const picked = selectHighestGenerationFiles(files).map(item => item.path)

    expect(picked).toEqual(['/d/session-x/session.v3.jsonl.zstd', '/d/session-y/session.jsonl.zstd'])
  })

  it('用量不因两代并存而翻倍', () => {
    const lines = [header({ id: 'session-x' }), assistantMessage({ turn: 1, step: 1, time: at(0), usage: u(100, 10, 500) })]
    const records = collectDshUsageRecords(
      [file('/d/session-x/session.jsonl.zstd', lines), file('/d/session-x/session.v3.jsonl.zstd', lines)],
      WINDOW_START,
      WINDOW_END,
    )

    expect(records).toHaveLength(1)
    expect(records[0].input).toBe(100)
  })

  it('只有 legacy 日志（session.jsonl.zstd，version 0）的目录必须计入', () => {
    // 实测 08-13/14/15/16 四天 100% 来自 legacy 日志（约 1.79 亿 token）；
    // 只处理 v3 的实现会让这四天凭空消失
    const records = collectDshUsageRecords(
      [
        file('/d/session-legacy/session.jsonl.zstd', [
          legacyHeader(),
          assistantMessage({ turn: 1, step: 1, time: at(0), usage: u(700, 70, 7000) }),
        ]),
      ],
      WINDOW_START,
      WINDOW_END,
    )

    expect(records).toHaveLength(1)
    expect(records[0].input).toBe(700)
    expect(records[0].project).toBe('proj-legacy')
  })
})

describe('TC-04 事件时间精确保留并按北京时间分桶', () => {
  it('timestamp 等于事件 time 的毫秒时刻', () => {
    const eventTime = at(3)
    const records = collectDshUsageRecords(
      [file('/d/session-a/session.v3.jsonl.zstd', [header(), assistantMessage({ turn: 1, step: 1, time: eventTime, usage: u(1, 1, 1) })])],
      WINDOW_START,
      WINDOW_END,
    )

    expect(records[0].timestamp).toBeInstanceOf(Date)
    expect(records[0].timestamp.getTime()).toBe(eventTime)
  })

  it('跨午夜会话的用量落到各自所属的北京日期', () => {
    // 2026-08-13T15:59:00Z = 北京 23:59；2026-08-13T16:01:00Z = 北京次日 00:01
    const lateNight = Date.parse('2026-08-13T15:59:00Z')
    const afterMidnight = Date.parse('2026-08-13T16:01:00Z')
    const records = collectDshUsageRecords(
      [
        file('/d/session-a/session.v3.jsonl.zstd', [
          header(),
          assistantMessage({ turn: 1, step: 1, time: lateNight, usage: u(10, 1, 100) }),
          assistantMessage({ turn: 1, step: 2, time: afterMidnight, usage: u(20, 2, 200) }),
        ]),
      ],
      WINDOW_START,
      WINDOW_END,
    )

    const days = records.map(record => getBeijingDayKey(record.timestamp)).sort()
    expect(days).toEqual(['2026-08-13', '2026-08-14'])
  })

  it('窗口外的记录被排除（含边界：start 含、end 不含）', () => {
    const inside = Date.parse('2026-08-13T00:00:00+08:00')
    const atEnd = Date.parse('2026-09-01T00:00:00+08:00')
    const records = collectDshUsageRecords(
      [
        file('/d/session-a/session.v3.jsonl.zstd', [
          header(),
          assistantMessage({ turn: 1, step: 1, time: inside, usage: u(10, 1, 100) }),
          assistantMessage({ turn: 1, step: 2, time: atEnd, usage: u(20, 2, 200) }),
        ]),
      ],
      WINDOW_START,
      WINDOW_END,
    )

    expect(records).toHaveLength(1)
    expect(records[0].input).toBe(10)
  })
})

describe('TC-05 项目归属取 header cwd 末段', () => {
  it('cwd 末段作为项目名', () => {
    const records = collectDshUsageRecords(
      [file('/d/session-a/session.v3.jsonl.zstd', [header({ cwd: '/Users/u/Documents/proj-a' }), assistantMessage({ turn: 1, step: 1, time: at(0), usage: u(1, 1, 1) })])],
      WINDOW_START,
      WINDOW_END,
    )

    expect(records[0].project).toBe('proj-a')
  })

  it('无 cwd 时归「未知项目」，不从目录 slug 反推', () => {
    const lines = [line({ type: 'session', version: 3, id: 'session-a' }), assistantMessage({ turn: 1, step: 1, time: at(0), usage: u(1, 1, 1) })]
    const records = collectDshUsageRecords([file('/d/--Users-u-projects-ghost--/session-a/session.v3.jsonl.zstd', lines)], WINDOW_START, WINDOW_END)

    expect(records[0].project).toBe('未知项目')
  })
})

describe('TC-06 子会话作为独立会话计入', () => {
  it('父会话与子会话用量都计入，总量等于两者之和', () => {
    const parent = file('/d/parent/session.v3.jsonl.zstd', [
      header({ id: 'session-parent', depth: 0 }),
      assistantMessage({ turn: 1, step: 1, time: at(0), usage: u(100, 10, 500) }),
    ])
    const child = file('/d/child/session.v3.jsonl.zstd', [
      header({ id: 'session-child', depth: 1, parent: 'session-parent' }),
      assistantMessage({ turn: 1, step: 1, time: at(1), usage: u(30, 3, 70) }),
    ])

    const records = collectDshUsageRecords([parent, child], WINDOW_START, WINDOW_END)
    const totalInput = records.reduce((sum, record) => sum + record.input, 0)

    expect(records).toHaveLength(2)
    expect(totalInput).toBe(130)
    expect(new Set(records.map(record => record.sessionId))).toEqual(new Set(['session-parent', 'session-child']))
  })

  it('seeded fork 继承的祖先前缀事件不重复计量', () => {
    // inheritedEventCount 之前的事件是父会话前缀的复制，不属于本次会话的消耗
    const seeded = file('/d/child/session.v3.jsonl.zstd', [
      JSON.stringify({ type: 'session', version: 3, id: 'session-child', cwd: '/Users/u/Documents/proj-a', isSeeded: true, delegationDepth: 1, inheritedEventCount: 2 }),
      JSON.stringify({ type: 'assistant/message', seq: 0, time: at(0), data: { turn: 1, step: 1, message: { source: { model: 'deepseek-v4-flash' } }, usage: u(999, 99, 9999) } }),
      JSON.stringify({ type: 'assistant/message', seq: 1, time: at(1), data: { turn: 1, step: 2, message: { source: { model: 'deepseek-v4-flash' } }, usage: u(888, 88, 8888) } }),
      JSON.stringify({ type: 'assistant/message', seq: 2, time: at(2), data: { turn: 2, step: 1, message: { source: { model: 'deepseek-v4-flash' } }, usage: u(30, 3, 70) } }),
    ])

    const records = collectDshUsageRecords([seeded], WINDOW_START, WINDOW_END)

    expect(records).toHaveLength(1)
    expect(records[0].input).toBe(30)
  })
})

describe('模型归属', () => {
  it('取 data.message.source.model', () => {
    const records = collectDshUsageRecords(
      [file('/d/session-a/session.v3.jsonl.zstd', [header(), assistantMessage({ turn: 1, step: 1, time: at(0), model: 'glm-5.3', usage: u(1, 1, 1) })])],
      WINDOW_START,
      WINDOW_END,
    )

    expect(records[0].model).toBe('glm-5.3')
  })

  it('source 缺失时回退最近的 request/context 模型，仍缺失则 unknown', () => {
    const withContext = [
      header(),
      line({ type: 'request/context', seq: 1, time: at(0), data: { model: 'deepseek-v4-pro' } }),
      assistantMessage({ turn: 1, step: 1, time: at(1), model: null, usage: u(1, 1, 1) }),
    ]
    const records = collectDshUsageRecords([file('/d/session-a/session.v3.jsonl.zstd', withContext)], WINDOW_START, WINDOW_END)
    expect(records[0].model).toBe('deepseek-v4-pro')

    const noContext = [header(), assistantMessage({ turn: 1, step: 1, time: at(0), model: null, usage: u(1, 1, 1) })]
    const fallback = collectDshUsageRecords([file('/d/session-a/session.v3.jsonl.zstd', noContext)], WINDOW_START, WINDOW_END)
    expect(fallback[0].model).toBe('unknown')
  })
})
