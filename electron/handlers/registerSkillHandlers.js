/**
 * 技能管理 IPC 注册模块
 *
 * 负责：
 * - 注册技能导入/推送/停用/增量导入相关 IPC
 * - 保持 main.js 仅承担入口与注册职责
 *
 * @module electron/handlers/registerSkillHandlers
 */

const fs = require('fs/promises')
const path = require('path')
const crypto = require('crypto')

/**
 * 注册技能管理相关 IPC handlers
 * @param {Object} deps - 依赖注入
 * @param {import('electron').IpcMain} deps.ipcMain - Electron ipcMain
 * @param {(filepath: string) => string} deps.expandHome - 家目录展开函数
 * @param {(filepath: string) => Promise<boolean>} deps.pathExists - 路径存在检查
 * @param {(content: string) => {name: string, desc: string}} deps.parseSkillMd - SKILL.md 解析函数
 * @param {Array} deps.PRESET_TOOLS - 预设工具定义
 * @param {(targetPath: string) => boolean} deps.isPathInAllowedDirs - 删除白名单校验
 */
function registerSkillHandlers({ ipcMain, expandHome, pathExists, parseSkillMd, PRESET_TOOLS, isPathInAllowedDirs }) {
/**
 * 执行导入操作
 * 将选中的来源 skills 去重合并到中央仓库
 * @param {Electron.IpcMainInvokeEvent} event - IPC 事件
 * @param {Object} params - 导入参数
 * @param {string[]} params.presetTools - 选中的预设工具ID列表
 * @param {Array<{path: string, skills: Object}>} params.customPaths - 选中的自定义路径列表
 * @param {string} params.repoPath - 中央仓库路径
 * @returns {Promise<{success: boolean, importedCount: number, errors: Array, error: string|null}>} 导入结果
 */
ipcMain.handle('import-skills', async (event, { presetTools = [], customPaths = [], repoPath }) => {
  // IPC 参数类型校验
  if (typeof repoPath !== 'string' || repoPath.length === 0) {
    return {
      success: false,
      importedCount: 0,
      errors: [{ error: 'INVALID_REPO_PATH' }],
      error: 'INVALID_REPO_PATH'
    }
  }
  if (!Array.isArray(presetTools) || !Array.isArray(customPaths)) {
    return {
      success: false,
      importedCount: 0,
      errors: [{ error: 'INVALID_PARAMETERS' }],
      error: 'INVALID_PARAMETERS'
    }
  }

  const errors = []
  let importedCount = 0

  try {
    const expandedRepoPath = expandHome(repoPath)

    // 确保中央仓库目录存在
    await fs.mkdir(expandedRepoPath, { recursive: true })

    // 收集所有要导入的 skills（按来源分组）
    const skillsToImport = []

    // 1. 收集预设工具的 skills
    for (const toolId of presetTools) {
      const tool = PRESET_TOOLS.find(t => t.id === toolId)
      if (!tool) continue

      const expandedToolPath = expandHome(tool.path)
      const exists = await pathExists(expandedToolPath)

      if (!exists) {
        errors.push({ source: tool.name, error: 'DIRECTORY_NOT_FOUND' })
        continue
      }

      try {
        const entries = await fs.readdir(expandedToolPath, { withFileTypes: true })

        for (const entry of entries) {
          if (entry.isDirectory()) {
            const skillMdPath = path.join(expandedToolPath, entry.name, 'SKILL.md')
            const skillMdExists = await pathExists(skillMdPath)

            if (skillMdExists) {
              skillsToImport.push({
                sourceName: tool.name,
                sourcePath: path.join(expandedToolPath, entry.name),
                skillName: entry.name,
                source: 'preset'
              })
            }
          }
        }
      } catch (err) {
        errors.push({ source: tool.name, error: err.code === 'EACCES' ? 'PERMISSION_DENIED' : err.message })
      }
    }

    // 2. 收集自定义路径的 skills
    for (const customPath of customPaths) {
      const expandedCustomPath = expandHome(customPath.path)
      const exists = await pathExists(expandedCustomPath)

      if (!exists) {
        errors.push({ source: customPath.path, error: 'PATH_NOT_FOUND' })
        continue
      }

      const toolSubdirs = {
        claude: '.claude/skills',
        codex: '.codex/skills',
        cursor: '.cursor/skills',
        trae: '.trae/skills'
      }

      for (const [toolId, subdir] of Object.entries(toolSubdirs)) {
        const toolPath = path.join(expandedCustomPath, subdir)
        const toolExists = await pathExists(toolPath)

        if (!toolExists) continue

        try {
          const entries = await fs.readdir(toolPath, { withFileTypes: true })

          for (const entry of entries) {
            if (entry.isDirectory()) {
              const skillMdPath = path.join(toolPath, entry.name, 'SKILL.md')
              const skillMdExists = await pathExists(skillMdPath)

              if (skillMdExists) {
                skillsToImport.push({
                  sourceName: `${path.basename(customPath.path)}/${toolId}`,
                  sourcePath: path.join(toolPath, entry.name),
                  skillName: entry.name,
                  source: 'custom'
                })
              }
            }
          }
        } catch (err) {
          errors.push({ source: `${customPath.path}/${toolId}`, error: err.code === 'EACCES' ? 'PERMISSION_DENIED' : err.message })
        }
      }
    }

    // 3. 执行导入（去重：后覆盖先）
    for (const skill of skillsToImport) {
      try {
        const targetPath = path.join(expandedRepoPath, skill.skillName)

        // 复制 skill 到中央仓库（覆盖已存在的）
        await fs.cp(skill.sourcePath, targetPath, { recursive: true, force: true })
        importedCount++
      } catch (err) {
        errors.push({
          source: skill.sourceName,
          skill: skill.skillName,
          error: err.code === 'EACCES' ? 'PERMISSION_DENIED' : err.message
        })
      }
    }

    // 如果有错误但整体成功，返回部分成功
    if (errors.length > 0 && importedCount > 0) {
      return {
        success: true,
        importedCount,
        errors,
        error: 'PARTIAL_SUCCESS'
      }
    }

    // 如果完全失败
    if (importedCount === 0 && errors.length > 0) {
      return {
        success: false,
        importedCount: 0,
        errors,
        error: 'IMPORT_FAILED'
      }
    }

    return {
      success: true,
      importedCount,
      errors: [],
      error: null
    }
  } catch (error) {
    console.error('Error importing skills:', error)
    return {
      success: false,
      importedCount,
      errors,
      error: error.message
    }
  }
})

// IPC handlers for V0.4 manage page

/**
 * 获取中央仓库所有技能
 * 扫描中央仓库目录，返回所有包含 SKILL.md 的技能文件夹
 * @param {Electron.IpcMainInvokeEvent} event - IPC 事件
 * @param {string} repoPath - 中央仓库路径
 * @returns {Promise<{success: boolean, skills: Array, error: string|null}>} 技能列表
 */
ipcMain.handle('get-central-skills', async (event, repoPath) => {
  try {
    const expandedRepoPath = expandHome(repoPath)

    // 检查目录是否存在
    const exists = await pathExists(expandedRepoPath)
    if (!exists) {
      return { success: true, skills: [], error: null }
    }

    // 读取目录内容
    const entries = await fs.readdir(expandedRepoPath, { withFileTypes: true })
    const skills = []

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillMdPath = path.join(expandedRepoPath, entry.name, 'SKILL.md')
        const skillMdExists = await pathExists(skillMdPath)

        if (skillMdExists) {
          try {
            const content = await fs.readFile(skillMdPath, 'utf-8')
            const { name, desc } = parseSkillMd(content)
            skills.push({
              name: entry.name,
              displayName: name || entry.name,
              desc: desc || ''
            })
          } catch (err) {
            // 静默处理：无法读取 SKILL.md 时仍包含该技能
            skills.push({
              name: entry.name,
              displayName: entry.name,
              desc: ''
            })
          }
        }
      }
    }

    // 按名称排序
    skills.sort((a, b) => a.displayName.localeCompare(b.displayName))

    return { success: true, skills, error: null }
  } catch (error) {
    console.error('Error getting central skills:', error)
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      return { success: false, skills: [], error: 'PERMISSION_DENIED' }
    }
    return { success: false, skills: [], error: error.message }
  }
})

/**
 * 获取工具的推送状态
 * 检查每个工具目录中是否存在指定的技能
 * @param {Electron.IpcMainInvokeEvent} event - IPC 事件
 * @param {string[]} skillNames - 技能名称列表
 * @returns {Promise<{success: boolean, status: Object, error: string|null}>} 推送状态
 * status 格式: { skillName: { 'claude-code': boolean, 'codex': boolean, ... } }
 */
ipcMain.handle('get-tool-status', async (event, skillNames) => {
  try {
    const status = {}

    // 初始化每个技能的状态
    for (const skillName of skillNames) {
      status[skillName] = {}
    }

    // 检查每个工具的推送状态
    for (const tool of PRESET_TOOLS) {
      const expandedToolPath = expandHome(tool.path)
      const toolExists = await pathExists(expandedToolPath)

      if (toolExists) {
        for (const skillName of skillNames) {
          const skillPath = path.join(expandedToolPath, skillName)
          const skillMdPath = path.join(skillPath, 'SKILL.md')
          status[skillName][tool.id] = await pathExists(skillMdPath)
        }
      } else {
        // 工具目录不存在，所有技能都标记为未推送
        for (const skillName of skillNames) {
          status[skillName][tool.id] = false
        }
      }
    }

    return { success: true, status, error: null }
  } catch (error) {
    console.error('Error getting tool status:', error)
    return { success: false, status: {}, error: error.message }
  }
})

/**
 * 推送技能到工具
 * 将中央仓库中的技能复制到指定工具的 skills 目录
 * @param {Electron.IpcMainInvokeEvent} event - IPC 事件
 * @param {Object} params - 推送参数
 * @param {string} params.repoPath - 中央仓库路径
 * @param {string[]} params.skillNames - 要推送的技能名称列表
 * @param {string[]} params.toolIds - 目标工具 ID 列表
 * @returns {Promise<{success: boolean, results: Array, error: string|null}>} 推送结果
 */
ipcMain.handle('push-skills', async (event, { repoPath, skillNames, toolIds }) => {
  // IPC 参数类型校验
  if (typeof repoPath !== 'string' || repoPath.length === 0) {
    return {
      success: false,
      results: [],
      errors: [{ error: 'INVALID_REPO_PATH' }],
      error: 'INVALID_REPO_PATH'
    }
  }
  if (!Array.isArray(skillNames) || !Array.isArray(toolIds)) {
    return {
      success: false,
      results: [],
      errors: [{ error: 'INVALID_PARAMETERS' }],
      error: 'INVALID_PARAMETERS'
    }
  }

  const results = []
  const errors = []

  try {
    const expandedRepoPath = expandHome(repoPath)

    for (const skillName of skillNames) {
      const sourcePath = path.join(expandedRepoPath, skillName)
      const skillMdPath = path.join(sourcePath, 'SKILL.md')

      // 验证源技能存在
      if (!(await pathExists(skillMdPath))) {
        errors.push({ skill: skillName, error: 'SKILL_NOT_FOUND' })
        continue
      }

      for (const toolId of toolIds) {
        const tool = PRESET_TOOLS.find(t => t.id === toolId)
        if (!tool) {
          errors.push({ skill: skillName, tool: toolId, error: 'TOOL_NOT_FOUND' })
          continue
        }

        const expandedToolPath = expandHome(tool.path)
        const targetPath = path.join(expandedToolPath, skillName)

        try {
          // 确保工具目录存在
          await fs.mkdir(expandedToolPath, { recursive: true })

          // 复制技能到工具目录
          await fs.cp(sourcePath, targetPath, { recursive: true, force: true })
          results.push({ skill: skillName, tool: toolId, success: true })
        } catch (err) {
          const errorCode = err.code === 'EACCES' || err.code === 'EPERM' ? 'PERMISSION_DENIED' : err.message
          errors.push({ skill: skillName, tool: toolId, error: errorCode })
        }
      }
    }

    // 如果有错误但整体有成功，返回部分成功
    if (errors.length > 0 && results.length > 0) {
      return {
        success: true,
        results,
        errors,
        error: 'PARTIAL_SUCCESS'
      }
    }

    // 如果完全失败
    if (results.length === 0 && errors.length > 0) {
      return {
        success: false,
        results: [],
        errors,
        error: 'PUSH_FAILED'
      }
    }

    return { success: true, results, errors: [], error: null }
  } catch (error) {
    console.error('Error pushing skills:', error)
    return { success: false, results, errors, error: error.message }
  }
})

/**
 * 停用技能（从工具目录删除）
 * 从指定工具的 skills 目录中删除技能
 * @param {Electron.IpcMainInvokeEvent} event - IPC 事件
 * @param {Object} params - 停用参数
 * @param {string[]} params.skillNames - 要停用的技能名称列表
 * @param {string[]} params.toolIds - 目标工具 ID 列表
 * @returns {Promise<{success: boolean, results: Array, error: string|null}>} 停用结果
 */
ipcMain.handle('unpush-skills', async (event, { skillNames, toolIds }) => {
  // IPC 参数类型校验
  if (!Array.isArray(skillNames) || !Array.isArray(toolIds)) {
    return {
      success: false,
      results: [],
      errors: [{ error: 'INVALID_PARAMETERS' }],
      error: 'INVALID_PARAMETERS'
    }
  }

  const results = []
  const errors = []

  try {
    for (const skillName of skillNames) {
      for (const toolId of toolIds) {
        const tool = PRESET_TOOLS.find(t => t.id === toolId)
        if (!tool) {
          errors.push({ skill: skillName, tool: toolId, error: 'TOOL_NOT_FOUND' })
          continue
        }

        const expandedToolPath = expandHome(tool.path)
        const skillPath = path.join(expandedToolPath, skillName)

        try {
          // 检查技能是否存在
          if (!(await pathExists(skillPath))) {
            // 已不存在，视为成功
            results.push({ skill: skillName, tool: toolId, success: true })
            continue
          }

          // 安全校验：检查路径是否在允许的目录范围内
          if (!isPathInAllowedDirs(expandedToolPath)) {
            console.error('Security: Blocked unpush attempt for path:', expandedToolPath)
            errors.push({ skill: skillName, tool: toolId, error: 'UNSAFE_PATH' })
            continue
          }

          // 删除技能目录
          await fs.rm(skillPath, { recursive: true, force: true })
          results.push({ skill: skillName, tool: toolId, success: true })
        } catch (err) {
          const errorCode = err.code === 'EACCES' || err.code === 'EPERM' ? 'PERMISSION_DENIED' : err.message
          errors.push({ skill: skillName, tool: toolId, error: errorCode })
        }
      }
    }

    // 如果有错误但整体有成功，返回部分成功
    if (errors.length > 0 && results.length > 0) {
      return {
        success: true,
        results,
        errors,
        error: 'PARTIAL_SUCCESS'
      }
    }

    // 如果完全失败
    if (results.length === 0 && errors.length > 0) {
      return {
        success: false,
        results: [],
        errors,
        error: 'UNPUSH_FAILED'
      }
    }

    return { success: true, results, errors: [], error: null }
  } catch (error) {
    console.error('Error unpushing skills:', error)
    return { success: false, results, errors, error: error.message }
  }
})

/**
 * 增量导入 - 仅新增不覆盖
 * 从自定义路径扫描技能，仅导入中央仓库中不存在的技能
 * @param {Electron.IpcMainInvokeEvent} event - IPC 事件
 * @param {Object} params - 导入参数
 * @param {string[]} params.customPathIds - 自定义路径 ID 列表（实际为路径字符串）
 * @param {string} params.repoPath - 中央仓库路径
 * @returns {Promise<{success: boolean, added: number, skipped: number, errors: string[]}>} 导入结果
 */
ipcMain.handle('incremental-import', async (event, { customPathIds, repoPath }) => {
  let added = 0
  let skipped = 0
  const errors = []

  try {
    const expandedRepoPath = expandHome(repoPath)

    // 1. 确保中央仓库目录存在
    await fs.mkdir(expandedRepoPath, { recursive: true })

    // 2. 获取中央仓库现有技能名称集合（用于去重）
    const existingSkills = new Set()
    try {
      const entries = await fs.readdir(expandedRepoPath, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const skillMdPath = path.join(expandedRepoPath, entry.name, 'SKILL.md')
          if (await pathExists(skillMdPath)) {
            existingSkills.add(entry.name)
          }
        }
      }
    } catch (err) {
      // 目录不存在或无法读取时，视为空仓库
    }

    // 3. 遍历自定义路径
    for (const customPathId of customPathIds) {
      const expandedCustomPath = expandHome(customPathId)
      const pathExists_result = await pathExists(expandedCustomPath)

      if (!pathExists_result) {
        errors.push(`Path not found: ${customPathId}`)
        continue
      }

      // 4. 扫描该路径下的技能
      const scanResult = await scanCustomPathForSkills(expandedCustomPath)

      if (!scanResult.success) {
        errors.push(`Failed to scan ${customPathId}: ${scanResult.error}`)
        continue
      }

      // 5. 处理扫描到的技能
      for (const skill of scanResult.skills) {
        if (existingSkills.has(skill.name)) {
          // 中央仓库已存在，跳过
          skipped++
        } else {
          // 中央仓库不存在，复制
          try {
            const targetPath = path.join(expandedRepoPath, skill.name)
            await fs.cp(skill.sourcePath, targetPath, { recursive: true, force: false })
            added++
            existingSkills.add(skill.name) // 添加到集合防止同一批次重复导入
          } catch (err) {
            errors.push(`Failed to copy ${skill.name}: ${err.message}`)
          }
        }
      }
    }

    // 6. 返回统计结果
    const hasErrors = errors.length > 0
    const hasSuccess = added > 0 || skipped > 0

    if (hasErrors && !hasSuccess) {
      return { success: false, added, skipped, errors }
    }

    return { success: true, added, skipped, errors }
  } catch (error) {
    console.error('Error in incremental import:', error)
    return { success: false, added, skipped, errors: [...errors, error.message] }
  }
})


/**
 * 扫描自定义路径下的所有技能
 * 辅助函数：扫描指定路径下的所有工具子目录，收集技能信息
 * @param {string} customPath - 自定义路径（已展开）
 * @returns {Promise<{success: boolean, skills: Array, error: string|null}>} 扫描结果
 */
async function scanCustomPathForSkills(customPath) {
  const skills = []

  const toolSubdirs = {
    'claude-code': '.claude/skills',
    'codex': '.codex/skills',
    'cursor': '.cursor/skills',
    'trae': '.trae/skills'
  }

  try {
    for (const [toolId, subdir] of Object.entries(toolSubdirs)) {
      const toolPath = path.join(customPath, subdir)
      const toolExists = await pathExists(toolPath)

      if (!toolExists) continue

      const entries = await fs.readdir(toolPath, { withFileTypes: true })

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const skillMdPath = path.join(toolPath, entry.name, 'SKILL.md')
          const skillMdExists = await pathExists(skillMdPath)

          if (skillMdExists) {
            skills.push({
              name: entry.name,
              sourcePath: path.join(toolPath, entry.name),
              toolId
            })
          }
        }
      }
    }

    return { success: true, skills, error: null }
  } catch (error) {
    console.error('Error scanning custom path for skills:', error)
    return { success: false, skills: [], error: error.message }
  }
}

/**
 * 比较两个技能目录的 SKILL.md 内容 hash
 * 用于方向 2（工具→中央）增量同步时判断是否需要更新
 * @param {Electron.IpcMainInvokeEvent} event - IPC 事件
 * @param {Object} params - 比较参数
 * @param {string} params.sourcePath - 来源技能目录路径
 * @param {string} params.targetPath - 目标技能目录路径
 * @returns {Promise<{success: boolean, isDifferent: boolean, sourceMtime: number}>}
 */
ipcMain.handle('compare-skill-content', async (event, { sourcePath, targetPath }) => {
  try {
    const expandedSource = expandHome(sourcePath)
    const expandedTarget = expandHome(targetPath)

    const sourceSkillMd = path.join(expandedSource, 'SKILL.md')
    const targetSkillMd = path.join(expandedTarget, 'SKILL.md')

    // 任一文件不存在时视为无需更新
    const sourceExists = await pathExists(sourceSkillMd)
    const targetExists = await pathExists(targetSkillMd)
    if (!sourceExists || !targetExists) {
      return { success: true, isDifferent: false, sourceMtime: 0 }
    }

    const [sourceContent, targetContent, sourceStat] = await Promise.all([
      fs.readFile(sourceSkillMd, 'utf-8'),
      fs.readFile(targetSkillMd, 'utf-8'),
      fs.stat(sourceSkillMd),
    ])

    const sourceHash = crypto.createHash('sha256').update(sourceContent).digest('hex')
    const targetHash = crypto.createHash('sha256').update(targetContent).digest('hex')

    return {
      success: true,
      isDifferent: sourceHash !== targetHash,
      sourceMtime: sourceStat.mtimeMs,
    }
  } catch (error) {
    console.error('Error comparing skill content:', error)
    return { success: false, isDifferent: false, sourceMtime: 0 }
  }
})
}

module.exports = {
  registerSkillHandlers,
}
