/**
 * .env 文件操作服务
 *
 * 负责：
 * - 读取项目 .env 文件
 * - 合并供应商环境变量（.env 优先，process.env 补齐）
 * - .env 变量的增删改
 * - 原子写入文本文件
 *
 * @module electron/services/envFileService
 */

const fs = require('fs/promises')
const path = require('path')
const dotenv = require('dotenv')

/**
 * 规范化环境变量值
 * @param {unknown} value - 原始值
 * @returns {string|null}
 */
function normalizeEnvValue(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

/**
 * 转义 .env 值，避免特殊字符破坏解析
 * @param {string} value - 原始值
 * @returns {string}
 */
function quoteEnvValue(value) {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
  return `"${escaped}"`
}

/**
 * 更新或追加指定的 .env 变量
 * @param {string} envContent - 原始 .env 内容
 * @param {string} key - 变量名
 * @param {string} value - 变量值
 * @returns {string} 新的 .env 内容
 */
function upsertEnvVariable(envContent, key, value) {
  const keyPattern = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`)
  const lines = envContent ? envContent.split(/\r?\n/) : []
  const nextLine = `${key}=${quoteEnvValue(value)}`

  let replaced = false
  const updatedLines = lines.map((line) => {
    if (!replaced && keyPattern.test(line)) {
      replaced = true
      return nextLine
    }
    return line
  })

  // 追加前保留一行空行，便于区分"手写配置"与"应用写入配置"。
  if (!replaced) {
    const hasAnyLine = updatedLines.some((line) => line.length > 0)
    if (hasAnyLine && updatedLines[updatedLines.length - 1] !== '') {
      updatedLines.push('')
    }
    updatedLines.push(nextLine)
  }

  const normalized = updatedLines.join('\n').replace(/\n*$/, '\n')
  return normalized
}

/**
 * 删除 .env 中的指定变量
 * @param {string} envContent - 原始 .env 内容
 * @param {string} key - 变量名
 * @returns {string} 新的 .env 内容
 */
function removeEnvVariable(envContent, key) {
  const keyPattern = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`)
  const lines = envContent ? envContent.split(/\r?\n/) : []
  const filtered = lines.filter((line) => !keyPattern.test(line))
  const normalized = filtered.join('\n').replace(/\n*$/, '\n')
  return normalized
}

/**
 * 批量更新 .env 变量
 * @param {string} envContent - 原始 .env 内容
 * @param {Record<string, string|null>} updates - 变量更新集合（null 表示删除）
 * @returns {string} 新的 .env 内容
 */
function applyEnvVariableUpdates(envContent, updates) {
  let nextContent = envContent

  for (const [key, value] of Object.entries(updates)) {
    nextContent = value == null
      ? removeEnvVariable(nextContent, key)
      : upsertEnvVariable(nextContent, key, value)
  }

  return nextContent
}

/**
 * 原子写入文本文件
 * 先写临时文件再替换，避免写入中断导致配置文件损坏
 * @param {string} filePath - 目标文件路径
 * @param {string} content - 要写入的内容
 * @returns {Promise<{success: boolean, error: string|null}>}
 */
async function atomicWriteText(filePath, content) {
  const dir = path.dirname(filePath)
  const tmpPath = `${filePath}.tmp.${process.pid}`

  try {
    await fs.mkdir(dir, { recursive: true })
  } catch (error) {
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      return { success: false, error: 'PERMISSION_DENIED' }
    }
    if (error.code === 'ENOSPC') {
      return { success: false, error: 'DISK_FULL' }
    }
    return { success: false, error: `CREATE_DIR_FAILED: ${error.message}` }
  }

  try {
    await fs.writeFile(tmpPath, content, 'utf-8')
  } catch (error) {
    try { await fs.unlink(tmpPath) } catch {}
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      return { success: false, error: 'PERMISSION_DENIED' }
    }
    if (error.code === 'ENOSPC') {
      return { success: false, error: 'DISK_FULL' }
    }
    return { success: false, error: `WRITE_FAILED: ${error.message}` }
  }

  try {
    await fs.rename(tmpPath, filePath)
  } catch (error) {
    try { await fs.unlink(tmpPath) } catch {}
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      return { success: false, error: 'PERMISSION_DENIED' }
    }
    return { success: false, error: `RENAME_FAILED: ${error.message}` }
  }

  return { success: true, error: null }
}

/**
 * 创建 .env 文件操作服务实例
 * @param {Object} deps - 依赖注入
 * @param {string} deps.envFilePath - .env 文件路径
 * @param {(filepath: string) => Promise<boolean>} deps.pathExists - 路径存在检查
 * @returns {Object} .env 文件操作服务
 */
function createEnvFileService({ envFilePath, pathExists }) {
  /**
   * 读取项目 .env 文件
   * @returns {Promise<{exists: boolean, content: string, envMap: Record<string, string>, errorCode: string|null, error: string|null}>}
   */
  async function readProjectEnvFile() {
    try {
      const exists = await pathExists(envFilePath)
      if (!exists) {
        return { exists: false, content: '', envMap: {}, errorCode: null, error: null }
      }

      const content = await fs.readFile(envFilePath, 'utf-8')
      return {
        exists: true,
        content,
        envMap: dotenv.parse(content),
        errorCode: null,
        error: null,
      }
    } catch (error) {
      if (error.code === 'EACCES' || error.code === 'EPERM') {
        return {
          exists: false, content: '', envMap: {},
          errorCode: 'PERMISSION_DENIED',
          error: '无法读取 .env 文件，请检查权限',
        }
      }
      return {
        exists: false, content: '', envMap: {},
        errorCode: 'READ_FAILED',
        error: `读取 .env 失败: ${error.message}`,
      }
    }
  }

  /**
   * 读取当前生效的供应商环境变量
   * 以 .env 文件为单一真相，避免进程内旧值污染判断结果。
   * @param {string[]} managedKeys - 需要管理的环境变量 key 列表
   * @returns {Promise<{envSource: Record<string, string|undefined>, envPath: string, envExists: boolean, errorCode: string|null, error: string|null}>}
   */
  async function loadMergedProviderEnv(managedKeys) {
    const envReadResult = await readProjectEnvFile()
    const envSource = { ...envReadResult.envMap }

    // 进程环境变量仅用于补齐 .env 缺失值
    for (const key of managedKeys) {
      const runtimeValue = normalizeEnvValue(process.env[key])
      const fileValue = normalizeEnvValue(envSource[key])
      if (runtimeValue && !fileValue) {
        envSource[key] = runtimeValue
      }
    }

    return {
      envSource,
      envPath: envFilePath,
      envExists: envReadResult.exists,
      errorCode: envReadResult.errorCode,
      error: envReadResult.error,
    }
  }

  return {
    readProjectEnvFile,
    loadMergedProviderEnv,
  }
}

module.exports = {
  normalizeEnvValue,
  quoteEnvValue,
  upsertEnvVariable,
  removeEnvVariable,
  applyEnvVariableUpdates,
  atomicWriteText,
  createEnvFileService,
}
