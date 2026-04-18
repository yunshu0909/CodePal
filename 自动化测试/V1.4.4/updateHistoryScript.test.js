/**
 * V1.4.4 Python update_history 端到端测试
 *
 * 负责：
 * - 真实渲染 claudeUsageStatusScript.tpl 到临时文件
 * - 用 bash + python3 subprocess 执行，喂不同 payload 验证 history 文件产出
 * - 覆盖分档：同周期 / 异常跳变（<6.5d）/ 正常完成（≈7d）/ 边界 / 长假
 *
 * @module 自动化测试/V1.4.4/updateHistoryScript.test
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const configDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(configDir, '../..')
const TPL_PATH = join(projectRoot, 'electron/services/claudeUsageStatusScript.tpl')
const MAX_CYCLES = 13

const ONE_DAY = 86400
const BASE_RESETS_AT = 1776816000 // 2026-04-22 10:00 UTC（稳定基准时间）

let renderedScript
let tmpDir
let configPath
let snapshotPath
let historyPath
let scriptPath

function escapeForBashDoubleQuote(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`')
}

function renderTemplate(tpl, { configPath, snapshotPath, historyPath, scriptVersion = 6, maxCycles = MAX_CYCLES }) {
  return tpl
    .replace(/__SCRIPT_VERSION__/g, () => String(scriptVersion))
    .replace(/__CONFIG_PATH__/g, () => escapeForBashDoubleQuote(configPath))
    .replace(/__SNAPSHOT_PATH__/g, () => escapeForBashDoubleQuote(snapshotPath))
    .replace(/__HISTORY_PATH__/g, () => escapeForBashDoubleQuote(historyPath))
    .replace(/__MAX_COMPLETED_CYCLES__/g, () => String(maxCycles))
}

function runScript(payload) {
  const result = spawnSync('bash', [scriptPath], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
  })
  if (result.status !== 0) {
    throw new Error(`script exited ${result.status}\nstderr: ${result.stderr}\nstdout: ${result.stdout}`)
  }
  return result
}

function readHistory() {
  if (!existsSync(historyPath)) return null
  return JSON.parse(readFileSync(historyPath, 'utf-8'))
}

function seedHistory(history) {
  writeFileSync(historyPath, JSON.stringify(history))
}

/**
 * 构造 payload，只填 rate_limits 最小必要字段
 */
function makePayload({ weekPct, weekResetsAt, fiveHourPct = 10, fiveHourResetsAt = BASE_RESETS_AT + 3600 }) {
  return {
    model: { id: 'claude-opus-4', display_name: 'Claude Opus 4' },
    transcript_path: '',
    rate_limits: {
      five_hour: {
        used_percentage: fiveHourPct,
        resets_at: fiveHourResetsAt,
      },
      seven_day: {
        used_percentage: weekPct,
        resets_at: weekResetsAt,
      },
    },
  }
}

beforeAll(() => {
  const tpl = readFileSync(TPL_PATH, 'utf-8')
  const baseDir = mkdtempSync(join(tmpdir(), 'codepal-test-base-'))
  configPath = join(baseDir, 'config.json')
  snapshotPath = join(baseDir, 'snapshot.json')
  historyPath = join(baseDir, 'history.json')
  scriptPath = join(baseDir, 'status.sh')
  renderedScript = renderTemplate(tpl, { configPath, snapshotPath, historyPath })
  writeFileSync(scriptPath, renderedScript)
  tmpDir = baseDir
})

beforeEach(() => {
  if (existsSync(historyPath)) rmSync(historyPath)
  if (existsSync(snapshotPath)) rmSync(snapshotPath)
  // 保留 config 默认缺失，让脚本走 DEFAULT_CONFIG
})

describe('update_history - 无 prev 初始化', () => {
  it('第一次写入 → 只建 currentCycle，不产生 completedCycles', () => {
    runScript(makePayload({ weekPct: 10, weekResetsAt: BASE_RESETS_AT }))
    const h = readHistory()
    expect(h.currentCycle.sevenDayResetsAt).toBe(BASE_RESETS_AT)
    expect(h.currentCycle.periodStart).toBe(BASE_RESETS_AT - 7 * ONE_DAY)
    expect(h.currentCycle.peakPercentage).toBe(10)
    expect(h.completedCycles).toEqual([])
  })
})

describe('update_history - 同周期更新峰值', () => {
  it('同一 sevenDayResetsAt，peak 上升 → 取大值', () => {
    seedHistory({
      version: 1,
      currentCycle: {
        periodStart: BASE_RESETS_AT - 7 * ONE_DAY,
        sevenDayResetsAt: BASE_RESETS_AT,
        peakPercentage: 10,
      },
      completedCycles: [],
    })
    runScript(makePayload({ weekPct: 25, weekResetsAt: BASE_RESETS_AT }))
    const h = readHistory()
    expect(h.currentCycle.peakPercentage).toBe(25)
    expect(h.completedCycles.length).toBe(0)
  })

  it('同一 sevenDayResetsAt，peak 下降 → 保留旧的', () => {
    seedHistory({
      version: 1,
      currentCycle: {
        periodStart: BASE_RESETS_AT - 7 * ONE_DAY,
        sevenDayResetsAt: BASE_RESETS_AT,
        peakPercentage: 50,
      },
      completedCycles: [],
    })
    runScript(makePayload({ weekPct: 5, weekResetsAt: BASE_RESETS_AT }))
    const h = readHistory()
    expect(h.currentCycle.peakPercentage).toBe(50)
  })
})

describe('update_history - 正常 7 天周期完成', () => {
  it('delta = 7 天 → 正常封存，无 anomaly 字段', () => {
    seedHistory({
      version: 1,
      currentCycle: {
        periodStart: BASE_RESETS_AT - 7 * ONE_DAY,
        sevenDayResetsAt: BASE_RESETS_AT,
        peakPercentage: 66,
      },
      completedCycles: [],
    })
    const newResets = BASE_RESETS_AT + 7 * ONE_DAY
    runScript(makePayload({ weekPct: 5, weekResetsAt: newResets }))
    const h = readHistory()
    expect(h.currentCycle.sevenDayResetsAt).toBe(newResets)
    expect(h.currentCycle.peakPercentage).toBe(5) // 新 peak 不继承
    expect(h.completedCycles.length).toBe(1)
    const sealed = h.completedCycles[0]
    expect(sealed.periodEnd).toBe(BASE_RESETS_AT)
    expect(sealed.peakPercentage).toBe(66)
    expect(sealed.anomaly).toBeUndefined()
  })

  it('delta > 7 天（长假）→ 按正常封存处理', () => {
    seedHistory({
      version: 1,
      currentCycle: {
        periodStart: BASE_RESETS_AT - 7 * ONE_DAY,
        sevenDayResetsAt: BASE_RESETS_AT,
        peakPercentage: 88,
      },
      completedCycles: [],
    })
    const newResets = BASE_RESETS_AT + 14 * ONE_DAY
    runScript(makePayload({ weekPct: 3, weekResetsAt: newResets }))
    const h = readHistory()
    expect(h.completedCycles.length).toBe(1)
    expect(h.completedCycles[0].anomaly).toBeUndefined()
  })
})

describe('update_history - 异常跳变（Anthropic provider_reset）', () => {
  it('delta = 2 天 → 封存为异常，periodEnd 夹到新 current 起点', () => {
    seedHistory({
      version: 1,
      currentCycle: {
        periodStart: BASE_RESETS_AT - 7 * ONE_DAY,
        sevenDayResetsAt: BASE_RESETS_AT,
        peakPercentage: 25,
      },
      completedCycles: [],
    })
    const newResets = BASE_RESETS_AT + 2 * ONE_DAY
    runScript(makePayload({ weekPct: 10, weekResetsAt: newResets }))
    const h = readHistory()
    // 新 currentCycle：peak 是真实的 10%，不继承 25%
    expect(h.currentCycle.sevenDayResetsAt).toBe(newResets)
    expect(h.currentCycle.peakPercentage).toBe(10)
    expect(h.currentCycle.periodStart).toBe(newResets - 7 * ONE_DAY)
    // 异常条目：periodEnd 夹到新 current 起点，避免重叠
    expect(h.completedCycles.length).toBe(1)
    const sealed = h.completedCycles[0]
    expect(sealed.anomaly).toBe(true)
    expect(sealed.anomalyReason).toBe('provider_reset')
    expect(sealed.periodEnd).toBe(newResets - 7 * ONE_DAY)
    expect(sealed.peakPercentage).toBe(25)
  })

  it('delta = 1 小时 → 仍按异常处理', () => {
    seedHistory({
      version: 1,
      currentCycle: {
        periodStart: BASE_RESETS_AT - 7 * ONE_DAY,
        sevenDayResetsAt: BASE_RESETS_AT,
        peakPercentage: 33,
      },
      completedCycles: [],
    })
    const newResets = BASE_RESETS_AT + 3600
    runScript(makePayload({ weekPct: 5, weekResetsAt: newResets }))
    const h = readHistory()
    expect(h.completedCycles.length).toBe(1)
    expect(h.completedCycles[0].anomaly).toBe(true)
  })

  it('delta = 6 天（边界，< 6.5 天）→ 异常', () => {
    seedHistory({
      version: 1,
      currentCycle: {
        periodStart: BASE_RESETS_AT - 7 * ONE_DAY,
        sevenDayResetsAt: BASE_RESETS_AT,
        peakPercentage: 55,
      },
      completedCycles: [],
    })
    const newResets = BASE_RESETS_AT + 6 * ONE_DAY
    runScript(makePayload({ weekPct: 8, weekResetsAt: newResets }))
    const h = readHistory()
    expect(h.completedCycles[0].anomaly).toBe(true)
  })

  it('delta = 7 天整 → 正常，不异常', () => {
    seedHistory({
      version: 1,
      currentCycle: {
        periodStart: BASE_RESETS_AT - 7 * ONE_DAY,
        sevenDayResetsAt: BASE_RESETS_AT,
        peakPercentage: 70,
      },
      completedCycles: [],
    })
    const newResets = BASE_RESETS_AT + 7 * ONE_DAY
    runScript(makePayload({ weekPct: 8, weekResetsAt: newResets }))
    const h = readHistory()
    expect(h.completedCycles[0].anomaly).toBeUndefined()
  })
})

describe('update_history - MAX_COMPLETED_CYCLES 裁剪', () => {
  it('超过 13 条 → 保留最新 13 条', () => {
    const completed = []
    for (let i = 0; i < 13; i++) {
      completed.push({
        periodStart: BASE_RESETS_AT - (i + 2) * 7 * ONE_DAY,
        periodEnd: BASE_RESETS_AT - (i + 1) * 7 * ONE_DAY,
        peakPercentage: 50 + i,
      })
    }
    seedHistory({
      version: 1,
      currentCycle: {
        periodStart: BASE_RESETS_AT - 7 * ONE_DAY,
        sevenDayResetsAt: BASE_RESETS_AT,
        peakPercentage: 99,
      },
      completedCycles: completed,
    })
    const newResets = BASE_RESETS_AT + 7 * ONE_DAY
    runScript(makePayload({ weekPct: 0, weekResetsAt: newResets }))
    const h = readHistory()
    // 插入 1 条到 head，原来 13 条的最后一条被裁掉 → 仍然 13 条
    expect(h.completedCycles.length).toBe(13)
    // head 是本次新封存的：peak = 99
    expect(h.completedCycles[0].peakPercentage).toBe(99)
  })
})

describe('update_history - 真实用户场景（2 天 Anthropic reset）', () => {
  it('模拟用户 4/22→4/24 跳变后，peak 不被污染', () => {
    const t422 = 1776816000 // 4/22 10:00
    const t424 = t422 + 2 * ONE_DAY

    // 初始：4/15→4/22 周期，peak 25%
    seedHistory({
      version: 1,
      currentCycle: {
        periodStart: t422 - 7 * ONE_DAY,
        sevenDayResetsAt: t422,
        peakPercentage: 25,
      },
      completedCycles: [
        { periodStart: t422 - 14 * ONE_DAY, periodEnd: t422 - 7 * ONE_DAY, peakPercentage: 66 },
      ],
    })

    // Anthropic reset：payload 的 resets_at 跳到 4/24，当前 week_pct 为 10%
    runScript(makePayload({ weekPct: 10, weekResetsAt: t424 }))

    const h = readHistory()
    // 新 current：4/17→4/24, 10%
    expect(h.currentCycle.sevenDayResetsAt).toBe(t424)
    expect(h.currentCycle.periodStart).toBe(t424 - 7 * ONE_DAY)
    expect(h.currentCycle.peakPercentage).toBe(10)
    // completedCycles[0] 是异常封存：periodEnd = 新 current start = t424 - 7d
    expect(h.completedCycles[0].anomaly).toBe(true)
    expect(h.completedCycles[0].peakPercentage).toBe(25)
    expect(h.completedCycles[0].periodEnd).toBe(t424 - 7 * ONE_DAY)
    // 历史的原正常条目还在
    expect(h.completedCycles[1].peakPercentage).toBe(66)
    expect(h.completedCycles[1].anomaly).toBeUndefined()
  })
})
