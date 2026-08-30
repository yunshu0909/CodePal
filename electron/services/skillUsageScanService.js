/**
 * Skill 使用统计扫描服务
 *
 * 负责：
 * - 兼容旧 `aggregate-skill-usage` 调用方
 * - 触发 invocation scanner 并幂等 upsert v2 ledger
 * - 从 ledger 按 skill 聚合近 N 天有效调用（合计 + 分工具 + 最近使用）
 *
 * 口径与不变量见 specs/skill-使用次数统计/2-design.md：
 * - 不计 Codex SKILL.md 读取（catalog 噪声）与 Codex 隐式调用（无信号）
 * - /slash 与 $ 仅统计「已管理 skill 名」内的，天然滤掉内置命令与 shell 变量
 * - 时间窗按逐行 timestamp 精确裁剪（scanLogFilesInRange 只做文件 mtime 下界预筛）
 *
 * @module electron/services/skillUsageScanService
 */

const { scanSkillRunSamples } = require('./skillRunSampleService')

/**
 * 统计近 windowDays 天每个 Skill 的已记录有效调用（Claude + Codex 合计）
 * @param {object} deps - 注入依赖
 * @param {string} deps.homeDir - 用户主目录
 * @param {(p:string)=>Promise<boolean>} deps.pathExistsFn - 路径存在判断
 * @param {() => Date} [deps.nowFn] - 当前时间工厂（测试用）
 * @param {object} [params] - 参数
 * @param {number} [params.windowDays=30] - 时间窗天数
 * @param {string[]} [params.skillNames] - 已管理 skill 名（过滤噪声 + 限定统计范围）
 * @returns {Promise<{window:number, startTime:string, endTime:string, skills:Array, totals:object, sources:object, scanMeta:object, ledgerPath:string}>}
 */
async function scanSkillUsage(deps, params = {}) {
  const result = await scanSkillRunSamples(deps, params)
  return {
    window: result.window,
    startTime: result.startTime,
    endTime: result.endTime,
    skills: result.skills,
    totals: result.totals,
    sources: result.sources,
    scanMeta: result.scanMeta,
  }
}

module.exports = { scanSkillUsage }
