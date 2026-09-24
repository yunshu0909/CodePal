/**
 * 用量日志扫描与解析服务（门面）
 *
 * 负责：
 * - 统一对外导出各数据源的扫描 / 解析函数（实现按数据源放在 ./usageLogScan/ 下：common、claude、codex、dsh）
 * - 跨三个数据源的「最早用量日期」探测
 *
 * B2-8 从 1151 行单文件按数据源拆出；调用方继续 require 本模块，行为不变。
 *
 * @module electron/services/usageLogScanService
 */

const path = require('path')
const os = require('os')
const { readClaudeUsageLines } = require('../logScanner')
const common = require('./usageLogScan/common')
const claude = require('./usageLogScan/claude')
const codex = require('./usageLogScan/codex')
const dsh = require('./usageLogScan/dsh')
const { pathExists } = common
const { findEarliestClaudeDate } = claude
const { findEarliestCodexDate } = codex
const { findEarliestDshDate } = dsh

/**
 * 找 Claude/Codex 日志中最早的日期（北京时区）。
 * 用于「累计至今」周期的动态起点，避免对新装机用户从 2020-01-01 空扫几千天。
 * @param {object} [deps] - 依赖注入（测试用）
 * @returns {Promise<string|null>} YYYY-MM-DD 或 null（两边都没数据）
 */
async function findEarliestLogDate(deps = {}) {
  const pathExistsFn = deps.pathExistsFn || pathExists
  const homeDir = deps.homeDir || os.homedir()
  const findClaudeFn = deps.findEarliestClaudeDateFn || findEarliestClaudeDate
  const findCodexFn = deps.findEarliestCodexDateFn || findEarliestCodexDate
  const findDshFn = deps.findEarliestDshDateFn || findEarliestDshDate

  const claudeBasePath = path.join(homeDir, '.claude', 'projects')
  const codexBasePath = path.join(homeDir, '.codex', 'sessions')
  const dshBasePath = path.join(homeDir, '.dsh', 'sessions')

  const [claudeExists, codexExists, dshExists] = await Promise.all([
    pathExistsFn(claudeBasePath),
    pathExistsFn(codexBasePath),
    pathExistsFn(dshBasePath)
  ])

  const [claudeDate, codexDate, dshDate] = await Promise.all([
    claudeExists ? findClaudeFn(claudeBasePath, deps).catch(() => null) : Promise.resolve(null),
    codexExists ? findCodexFn(codexBasePath, deps).catch(() => null) : Promise.resolve(null),
    dshExists ? findDshFn(dshBasePath, deps).catch(() => null) : Promise.resolve(null)
  ])

  // DSH 进不了起点探测，它早于另外两源的用量就会被累计至今静默漏算
  const dates = [claudeDate, codexDate, dshDate].filter(Boolean)
  if (dates.length === 0) return null
  return dates.reduce((earliest, current) => (current < earliest ? current : earliest))
}

module.exports = {
  toSafeInt: common.toSafeInt,
  normalizeModelName: common.normalizeModelName,
  parseClaudeLog: claude.parseClaudeLog,
  parseCodexTokenSnapshot: codex.parseCodexTokenSnapshot,
  parseCodexRateLimits: codex.parseCodexRateLimits,
  extractCodexSessionId: codex.extractCodexSessionId,
  pickCodexMaxSnapshot: codex.pickCodexMaxSnapshot,
  pickLatestClaudeRecord: claude.pickLatestClaudeRecord,
  scanClaudeLogs: claude.scanClaudeLogs,
  scanCodexLogs: codex.scanCodexLogs,
  aggregateByModel: common.aggregateByModel,
  aggregateByProject: common.aggregateByProject,
  pathExists: common.pathExists,
  toBeijingDateKey: common.toBeijingDateKey,
  findFirstCodexUsageTimestampInFile: codex.findFirstCodexUsageTimestampInFile,
  findEarliestCodexDate: codex.findEarliestCodexDate,
  findFirstClaudeTimestampInFile: claude.findFirstClaudeTimestampInFile,
  listJsonlFilesRecursive: common.listJsonlFilesRecursive,
  findEarliestClaudeDate: claude.findEarliestClaudeDate,
  scanDshLogs: dsh.scanDshLogs,
  scanDshLogsInProcess: dsh.scanDshLogsInProcess,
  setDshIsolatedRunner: dsh.setDshIsolatedRunner,
  readClaudeUsageLines,
  listDshSessionLogs: dsh.listDshSessionLogs,
  iterateDshLines: dsh.iterateDshLines,
  findEarliestDshDate: dsh.findEarliestDshDate,
  findEarliestLogDate,
}
