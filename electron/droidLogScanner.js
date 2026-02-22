/**
 * Droid (Kiro/Factory) 日志扫描模块
 *
 * 负责：
 * - 递归扫描 ~/.factory/sessions/ 下所有 *.settings.json
 * - 按文件修改时间筛选时间窗口
 * - 提取 tokenUsage + model 字段
 *
 * Droid 的用量数据存储在会话级别的 settings.json 中（累计快照），
 * 与 Claude（逐条 JSONL）和 Codex（累计快照 JSONL）不同。
 *
 * @module electron/droidLogScanner
 */

const fs = require('fs/promises')
const path = require('path')

/**
 * 扫描 Droid settings.json 文件并提取 token 用量
 *
 * @param {string} basePath - 扫描根目录（已展开，如 /Users/xxx/.factory/sessions）
 * @param {Date} startTime - 开始时间（包含）
 * @param {Date} endTime - 结束时间（不包含）
 * @param {{maxFiles?: number, maxDepth?: number}} [options] - 扫描选项
 * @returns {Promise<{files: Array<{path: string, mtime: string, data: object}>, totalMatched: number, scannedCount: number, truncated: boolean}>}
 */
async function scanDroidSettingsInRange(basePath, startTime, endTime, options = {}) {
  const maxFiles = typeof options.maxFiles === 'number' ? options.maxFiles : 2000
  const maxDepth = typeof options.maxDepth === 'number' ? options.maxDepth : 5
  const candidates = []
  const files = []

  /**
   * 递归收集候选 settings.json 文件
   * @param {string} currentPath - 当前扫描目录
   * @param {number} depth - 当前递归深度
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

        if (!entry.isFile() || !entry.name.endsWith('.settings.json')) {
          continue
        }

        try {
          const stat = await fs.stat(fullPath)
          const mtime = stat.mtime

          // 半开区间 [start, end)
          if (mtime < startTime || mtime >= endTime) {
            continue
          }

          candidates.push({ path: fullPath, mtime })
        } catch {
          // 单文件 stat 失败时静默跳过
        }
      }
    } catch {
      // 目录不可读/不存在时静默跳过
    }
  }

  await collectCandidates(basePath, 0)

  // 按修改时间倒序，优先读取最近的
  candidates.sort((a, b) => b.mtime.getTime() - a.mtime.getTime())

  const selectedCandidates = candidates.slice(0, maxFiles)
  const truncated = candidates.length > maxFiles

  for (const candidate of selectedCandidates) {
    try {
      const content = await fs.readFile(candidate.path, 'utf-8')
      const data = JSON.parse(content)

      // 只保留包含 tokenUsage 的文件
      if (data && data.tokenUsage) {
        files.push({
          path: candidate.path,
          mtime: candidate.mtime.toISOString(),
          data
        })
      }
    } catch {
      // 单文件读取/解析失败时静默跳过
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
  scanDroidSettingsInRange
}
