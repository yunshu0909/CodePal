/**
 * 日志扫描模块
 *
 * 负责：
 * - 递归收集指定目录下的 `.jsonl` 日志文件
 * - 按文件修改时间做下界预筛，减少无关旧文件读取
 * - 按修改时间倒序读取并限制文件数/行数，避免大目录拖垮进程
 *
 * @module electron/logScanner
 */

const fs = require('fs/promises')
const path = require('path')

/**
 * 扫描并读取可能包含时间窗口记录的日志文件
 * @param {string} basePath - 扫描根目录（已展开）
 * @param {Date} startTime - 开始时间（包含）
 * @param {Date} endTime - 结束时间（不包含）
 * @param {{maxFiles?: number, maxLinesPerFile?: number, maxDepth?: number}} [options] - 扫描选项
 * @returns {Promise<{files: Array<{path: string, lines: string[], mtime: string}>, totalMatched: number, scannedCount: number, truncated: boolean}>}
 */
async function scanLogFilesInRange(basePath, startTime, endTime, options = {}) {
  const maxFiles = typeof options.maxFiles === 'number' ? options.maxFiles : 5000
  const maxLinesPerFile = typeof options.maxLinesPerFile === 'number' ? options.maxLinesPerFile : 10000
  const maxDepth = typeof options.maxDepth === 'number' ? options.maxDepth : 10
  const candidates = []
  const files = []

  /**
   * 截取日志文件末尾的最近 N 行
   * 用量记录天然更关注“最新写入”，读取文件头部会漏掉最近会话的 token_count。
   * @param {string[]} lines - 原始行数组
   * @returns {string[]} 截断后的行数组
   */
  function takeRecentLines(lines) {
    if (!Array.isArray(lines) || maxLinesPerFile <= 0) {
      return []
    }

    if (lines.length <= maxLinesPerFile) {
      return lines
    }

    return lines.slice(-maxLinesPerFile)
  }

  /**
   * 递归收集候选日志文件
   * @param {string} currentPath - 当前扫描目录
   * @param {number} depth - 当前递归深度
   * @returns {Promise<void>}
   */
  async function collectCandidates(currentPath, depth = 0) {
    if (depth > maxDepth) return

    try {
      const entries = await fs.readdir(currentPath, { withFileTypes: true })

      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry.name)

        if (entry.isDirectory()) {
          await collectCandidates(fullPath, depth + 1)
          continue
        }

        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
          continue
        }

        try {
          const stat = await fs.stat(fullPath)
          const mtime = stat.mtime

          // 这里只做下界预筛：只要文件在窗口开始后仍被写过，就可能包含窗口内记录。
          // 不能依赖上界过滤，因为 Claude/Codex 的会话文件可能在窗口结束后的次日继续写入，
          // 但文件内部仍保留窗口内的真实日志；真正的时间窗口应交给逐行 timestamp 精确裁剪。
          if (mtime < startTime) {
            continue
          }

          candidates.push({
            path: fullPath,
            mtime
          })
        } catch {
          // 单文件 stat 失败时静默跳过
        }
      }
    } catch {
      // 目录不可读/不存在时静默跳过
    }
  }

  await collectCandidates(basePath, 0)

  // 优先读取最近更新的文件，避免截断时随机漏算
  candidates.sort((a, b) => b.mtime.getTime() - a.mtime.getTime())

  const selectedCandidates = candidates.slice(0, maxFiles)
  const truncated = candidates.length > maxFiles

  for (const candidate of selectedCandidates) {
    try {
      const content = await fs.readFile(candidate.path, 'utf-8')
      const rawLines = content
        .split('\n')
        .filter(line => line.trim())
      const lines = takeRecentLines(rawLines)

      files.push({
        path: candidate.path,
        lines,
        mtime: candidate.mtime.toISOString()
      })
    } catch {
      // 单文件读取失败时静默跳过，避免影响整体统计
    }
  }

  return {
    files,
    totalMatched: candidates.length,
    scannedCount: selectedCandidates.length,
    truncated
  }
}

module.exports = {
  scanLogFilesInRange
}
