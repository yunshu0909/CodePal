/**
 * 导入页面相关 IPC handlers
 *
 * 负责：
 * - 扫描预设工具目录（技能数量统计）
 * - 扫描自定义路径（各工具子目录技能分布）
 * - 检查路径重复
 * - 更改中央仓库位置（含数据迁移）
 *
 * @module electron/handlers/registerImportPageHandlers
 */

const path = require('path')
const fs = require('fs/promises')
const {
  countSkillsInDirectory,
  scanCustomPathSkills,
  PRESET_TOOLS,
} = require('../services/skillScanService')

/**
 * 注册导入页面相关 IPC handlers
 * @param {Object} deps - 依赖集合
 * @param {Electron.IpcMain} deps.ipcMain
 * @param {(filepath: string) => string} deps.expandHome
 * @param {(filepath: string) => Promise<boolean>} deps.pathExists
 */
function registerImportPageHandlers({ ipcMain, expandHome, pathExists }) {
  /**
   * 扫描预设工具的 skills 数量
   */
  ipcMain.handle('scan-preset-tools', async (event) => {
    try {
      const tools = []

      for (const tool of PRESET_TOOLS) {
        const expandedPath = expandHome(tool.path)
        const skillCount = await countSkillsInDirectory(expandedPath)

        tools.push({
          id: tool.id,
          name: tool.name,
          icon: tool.icon,
          iconClass: tool.iconClass,
          path: tool.path,
          skills: skillCount
        })
      }

      return { success: true, tools, error: null }
    } catch (error) {
      console.error('Error scanning preset tools:', error)
      return { success: false, tools: [], error: error.message }
    }
  })

  /**
   * 扫描自定义路径下各工具子目录的技能分布
   */
  ipcMain.handle('scan-custom-path', async (event, customPath) => {
    if (typeof customPath !== 'string' || customPath.length === 0) {
      return { success: false, skills: {}, error: 'INVALID_PATH' }
    }

    try {
      const expandedPath = expandHome(customPath)
      return await scanCustomPathSkills(expandedPath)
    } catch (error) {
      console.error('Error scanning custom path:', error)
      if (error.code === 'EACCES' || error.code === 'EPERM') {
        return { success: false, skills: {}, error: 'PERMISSION_DENIED' }
      }
      return { success: false, skills: {}, error: error.message }
    }
  })

  /**
   * 检查路径是否已存在于列表中
   */
  ipcMain.handle('check-path-exists', async (event, checkPath, existingPaths = []) => {
    try {
      const expandedCheckPath = expandHome(checkPath)
      const normalizedCheckPath = path.normalize(expandedCheckPath)

      for (const existingPath of existingPaths) {
        const expandedExistingPath = expandHome(existingPath)
        const normalizedExistingPath = path.normalize(expandedExistingPath)

        if (normalizedCheckPath === normalizedExistingPath) {
          return { success: true, exists: true, error: null }
        }
      }

      return { success: true, exists: false, error: null }
    } catch (error) {
      console.error('Error checking path exists:', error)
      return { success: false, exists: false, error: error.message }
    }
  })

  /**
   * 更改中央仓库位置（验证可写性 + 数据迁移）
   */
  ipcMain.handle('change-repo-path', async (event, newPath, currentPath = null) => {
    if (typeof newPath !== 'string' || newPath.length === 0) {
      return { success: false, path: null, error: 'INVALID_PATH' }
    }

    try {
      const expandedNewPath = expandHome(newPath)

      // 1. 确保新路径存在
      try {
        await fs.mkdir(expandedNewPath, { recursive: true })
      } catch (err) {
        if (err.code === 'EACCES' || err.code === 'EPERM') {
          return { success: false, path: null, error: 'PERMISSION_DENIED' }
        }
        throw err
      }

      // 2. 验证目录可写
      const testFile = path.join(expandedNewPath, '.write-test')
      try {
        await fs.writeFile(testFile, '', 'utf-8')
        await fs.unlink(testFile)
      } catch (err) {
        if (err.code === 'EACCES' || err.code === 'EPERM') {
          return { success: false, path: null, error: 'PERMISSION_DENIED' }
        }
        return { success: false, path: null, error: 'DIRECTORY_NOT_WRITABLE' }
      }

      // 3. 迁移数据（如果有旧路径）
      if (currentPath) {
        const expandedCurrentPath = expandHome(currentPath)
        if (await pathExists(expandedCurrentPath)) {
          try {
            const entries = await fs.readdir(expandedCurrentPath, { withFileTypes: true })
            for (const entry of entries) {
              if (!entry.isDirectory()) continue
              const skillMdPath = path.join(expandedCurrentPath, entry.name, 'SKILL.md')
              if (!(await pathExists(skillMdPath))) continue

              const sourcePath = path.join(expandedCurrentPath, entry.name)
              const targetPath = path.join(expandedNewPath, entry.name)
              await fs.cp(sourcePath, targetPath, { recursive: true, force: true })
            }
          } catch (err) {
            // 迁移失败不阻止更改路径
            console.error('Error migrating data:', err)
          }
        }
      }

      return { success: true, path: newPath, error: null }
    } catch (error) {
      console.error('Error changing repo path:', error)
      return { success: false, path: null, error: error.message }
    }
  })
}

module.exports = { registerImportPageHandlers }
