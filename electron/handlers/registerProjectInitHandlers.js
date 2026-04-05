/**
 * 新建项目初始化 IPC 注册模块
 *
 * 负责：
 * - 注册新建项目相关 IPC handlers
 * - 提供创建前校验、执行初始化、Git 预检能力
 * - 业务逻辑委托给 projectInitService
 *
 * @module electron/handlers/registerProjectInitHandlers
 */

const fs = require('fs/promises')
const path = require('path')

const {
  TEMPLATE_DEFINITIONS,
  TEMPLATE_KEYS,
  DEFAULT_TEMPLATE_KEYS,
  SUPPORTED_GIT_MODES,
  PROJECT_NAME_INVALID_CHARS,
  PLANNED_DIRECTORIES,
  MEMORY_PROTOCOL_SOURCE_FILE,
} = require('../config/projectInitConfig')

const {
  createStep,
  normalizeExecutionError,
  runGitInit,
  checkGitAvailable,
  appendMemoryProtocol,
  validateProjectInitParams,
  runSafeRollback,
} = require('../services/projectInitService')

/**
 * 注册新建项目初始化相关 IPC handlers
 * @param {Object} deps - 依赖注入
 * @param {import('electron').IpcMain} deps.ipcMain - Electron ipcMain
 * @param {(filepath: string) => string} deps.expandHome - 家目录展开函数
 * @param {(filepath: string) => Promise<boolean>} deps.pathExists - 路径存在检查函数
 * @param {string} deps.templateBaseDir - 模板源目录绝对路径
 * @returns {void}
 */
function registerProjectInitHandlers({ ipcMain, expandHome, pathExists, templateBaseDir }) {
  // 校验和执行共用的配置对象
  const config = {
    TEMPLATE_DEFINITIONS,
    TEMPLATE_KEYS,
    DEFAULT_TEMPLATE_KEYS,
    SUPPORTED_GIT_MODES,
    PROJECT_NAME_INVALID_CHARS,
    PLANNED_DIRECTORIES,
  }

  /**
   * Git 可用性预检
   * @returns {Promise<{success: boolean, data: {available: boolean, version: string|null}}>}
   */
  ipcMain.handle('project-init-check-git', async () => {
    try {
      const result = await checkGitAvailable()
      return { success: true, data: result }
    } catch (error) {
      return { success: true, data: { available: false, version: null } }
    }
  })

  /**
   * 创建前校验
   * @param {Electron.IpcMainInvokeEvent} event - IPC 事件
   * @param {Object} params - 校验入参
   * @returns {Promise<{success: boolean, valid: boolean, error: string|null, data: Object}>}
   */
  ipcMain.handle('project-init-validate', async (event, params = {}) => {
    try {
      const validation = await validateProjectInitParams(params, expandHome, pathExists, templateBaseDir, config)
      return {
        success: true,
        valid: validation.valid,
        error: validation.error,
        data: validation.data,
      }
    } catch (error) {
      console.error('Error validating project init params:', error)
      return {
        success: false,
        valid: false,
        error: 'VALIDATION_EXCEPTION',
        data: {
          errors: [{ code: 'VALIDATION_EXCEPTION', message: error.message || '创建前校验发生未知错误' }],
        },
      }
    }
  })

  /**
   * 执行初始化
   * @param {Electron.IpcMainInvokeEvent} event - IPC 事件
   * @param {Object} params - 执行参数（与 validate 入参一致）
   * @returns {Promise<{success: boolean, error: string|null, data: Object}>}
   */
  ipcMain.handle('project-init-execute', async (event, params = {}) => {
    const steps = []
    const createdDirectories = []
    const createdFiles = []
    const overwrittenSnapshots = []
    let createdGitDir = null
    let projectRoot = null
    let projectRootCreated = false

    try {
      const validation = await validateProjectInitParams(params, expandHome, pathExists, templateBaseDir, config)
      if (!validation.valid) {
        return {
          success: false,
          error: 'VALIDATION_FAILED',
          data: {
            validation,
            steps,
            rollback: { attempted: false, success: true, steps: [], error: null },
          },
        }
      }

      const { fields, resolvedPaths, plannedDirectories, templatePlans } = validation.data
      projectRoot = resolvedPaths.projectRoot
      const gitInitPath = resolvedPaths.gitInitPath
      const projectRootExistedBefore = await pathExists(projectRoot)
      projectRootCreated = !projectRootExistedBefore

      // 1. 创建目录
      for (const dirPath of plannedDirectories) {
        const exists = await pathExists(dirPath)
        if (exists) {
          const stat = await fs.stat(dirPath)
          if (!stat.isDirectory()) {
            throw { code: 'DIRECTORY_CONFLICT', message: '目标应为目录，但当前是文件', path: dirPath }
          }
          steps.push(createStep('CREATE_DIRECTORY', 'skipped', dirPath, null, '目录已存在，跳过创建'))
          continue
        }

        await fs.mkdir(dirPath, { recursive: true })
        createdDirectories.push(dirPath)
        steps.push(createStep('CREATE_DIRECTORY', 'success', dirPath, null, '目录创建成功'))
      }

      // 如勾选记忆系统，额外创建 memory/ 目录
      const hasMemory = fields.templates.includes('memory')
      if (hasMemory) {
        const memoryDirPath = path.join(projectRoot, 'memory')
        const memoryDirExists = await pathExists(memoryDirPath)
        if (!memoryDirExists) {
          await fs.mkdir(memoryDirPath, { recursive: true })
          createdDirectories.push(memoryDirPath)
          steps.push(createStep('CREATE_DIRECTORY', 'success', memoryDirPath, null, '记忆目录创建成功'))
        }
      }

      // 2. 复制模板文件
      for (const templatePlan of templatePlans) {
        const targetFilePath = templatePlan.targetPath
        const targetExists = await pathExists(targetFilePath)

        if (targetExists) {
          const targetStat = await fs.stat(targetFilePath)
          if (targetStat.isDirectory()) {
            throw { code: 'TARGET_PATH_BLOCKED', message: '目标位置已存在目录，无法写入同名文件', path: targetFilePath }
          }

          if (!fields.overwrite) {
            throw { code: 'TARGET_CONFLICT', message: '目标文件已存在且未开启覆盖', path: targetFilePath }
          }

          const previousContent = await fs.readFile(targetFilePath)
          overwrittenSnapshots.push({ path: targetFilePath, content: previousContent })
        }

        await fs.copyFile(templatePlan.sourcePath, targetFilePath)

        if (!targetExists) {
          createdFiles.push(targetFilePath)
        }

        steps.push(createStep('COPY_TEMPLATE', 'success', targetFilePath, null, `模板复制成功: ${templatePlan.key}`))
      }

      // 3. 记忆协议拼接：追加到已复制的指引文件末尾
      if (hasMemory && MEMORY_PROTOCOL_SOURCE_FILE) {
        const protocolSourcePath = path.join(templateBaseDir, MEMORY_PROTOCOL_SOURCE_FILE)
        const guidKeys = ['agents', 'claude'].filter((k) => fields.templates.includes(k))

        for (const guidKey of guidKeys) {
          const guidDef = TEMPLATE_DEFINITIONS[guidKey]
          if (!guidDef) continue
          const guidTargetPath = path.join(projectRoot, ...guidDef.targetSegments)
          await appendMemoryProtocol(guidTargetPath, protocolSourcePath)
          steps.push(createStep('APPEND_MEMORY_PROTOCOL', 'success', guidTargetPath, null, `记忆协议已追加: ${guidKey}`))
        }
      }

      // 4. Git 初始化
      if (fields.gitMode === 'none') {
        steps.push(createStep('INIT_GIT', 'skipped', null, null, '未选择 Git 初始化'))
      } else {
        const gitDirPath = path.join(gitInitPath, '.git')
        const gitDirExists = await pathExists(gitDirPath)

        if (gitDirExists) {
          steps.push(createStep('INIT_GIT', 'skipped', gitDirPath, 'GIT_ALREADY_INITIALIZED', '.git 已存在，跳过初始化'))
        } else {
          try {
            await runGitInit(gitInitPath)
          } catch (gitError) {
            if (gitError && gitError.code === 'ENOENT') {
              throw { code: 'GIT_NOT_INSTALLED', message: '未检测到 Git，请先安装 Git 或选择"跳过 Git"模式', path: gitInitPath }
            }
            throw { code: 'GIT_INIT_FAILED', message: `Git 初始化失败：${gitError.message || '未知错误'}`, path: gitInitPath }
          }

          createdGitDir = gitDirPath
          steps.push(createStep('INIT_GIT', 'success', gitDirPath, null, 'Git 初始化成功'))
        }
      }

      return {
        success: true,
        error: null,
        data: {
          validation,
          steps,
          rollback: { attempted: false, success: true, steps: [], error: null },
          summary: {
            createdDirectories,
            createdFiles,
            overwrittenFiles: overwrittenSnapshots.map((s) => s.path),
            gitDir: createdGitDir,
          },
        },
      }
    } catch (error) {
      const normalizedError = normalizeExecutionError(error, 'PROJECT_INIT_EXECUTION_FAILED', '项目初始化执行失败')
      const failedPath = normalizedError.path || null

      steps.push(createStep('EXECUTION_FAILED', 'failed', failedPath, normalizedError.code, normalizedError.message))

      const rollback = await runSafeRollback({
        createdFiles,
        createdDirectories,
        createdGitDir,
        projectRootCreated,
        projectRoot,
        overwrittenSnapshots,
      }, pathExists)

      return {
        success: false,
        error: normalizedError.code,
        data: {
          steps,
          rollback,
          summary: {
            createdDirectories,
            createdFiles,
            overwrittenFiles: overwrittenSnapshots.map((s) => s.path),
            gitDir: createdGitDir,
          },
        },
      }
    }
  })
}

module.exports = {
  registerProjectInitHandlers,
}
