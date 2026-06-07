/**
 * Skill 使用次数扫描服务
 *
 * 负责：
 * - 扫 Claude(~/.claude/projects) + Codex(~/.codex/sessions) 日志
 * - 三信号计数：Claude tool_use(name=Skill) + Claude /slash + Codex $显式
 * - 按 skill 聚合近 N 天调用次数（合计 + 分工具 + 最近使用）
 *
 * 口径与不变量见 specs/skill-使用次数统计/2-design.md：
 * - 不计 Codex SKILL.md 读取（catalog 噪声）与 Codex 隐式调用（无信号）
 * - /slash 与 $ 仅统计「已管理 skill 名」内的，天然滤掉内置命令与 shell 变量
 * - 时间窗按逐行 timestamp 精确裁剪（scanLogFilesInRange 只做文件 mtime 下界预筛）
 *
 * @module electron/services/skillUsageScanService
 */

const path = require('path')

const DAY_MS = 24 * 60 * 60 * 1000
// Claude 手动触发：<command-name>/skill</command-name>
const CMD_RE = /<command-name>\/?([a-zA-Z0-9_-]+)<\/command-name>/
// Codex 显式调用：$skill（首字符为字母，避免匹配 $1 等）
const DOLLAR_RE = /\$([a-zA-Z][a-zA-Z0-9_-]+)/g

/**
 * 扫描单个日志根目录，对每行回调累加
 * @param {string} basePath - 日志根（绝对路径）
 * @param {Date} startTime - 窗口开始
 * @param {Date} endTime - 窗口结束
 * @param {Function} scanFn - scanLogFilesInRange
 * @param {(p:string)=>Promise<boolean>} pathExistsFn - 路径存在判断
 * @param {(line:string)=>void} onLine - 逐行回调
 * @returns {Promise<'ok'|'missing'|'error'>} 该源的可用状态
 */
async function scanRoot(basePath, startTime, endTime, scanFn, pathExistsFn, onLine) {
  if (!(await pathExistsFn(basePath))) return 'missing'
  try {
    // maxLinesPerFile: Infinity —— skill 调用常在对话中段，默认 1 万行截尾会漏算
    const { files } = await scanFn(basePath, startTime, endTime, {
      maxLinesPerFile: Infinity,
      maxFiles: 20000,
    })
    for (const file of files) {
      for (const line of file.lines) onLine(line)
    }
    return 'ok'
  } catch {
    return 'error'
  }
}

/**
 * 统计近 windowDays 天每个 skill 的调用次数（Claude + Codex 合计）
 * @param {object} deps - 注入依赖
 * @param {string} deps.homeDir - 用户主目录
 * @param {Function} deps.scanLogFilesInRangeFn - 日志扫描函数
 * @param {(p:string)=>Promise<boolean>} deps.pathExistsFn - 路径存在判断
 * @param {() => Date} [deps.nowFn] - 当前时间工厂（测试用）
 * @param {object} [params] - 参数
 * @param {number} [params.windowDays=30] - 时间窗天数
 * @param {string[]} [params.skillNames] - 已管理 skill 名（过滤噪声 + 限定统计范围）
 * @returns {Promise<{window:number, startTime:string, endTime:string, skills:Array, totals:object, sources:object}>}
 */
async function scanSkillUsage(deps, params = {}) {
  const { homeDir, scanLogFilesInRangeFn, pathExistsFn, nowFn = () => new Date() } = deps
  const windowDays = typeof params.windowDays === 'number' && params.windowDays > 0 ? params.windowDays : 30
  const nameSet = new Set(Array.isArray(params.skillNames) ? params.skillNames : [])

  const now = nowFn()
  const startTime = new Date(now.getTime() - windowDays * DAY_MS)
  const endTime = now
  const startMs = startTime.getTime()
  const endMs = endTime.getTime()

  // name -> { claude, codex, lastUsed(ms) }
  const acc = new Map()
  const bump = (name, tool, tsMs) => {
    if (!nameSet.has(name)) return
    let e = acc.get(name)
    if (!e) { e = { claude: 0, codex: 0, lastUsed: 0 }; acc.set(name, e) }
    e[tool] += 1
    if (tsMs > e.lastUsed) e.lastUsed = tsMs
  }
  // 逐行时间窗裁剪：仅统计 [startMs, endMs] 内
  const inWindow = (tsMs) => tsMs >= startMs && tsMs <= endMs

  // ── Claude ──
  const claudeStatus = await scanRoot(
    path.join(homeDir, '.claude', 'projects'), startTime, endTime, scanLogFilesInRangeFn, pathExistsFn,
    (line) => {
      let o
      try { o = JSON.parse(line) } catch { return }
      const tsMs = o.timestamp ? Date.parse(o.timestamp) : NaN
      if (!inWindow(tsMs)) return
      // 自主：assistant tool_use name=Skill
      if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
        for (const it of o.message.content) {
          if (it && it.type === 'tool_use' && it.name === 'Skill' && it.input && typeof it.input.skill === 'string') {
            bump(it.input.skill, 'claude', tsMs)
          }
        }
      }
      // 手动：/slash —— 仅用户消息，对消息文本匹配（不跑整行）。
      // 与上面 tool_use 分支用 o.type==='assistant' 守卫对称：assistant 回显/引用
      // <command-name> 时不应被误计为一次手动调用。
      if (o.type === 'user') {
        const c = o.message?.content
        const text = typeof c === 'string'
          ? c
          : Array.isArray(c) ? c.map((x) => (typeof x === 'string' ? x : x?.text || '')).join(' ') : ''
        const m = text.match(CMD_RE)
        if (m) bump(m[1], 'claude', tsMs)
      }
    }
  )

  // ── Codex ──
  const codexStatus = await scanRoot(
    path.join(homeDir, '.codex', 'sessions'), startTime, endTime, scanLogFilesInRangeFn, pathExistsFn,
    (line) => {
      let o
      try { o = JSON.parse(line) } catch { return }
      const tsMs = o.timestamp ? Date.parse(o.timestamp) : NaN
      if (!inWindow(tsMs)) return
      // 显式：$skill —— 仅用户输入消息，对消息文本匹配（不跑整行）。
      // 整行扫描会把 agent 推理 / function_call 命令 / 命令回显 / AGENTS.md 注入里
      // 出现的 $skill 名误计为显式调用（实测虚报约 140%），故必须限定到用户文本。
      let userText = null
      if (o.type === 'event_msg' && o.payload?.type === 'user_message') {
        userText = typeof o.payload.message === 'string' ? o.payload.message : null
      } else if (o.type === 'response_item' && o.payload?.type === 'message' && o.payload?.role === 'user') {
        const c = o.payload.content
        userText = typeof c === 'string'
          ? c
          : Array.isArray(c) ? c.map((x) => (typeof x === 'string' ? x : x?.text || '')).join(' ') : null
      }
      if (userText) {
        let m
        DOLLAR_RE.lastIndex = 0
        while ((m = DOLLAR_RE.exec(userText))) bump(m[1], 'codex', tsMs)
      }
    }
  )

  const skills = []
  let tClaude = 0, tCodex = 0
  for (const [name, e] of acc) {
    skills.push({
      name,
      total: e.claude + e.codex,
      claude: e.claude,
      codex: e.codex,
      lastUsedAt: e.lastUsed ? new Date(e.lastUsed).toISOString() : null,
    })
    tClaude += e.claude
    tCodex += e.codex
  }
  skills.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))

  return {
    window: windowDays,
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString(),
    skills,
    totals: { total: tClaude + tCodex, claude: tClaude, codex: tCodex },
    sources: { claude: claudeStatus, codex: codexStatus },
  }
}

module.exports = { scanSkillUsage }
