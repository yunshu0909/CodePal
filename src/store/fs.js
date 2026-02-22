/**
 * 文件系统操作包装器
 *
 * 负责：
 * - 通过 Electron IPC 提供文件系统操作接口
 * - 封装技能扫描、复制、删除等操作
 * - 配置文件读写
 *
 * @module store/fs
 */

/**
 * Scan a tool directory for skills (folders containing SKILL.md)
 * @param {string} toolPath - Path to the tool's skills directory
 * @returns {Promise<{success: boolean, skills: Array, error: string|null}>}
 */
export async function scanToolDirectory(toolPath) {
  if (!window.electronAPI?.scanToolDirectory) {
    return { success: false, skills: [], error: 'API_NOT_AVAILABLE' }
  }
  return window.electronAPI.scanToolDirectory(toolPath)
}

/**
 * Read skill info from a skill folder's SKILL.md
 * @param {string} skillPath - Path to the skill folder
 * @returns {Promise<{success: boolean, name: string, desc: string, error: string|null}>}
 */
export async function readSkillInfo(skillPath) {
  if (!window.electronAPI?.readSkillInfo) {
    return { success: false, error: 'API_NOT_AVAILABLE' }
  }
  return window.electronAPI.readSkillInfo(skillPath)
}

/**
 * Copy a skill folder from source to target
 * @param {string} sourcePath - Source skill folder path
 * @param {string} targetPath - Target skill folder path
 * @param {Object} options - Copy options
 * @param {boolean} options.force - Overwrite if exists (default: true)
 * @returns {Promise<{success: boolean, error: string|null}>}
 */
export async function copySkill(sourcePath, targetPath, options = { force: true }) {
  if (!window.electronAPI?.copySkill) {
    return { success: false, error: 'API_NOT_AVAILABLE' }
  }
  return window.electronAPI.copySkill(sourcePath, targetPath, options)
}

/**
 * Delete a skill folder
 * @param {string} skillPath - Path to the skill folder to delete
 * @returns {Promise<{success: boolean, error: string|null}>}
 */
export async function deleteSkill(skillPath) {
  if (!window.electronAPI?.deleteSkill) {
    return { success: false, error: 'API_NOT_AVAILABLE' }
  }
  return window.electronAPI.deleteSkill(skillPath)
}

/**
 * Ensure a directory exists (create if not exists)
 * @param {string} dirPath - Path to the directory
 * @returns {Promise<{success: boolean, error: string|null}>}
 */
export async function ensureDir(dirPath) {
  if (!window.electronAPI?.ensureDir) {
    return { success: false, error: 'API_NOT_AVAILABLE' }
  }
  return window.electronAPI.ensureDir(dirPath)
}

/**
 * Check if a path exists
 * @param {string} checkPath - Path to check
 * @returns {Promise<{success: boolean, exists: boolean, error: string|null}>}
 */
export async function pathExists(checkPath) {
  if (!window.electronAPI?.pathExists) {
    return { success: false, exists: false, error: 'API_NOT_AVAILABLE' }
  }
  return window.electronAPI.pathExists(checkPath)
}

/**
 * Read config from .config.json file
 * @param {string} configPath - Path to the config file
 * @returns {Promise<{success: boolean, data: Object, error: string|null}>}
 */
export async function readConfig(configPath) {
  if (!window.electronAPI?.readConfig) {
    return { success: false, data: null, error: 'API_NOT_AVAILABLE' }
  }
  return window.electronAPI.readConfig(configPath)
}

/**
 * Write config to .config.json file
 * @param {string} configPath - Path to the config file
 * @param {Object} data - Config data to write
 * @returns {Promise<{success: boolean, error: string|null}>}
 */
export async function writeConfig(configPath, data) {
  if (!window.electronAPI?.writeConfig) {
    return { success: false, error: 'API_NOT_AVAILABLE' }
  }
  return window.electronAPI.writeConfig(configPath, data)
}

/**
 * Select folder using system dialog
 * @returns {Promise<{success: boolean, path: string|null, canceled: boolean, error: string|null}>}
 */
export async function selectFolder() {
  if (!window.electronAPI?.selectFolder) {
    return { success: false, path: null, canceled: true, error: 'API_NOT_AVAILABLE' }
  }
  return window.electronAPI.selectFolder()
}

/**
 * Scan custom path for skills in tool subdirectories
 * Scans .claude/skills/, .codex/skills/, .cursor/skills/, .trae/skills/, .factory/skills/
 * @param {string} basePath - Base directory path to scan
 * @returns {Promise<{success: boolean, skills: Object, error: string|null}>}
 *   skills format: { claude: 5, codex: 3 }
 */
export async function scanCustomPath(basePath) {
  if (!window.electronAPI?.scanCustomPath) {
    return { success: false, skills: {}, error: 'API_NOT_AVAILABLE' }
  }
  return window.electronAPI.scanCustomPath(basePath)
}

/**
 * 扫描日志文件
 * 扫描指定目录下的 .jsonl 日志文件，返回文件路径和内容行
 * @param {Object} params - 扫描参数
 * @param {string} params.basePath - 基础目录路径（支持 ~ 展开）
 * @param {string} params.pattern - 文件匹配模式（如 star.star slash star.jsonl）
 * @param {string} params.start - 开始时间（ISO 字符串）
 * @param {string} params.end - 结束时间（ISO 字符串）
 * @returns {Promise<{success: boolean, files: Array<{path: string, lines: string[], mtime: string}>, error: string|null}>}
 *   files: 文件列表，每个文件包含路径、内容行数组和修改时间
 */
export async function scanLogFiles(params) {
  if (!window.electronAPI?.scanLogFiles) {
    return { success: false, files: [], error: 'API_NOT_AVAILABLE' }
  }
  return window.electronAPI.scanLogFiles(params)
}
