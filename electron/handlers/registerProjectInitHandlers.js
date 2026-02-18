/**
 * 新建项目初始化 IPC 注册模块
 *
 * 负责：
 * - 注册 V0.9 新建项目初始化相关 IPC
 * - 提供创建前校验能力（名称/路径/模板/冲突）
 * - 提供执行与安全回滚能力
 *
 * @module electron/handlers/registerProjectInitHandlers
 */

const fs = require('fs/promises')
const { constants: fsConstants } = require('fs')
const path = require('path')
const { execFile } = require('child_process')
const { promisify } = require('util')

const execFileAsync = promisify(execFile)

/**
 * 可用模板定义
 * key 用于前后端交互，sourceFile 用于定位模板源文件
 */
const TEMPLATE_DEFINITIONS = Object.freeze({
  agents: {
    key: 'agents',
    sourceFile: 'AGENTS.md',
    targetSegments: ['AGENTS.md'],
  },
  claude: {
    key: 'claude',
    sourceFile: 'CLAUDE.md',
    targetSegments: ['CLAUDE.md'],
  },
  design: {
    key: 'design',
    sourceFile: 'design-system.html',
    targetSegments: ['design', 'design-system.html'],
  },
})

const TEMPLATE_KEYS = Object.freeze(Object.keys(TEMPLATE_DEFINITIONS))
const DEFAULT_TEMPLATE_KEYS = Object.freeze(['agents', 'claude', 'design'])
const SUPPORTED_GIT_MODES = new Set(['root', 'code', 'none'])
const PROJECT_NAME_INVALID_CHARS = /[\\/:*?"<>|]/

/**
 * 归一化模板勾选输入
 * 支持数组或对象两种输入，降低前后端联调耦合
 * @param {unknown} templates - 前端传入的模板勾选值
 * @returns {string[]} 归一化后的模板 key 列表
 */
function normalizeTemplateSelection(templates) {
  if (templates === undefined || templates === null) {
    return [...DEFAULT_TEMPLATE_KEYS]
  }

  if (Array.isArray(templates)) {
    return templates.filter((key) => TEMPLATE_KEYS.includes(key))
  }

  if (typeof templates === 'object') {
    return TEMPLATE_KEYS.filter((key) => Boolean(templates[key]))
  }

  return []
}

/**
 * 校验项目名称是否合法
 * @param {string} projectName - 项目名称
 * @returns {string|null} 错误码；合法返回 null
 */
function validateProjectName(projectName) {
  if (projectName.length === 0) return 'INVALID_PROJECT_NAME'
  if (projectName === '.' || projectName === '..') return 'INVALID_PROJECT_NAME'
  if (PROJECT_NAME_INVALID_CHARS.test(projectName)) return 'INVALID_PROJECT_NAME'
  return null
}

/**
 * 检查路径是否具备指定访问权限
 * @param {string} checkPath - 要检查的路径
 * @param {number} mode - fs 权限常量（R_OK/W_OK）
 * @returns {Promise<boolean>} 是否可访问
 */
async function hasAccess(checkPath, mode) {
  try {
    await fs.access(checkPath, mode)
    return true
  } catch {
    return false
  }
}

/**
 * 找到给定路径最近的“已存在父目录”
 * 用于在目标路径不存在时判断是否具备创建权限
 * @param {string} targetPath - 目标路径
 * @param {(filepath: string) => Promise<boolean>} pathExists - 路径存在检查函数
 * @returns {Promise<string|null>} 最近已存在目录；找不到返回 null
 */
async function findNearestExistingDir(targetPath, pathExists) {
  let currentPath = path.resolve(targetPath)

  while (true) {
    if (await pathExists(currentPath)) {
      try {
        const stat = await fs.stat(currentPath)
        if (stat.isDirectory()) {
          return currentPath
        }
      } catch {
        return null
      }
    }

    const parentPath = path.dirname(currentPath)
    if (parentPath === currentPath) {
      return null
    }
    currentPath = parentPath
  }
}

/**
 * 创建校验错误对象
 * @param {string} code - 错误码
 * @param {string} message - 人类可读错误信息
 * @param {Object} extra - 额外信息
 * @returns {{code: string, message: string, [key: string]: any}}
 */
function createValidationError(code, message, extra = {}) {
  return {
    code,
    message,
    ...extra,
  }
}

/**
 * 创建执行步骤对象
 * @param {string} step - 步骤名称
 * @param {'success'|'failed'|'skipped'} status - 步骤状态
 * @param {string|null} pathValue - 目标路径
 * @param {string|null} code - 错误码
 * @param {string|null} message - 描述信息
 * @returns {{step: string, status: string, path: string|null, code: string|null, message: string|null, timestamp: string}}
 */
function createStep(step, status, pathValue, code = null, message = null) {
  return {
    step,
    status,
    path: pathValue,
    code,
    message,
    timestamp: new Date().toISOString(),
  }
}

/**
 * 标准化未知错误对象
 * @param {unknown} error - 捕获到的异常
 * @param {string} defaultCode - 默认错误码
 * @param {string} defaultMessage - 默认错误信息
 * @returns {{code: string, message: string, path?: string}}
 */
function normalizeExecutionError(error, defaultCode, defaultMessage) {
  if (error && typeof error === 'object') {
    const code = typeof error.code === 'string' ? error.code : defaultCode
    const message = typeof error.message === 'string' ? error.message : defaultMessage
    const pathValue = typeof error.path === 'string' ? error.path : undefined
    return {
      code,
      message,
      ...(pathValue ? { path: pathValue } : {}),
    }
  }

  return {
    code: defaultCode,
    message: defaultMessage,
  }
}

/**
 * 执行 Git 初始化
 * @param {string} cwdPath - 执行目录
 * @returns {Promise<void>}
 */
async function runGitInit(cwdPath) {
  await execFileAsync('git', ['init'], { cwd: cwdPath })
}

/**
 * 执行创建前校验
 * @param {Object} params - 校验输入参数
 * @param {(filepath: string) => string} expandHome - 家目录展开函数
 * @param {(filepath: string) => Promise<boolean>} pathExists - 路径存在检查函数
 * @param {string} templateBaseDir - 模板根目录
 * @returns {Promise<{valid: boolean, data: Object, error: string|null}>}
 */
async function validateProjectInitParams(params, expandHome, pathExists, templateBaseDir) {
  if (typeof params !== 'object' || params === null) {
    return {
      valid: false,
      error: 'INVALID_PARAMETERS',
      data: {
        errors: [createValidationError('INVALID_PARAMETERS', '参数格式错误，必须为对象')],
      },
    }
  }

  const rawProjectName = typeof params.projectName === 'string' ? params.projectName : ''
  const projectName = rawProjectName.trim()
  const rawTargetPath = typeof params.targetPath === 'string' ? params.targetPath : ''
  const targetPathInput = rawTargetPath.trim()
  const gitMode = typeof params.gitMode === 'string' ? params.gitMode : 'root'
  const overwrite = Boolean(params.overwrite)
  const selectedTemplates = normalizeTemplateSelection(params.templates)

  const errors = []
  const warnings = []
  const conflicts = []

  // 项目名称校验：阻止路径穿透和非法字符
  const projectNameError = validateProjectName(projectName)
  if (projectNameError) {
    errors.push(createValidationError(projectNameError, '项目名称不能为空且不能包含非法字符', {
      field: 'projectName',
    }))
  }

  if (targetPathInput.length === 0) {
    errors.push(createValidationError('INVALID_TARGET_PATH', '目标路径不能为空', {
      field: 'targetPath',
    }))
  }

  if (!SUPPORTED_GIT_MODES.has(gitMode)) {
    errors.push(createValidationError('INVALID_GIT_MODE', 'Git 模式不受支持', {
      field: 'gitMode',
    }))
  }

  const expandedTargetPath = targetPathInput.length > 0
    ? expandHome(targetPathInput)
    : null
  const projectRoot = expandedTargetPath && projectName
    ? path.join(expandedTargetPath, projectName)
    : null

  const templatePlans = selectedTemplates.map((templateKey) => {
    const definition = TEMPLATE_DEFINITIONS[templateKey]
    const sourcePath = path.join(templateBaseDir, definition.sourceFile)
    const targetPath = projectRoot
      ? path.join(projectRoot, ...definition.targetSegments)
      : null
    return {
      key: templateKey,
      sourcePath,
      targetPath,
    }
  })

  // 目标路径校验：确保存在或可创建，且具备写权限
  if (expandedTargetPath) {
    const targetExists = await pathExists(expandedTargetPath)
    if (targetExists) {
      const targetStat = await fs.stat(expandedTargetPath)
      if (!targetStat.isDirectory()) {
        errors.push(createValidationError('TARGET_PATH_NOT_DIRECTORY', '目标路径必须是目录', {
          field: 'targetPath',
          path: expandedTargetPath,
        }))
      } else {
        const writable = await hasAccess(expandedTargetPath, fsConstants.W_OK)
        if (!writable) {
          errors.push(createValidationError('TARGET_PATH_NOT_WRITABLE', '目标路径不可写', {
            field: 'targetPath',
            path: expandedTargetPath,
          }))
        }
      }
    } else {
      const nearestExistingDir = await findNearestExistingDir(expandedTargetPath, pathExists)
      if (!nearestExistingDir) {
        errors.push(createValidationError('TARGET_PATH_NOT_FOUND', '目标路径及其父目录不存在', {
          field: 'targetPath',
          path: expandedTargetPath,
        }))
      } else {
        const writable = await hasAccess(nearestExistingDir, fsConstants.W_OK)
        if (!writable) {
          errors.push(createValidationError('TARGET_PATH_NOT_WRITABLE', '目标路径父目录不可写', {
            field: 'targetPath',
            path: nearestExistingDir,
          }))
        } else {
          warnings.push({
            code: 'TARGET_PATH_WILL_BE_CREATED',
            message: '目标路径当前不存在，执行时将自动创建',
            path: expandedTargetPath,
          })
        }
      }
    }
  }

  // 模板源文件校验：仅检查被勾选模板，避免无意义报错
  for (const plan of templatePlans) {
    const sourceExists = await pathExists(plan.sourcePath)
    if (!sourceExists) {
      errors.push(createValidationError('TEMPLATE_NOT_FOUND', `模板源文件不存在: ${plan.key}`, {
        template: plan.key,
        path: plan.sourcePath,
      }))
      continue
    }

    const readable = await hasAccess(plan.sourcePath, fsConstants.R_OK)
    if (!readable) {
      errors.push(createValidationError('TEMPLATE_NOT_READABLE', `模板源文件不可读: ${plan.key}`, {
        template: plan.key,
        path: plan.sourcePath,
      }))
    }
  }

  // 冲突检测：仅在基础路径校验通过后执行，避免级联噪音
  if (projectRoot && errors.length === 0) {
    const plannedDirectories = [
      path.join(projectRoot, 'prd'),
      path.join(projectRoot, 'design'),
      path.join(projectRoot, 'code'),
    ]

    const projectRootExists = await pathExists(projectRoot)
    if (projectRootExists) {
      const rootStat = await fs.stat(projectRoot)
      if (!rootStat.isDirectory()) {
        errors.push(createValidationError('PROJECT_ROOT_NOT_DIRECTORY', '项目根路径已存在且不是目录', {
          path: projectRoot,
        }))
      }
    }

    for (const dirPath of plannedDirectories) {
      const exists = await pathExists(dirPath)
      if (!exists) continue

      const stat = await fs.stat(dirPath)
      if (!stat.isDirectory()) {
        conflicts.push({
          type: 'DIRECTORY_CONFLICT',
          path: dirPath,
          message: '目标应为目录，但当前是文件',
        })
      }
    }

    for (const plan of templatePlans) {
      if (!plan.targetPath) continue

      const exists = await pathExists(plan.targetPath)
      if (!exists) continue

      const targetStat = await fs.stat(plan.targetPath)
      if (targetStat.isDirectory()) {
        conflicts.push({
          type: 'DIRECTORY_CONFLICT',
          path: plan.targetPath,
          template: plan.key,
          message: '目标位置已存在目录，无法写入同名文件',
        })
        continue
      }

      if (overwrite) {
        warnings.push({
          code: 'WILL_OVERWRITE_TARGET_FILE',
          message: `将覆盖已存在文件: ${plan.key}`,
          path: plan.targetPath,
        })
      } else {
        conflicts.push({
          type: 'FILE_EXISTS',
          path: plan.targetPath,
          template: plan.key,
          message: '目标文件已存在，且未开启覆盖',
        })
      }
    }

    const hasBlockingConflict = conflicts.some((conflict) => (
      conflict.type === 'DIRECTORY_CONFLICT' || conflict.type === 'FILE_EXISTS'
    ))

    if (hasBlockingConflict) {
      errors.push(createValidationError('TARGET_CONFLICT', '目标路径存在冲突', {
        conflicts,
      }))
    }

    const gitInitPath = gitMode === 'root'
      ? projectRoot
      : (gitMode === 'code' ? path.join(projectRoot, 'code') : null)

    return {
      valid: errors.length === 0,
      error: errors.length === 0 ? null : 'VALIDATION_FAILED',
      data: {
        fields: {
          projectName,
          targetPath: targetPathInput,
          gitMode,
          overwrite,
          templates: selectedTemplates,
        },
        resolvedPaths: {
          targetPath: expandedTargetPath,
          projectRoot,
          gitInitPath,
        },
        plannedDirectories,
        templatePlans,
        conflicts,
        warnings,
        errors,
      },
    }
  }

  return {
    valid: errors.length === 0,
    error: errors.length === 0 ? null : 'VALIDATION_FAILED',
    data: {
      fields: {
        projectName,
        targetPath: targetPathInput,
        gitMode,
        overwrite,
        templates: selectedTemplates,
      },
      resolvedPaths: {
        targetPath: expandedTargetPath,
        projectRoot,
        gitInitPath: null,
      },
      plannedDirectories: projectRoot
        ? [path.join(projectRoot, 'prd'), path.join(projectRoot, 'design'), path.join(projectRoot, 'code')]
        : [],
      templatePlans,
      conflicts,
      warnings,
      errors,
    },
  }
}

/**
 * 执行安全回滚
 * @param {Object} params - 回滚参数
 * @param {Array<string>} params.createdFiles - 本次新建文件
 * @param {Array<string>} params.createdDirectories - 本次新建目录
 * @param {string|null} params.createdGitDir - 本次新建 Git 目录
 * @param {boolean} params.projectRootCreated - 项目根目录是否为本次创建
 * @param {string|null} params.projectRoot - 项目根目录
 * @param {Array<{path: string, content: Buffer}>} params.overwrittenSnapshots - 被覆盖文件快照
 * @param {(filepath: string) => Promise<boolean>} pathExists - 路径存在检查函数
 * @returns {Promise<{attempted: boolean, success: boolean, steps: Array, error: string|null}>}
 */
async function runSafeRollback(params, pathExists) {
  const {
    createdFiles,
    createdDirectories,
    createdGitDir,
    projectRootCreated,
    projectRoot,
    overwrittenSnapshots,
  } = params

  const rollbackSteps = []
  let rollbackSuccess = true

  const hasAnythingToRollback = (
    createdFiles.length > 0 ||
    createdDirectories.length > 0 ||
    Boolean(createdGitDir) ||
    projectRootCreated ||
    overwrittenSnapshots.length > 0
  )

  if (!hasAnythingToRollback) {
    return {
      attempted: false,
      success: true,
      steps: rollbackSteps,
      error: null,
    }
  }

  // 先恢复被覆盖文件，避免后续目录删除时丢失原内容
  for (const snapshot of [...overwrittenSnapshots].reverse()) {
    try {
      await fs.writeFile(snapshot.path, snapshot.content)
      rollbackSteps.push(createStep('ROLLBACK_RESTORE_FILE', 'success', snapshot.path, null, '已恢复覆盖前内容'))
    } catch (error) {
      rollbackSuccess = false
      rollbackSteps.push(createStep('ROLLBACK_RESTORE_FILE', 'failed', snapshot.path, 'ROLLBACK_RESTORE_FAILED', error.message))
    }
  }

  if (createdGitDir) {
    try {
      await fs.rm(createdGitDir, { recursive: true, force: true })
      rollbackSteps.push(createStep('ROLLBACK_REMOVE_GIT_DIR', 'success', createdGitDir, null, '已移除新建 .git 目录'))
    } catch (error) {
      rollbackSuccess = false
      rollbackSteps.push(createStep('ROLLBACK_REMOVE_GIT_DIR', 'failed', createdGitDir, 'ROLLBACK_GIT_REMOVE_FAILED', error.message))
    }
  }

  for (const filePath of [...createdFiles].reverse()) {
    try {
      const exists = await pathExists(filePath)
      if (exists) {
        await fs.rm(filePath, { force: true })
      }
      rollbackSteps.push(createStep('ROLLBACK_REMOVE_FILE', 'success', filePath, null, '已移除新建文件'))
    } catch (error) {
      rollbackSuccess = false
      rollbackSteps.push(createStep('ROLLBACK_REMOVE_FILE', 'failed', filePath, 'ROLLBACK_FILE_REMOVE_FAILED', error.message))
    }
  }

  for (const dirPath of [...createdDirectories].reverse()) {
    try {
      const exists = await pathExists(dirPath)
      if (exists) {
        await fs.rm(dirPath, { recursive: true, force: true })
      }
      rollbackSteps.push(createStep('ROLLBACK_REMOVE_DIR', 'success', dirPath, null, '已移除新建目录'))
    } catch (error) {
      rollbackSuccess = false
      rollbackSteps.push(createStep('ROLLBACK_REMOVE_DIR', 'failed', dirPath, 'ROLLBACK_DIR_REMOVE_FAILED', error.message))
    }
  }

  // 项目根目录仅在“本次新建”场景删除，避免误删用户既有目录
  if (projectRootCreated && projectRoot) {
    try {
      const exists = await pathExists(projectRoot)
      if (exists) {
        await fs.rm(projectRoot, { recursive: true, force: true })
      }
      rollbackSteps.push(createStep('ROLLBACK_REMOVE_PROJECT_ROOT', 'success', projectRoot, null, '已移除本次新建项目根目录'))
    } catch (error) {
      rollbackSuccess = false
      rollbackSteps.push(createStep('ROLLBACK_REMOVE_PROJECT_ROOT', 'failed', projectRoot, 'ROLLBACK_ROOT_REMOVE_FAILED', error.message))
    }
  }

  return {
    attempted: true,
    success: rollbackSuccess,
    steps: rollbackSteps,
    error: rollbackSuccess ? null : 'ROLLBACK_PARTIAL_FAILED',
  }
}

/**
 * 注册 V0.9 新建项目初始化相关 IPC handlers
 * @param {Object} deps - 依赖注入
 * @param {import('electron').IpcMain} deps.ipcMain - Electron ipcMain
 * @param {(filepath: string) => string} deps.expandHome - 家目录展开函数
 * @param {(filepath: string) => Promise<boolean>} deps.pathExists - 路径存在检查函数
 * @param {string} deps.templateBaseDir - 模板源目录绝对路径
 * @returns {void}
 */
function registerProjectInitHandlers({ ipcMain, expandHome, pathExists, templateBaseDir }) {
  /**
   * V0.9 创建前校验
   * @param {Electron.IpcMainInvokeEvent} event - IPC 事件
   * @param {Object} params - 校验入参
   * @returns {Promise<{success: boolean, valid: boolean, error: string|null, data: Object}>}
   */
  ipcMain.handle('project-init-validate', async (event, params = {}) => {
    try {
      const validation = await validateProjectInitParams(params, expandHome, pathExists, templateBaseDir)
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
          errors: [
            createValidationError('VALIDATION_EXCEPTION', error.message || '创建前校验发生未知错误'),
          ],
        },
      }
    }
  })

  /**
   * V0.9 执行初始化
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
      const validation = await validateProjectInitParams(params, expandHome, pathExists, templateBaseDir)
      if (!validation.valid) {
        return {
          success: false,
          error: 'VALIDATION_FAILED',
          data: {
            validation,
            steps,
            rollback: {
              attempted: false,
              success: true,
              steps: [],
              error: null,
            },
          },
        }
      }

      const {
        fields,
        resolvedPaths,
        plannedDirectories,
        templatePlans,
      } = validation.data

      projectRoot = resolvedPaths.projectRoot
      const gitInitPath = resolvedPaths.gitInitPath
      const projectRootExistedBefore = await pathExists(projectRoot)
      projectRootCreated = !projectRootExistedBefore

      for (const dirPath of plannedDirectories) {
        const exists = await pathExists(dirPath)
        if (exists) {
          const stat = await fs.stat(dirPath)
          if (!stat.isDirectory()) {
            throw {
              code: 'DIRECTORY_CONFLICT',
              message: '目标应为目录，但当前是文件',
              path: dirPath,
            }
          }

          steps.push(createStep('CREATE_DIRECTORY', 'skipped', dirPath, null, '目录已存在，跳过创建'))
          continue
        }

        await fs.mkdir(dirPath, { recursive: true })
        createdDirectories.push(dirPath)
        steps.push(createStep('CREATE_DIRECTORY', 'success', dirPath, null, '目录创建成功'))
      }

      for (const templatePlan of templatePlans) {
        const targetFilePath = templatePlan.targetPath
        const targetExists = await pathExists(targetFilePath)

        if (targetExists) {
          const targetStat = await fs.stat(targetFilePath)
          if (targetStat.isDirectory()) {
            throw {
              code: 'TARGET_PATH_BLOCKED',
              message: '目标位置已存在目录，无法写入同名文件',
              path: targetFilePath,
            }
          }

          if (!fields.overwrite) {
            throw {
              code: 'TARGET_CONFLICT',
              message: '目标文件已存在且未开启覆盖',
              path: targetFilePath,
            }
          }

          const previousContent = await fs.readFile(targetFilePath)
          overwrittenSnapshots.push({
            path: targetFilePath,
            content: previousContent,
          })
        }

        await fs.copyFile(templatePlan.sourcePath, targetFilePath)

        if (!targetExists) {
          createdFiles.push(targetFilePath)
        }

        steps.push(createStep('COPY_TEMPLATE', 'success', targetFilePath, null, `模板复制成功: ${templatePlan.key}`))
      }

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
              throw {
                code: 'GIT_NOT_INSTALLED',
                message: '未检测到 Git，请先安装 Git 或选择“不初始化 Git”模式',
                path: gitInitPath,
              }
            }

            throw {
              code: 'GIT_INIT_FAILED',
              message: `Git 初始化失败：${gitError.message || '未知错误'}`,
              path: gitInitPath,
            }
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
          rollback: {
            attempted: false,
            success: true,
            steps: [],
            error: null,
          },
          summary: {
            createdDirectories,
            createdFiles,
            overwrittenFiles: overwrittenSnapshots.map((snapshot) => snapshot.path),
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
            overwrittenFiles: overwrittenSnapshots.map((snapshot) => snapshot.path),
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
