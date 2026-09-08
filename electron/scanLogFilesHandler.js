/**
 * 日志扫描 IPC 处理器
 *
 * 负责：
 * - 校验日志扫描参数
 * - 处理目录不存在的降级返回
 * - 统一权限异常的错误码输出
 *
 * @module electron/scanLogFilesHandler
 */

const path = require('path')
const fs = require('fs/promises')
const os = require('os')
const { scanLogFilesInRange } = require('./logScanner')

/**
 * 将路径中的 ~ 展开为用户主目录
 * @param {string} filepath - 原始路径
 * @returns {string}
 */
function expandHomePath(filepath) {
  if (filepath.startsWith('~/')) {
    return path.join(os.homedir(), filepath.slice(2))
  }
  return filepath
}

/**
 * 检查目录是否存在
 * @param {string} filepath - 目录路径
 * @returns {Promise<boolean>}
 */
async function pathExists(filepath) {
  try {
    await fs.access(filepath)
    return true
  } catch {
    return false
  }
}

/**
 * 处理 scan-log-files IPC 请求
 * @param {{basePath?: string, start?: string, end?: string}} params - 扫描参数
 * @param {{expandHomeFn?: function, pathExistsFn?: function, scanLogFilesInRangeFn?: function}} [deps] - 依赖注入（测试用）
 * @returns {Promise<{success: boolean, files: Array, totalMatched: number, scannedCount: number, truncated: boolean, error: string|null}>}
 */
async function handleScanLogFiles(params, deps = {}) {
  const expandHomeFn = deps.expandHomeFn || expandHomePath
  const pathExistsFn = deps.pathExistsFn || pathExists
  const scanLogFilesInRangeFn = deps.scanLogFilesInRangeFn || scanLogFilesInRange

  try {
    const { basePath, start, end } = params || {}

    if (typeof basePath !== 'string' || !basePath) {
      return {
        success: false,
        files: [],
        totalMatched: 0,
        scannedCount: 0,
        truncated: false,
        error: 'INVALID_PATH'
      }
    }

    const expandedPath = expandHomeFn(basePath)
    const startTime = new Date(start)
    const endTime = new Date(end)

    // 目录不存在时走“成功 + 空数据”降级路径，避免首次使用场景报错
    const exists = await pathExistsFn(expandedPath)
    if (!exists) {
      return {
        success: true,
        files: [],
        totalMatched: 0,
        scannedCount: 0,
        truncated: false,
        error: null
      }
    }

    // 只为 Codex 用量归属保留完整上下文；通用日志预览的限制不变。
    const usageOptions = params?.purpose === 'usage-model-attribution' && basePath === '~/.codex/sessions'
      ? { codexUsageOnly: true } : undefined
    const scanResult = usageOptions
      ? await scanLogFilesInRangeFn(expandedPath, startTime, endTime, usageOptions)
      : await scanLogFilesInRangeFn(expandedPath, startTime, endTime)

    return {
      success: true,
      files: scanResult.files || [],
      totalMatched: scanResult.totalMatched || 0,
      scannedCount: scanResult.scannedCount || 0,
      truncated: Boolean(scanResult.truncated),
      error: null
    }
  } catch (error) {
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      return {
        success: false,
        files: [],
        totalMatched: 0,
        scannedCount: 0,
        truncated: false,
        error: 'PERMISSION_DENIED'
      }
    }

    return {
      success: false,
      files: [],
      totalMatched: 0,
      scannedCount: 0,
      truncated: false,
      error: error.message
    }
  }
}

module.exports = {
  handleScanLogFiles
}
