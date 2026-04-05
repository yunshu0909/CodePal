/**
 * 新建项目初始化业务逻辑
 *
 * 负责：
 * - 创建前校验（名称/路径/模板/冲突）
 * - 执行初始化与安全回滚
 * - Git 可用性检测
 * - 记忆协议拼接
 *
 * @module electron/services/projectInitService
 */

const fs = require('fs/promises')
const { constants: fsConstants } = require('fs')
const path = require('path')
const { execFile } = require('child_process')
const { promisify } = require('util')

const execFileAsync = promisify(execFile)

/**
 * 归一化模板勾选输入
 * 支持数组或对象两种输入，降低前后端联调耦合
 * @param {unknown} templates - 前端传入的模板勾选值
 * @param {string[]} templateKeys - 合法模板 key 列表
 * @param {string[]} defaultTemplateKeys - 默认模板 key 列表
 * @returns {string[]} 归一化后的模板 key 列表
 */
function normalizeTemplateSelection(templates, templateKeys, defaultTemplateKeys) {
  if (templates === undefined || templates === null) {
    return [...defaultTemplateKeys]
  }

  if (Array.isArray(templates)) {
    return templates.filter((key) => templateKeys.includes(key))
  }

  if (typeof templates === 'object') {
    return templateKeys.filter((key) => Boolean(templates[key]))
  }

  return []
}

/**
 * 校验项目名称是否合法
 * @param {string} projectName - 项目名称
 * @param {RegExp} invalidChars - 非法字符正则
 * @returns {string|null} 错误码；合法返回 null
 */
function validateProjectName(projectName, invalidChars) {
  if (projectName.length === 0) return 'INVALID_PROJECT_NAME'
  if (projectName === '.' || projectName === '..') return 'INVALID_PROJECT_NAME'
  if (invalidChars.test(projectName)) return 'INVALID_PROJECT_NAME'
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
 * 找到给定路径最近的"已存在父目录"
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
  return { code, message, ...extra }
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

  return { code: defaultCode, message: defaultMessage }
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
 * 检测 Git 是否可用
 * @returns {Promise<{available: boolean, version: string|null}>}
 */
async function checkGitAvailable() {
  try {
    const { stdout } = await execFileAsync('git', ['--version'])
    return { available: true, version: stdout.trim() }
  } catch {
    return { available: false, version: null }
  }
}

/**
 * 将记忆协议追加到指引文件末尾
 * @param {string} guidFilePath - 已复制到目标位置的指引文件路径
 * @param {string} protocolSourcePath - 记忆协议源文件路径
 * @returns {Promise<void>}
 */
async function appendMemoryProtocol(guidFilePath, protocolSourcePath) {
  const protocolContent = await fs.readFile(protocolSourcePath, 'utf-8')
  await fs.appendFile(guidFilePath, protocolContent, 'utf-8')
}

/**
 * 执行创建前校验
 * @param {Object} params - 校验输入参数
 * @param {(filepath: string) => string} expandHome - 家目录展开函数
 * @param {(filepath: string) => Promise<boolean>} pathExists - 路径存在检查函数
 * @param {string} templateBaseDir - 模板根目录
 * @param {Object} config - 配置常量
 * @returns {Promise<{valid: boolean, data: Object, error: string|null}>}
 */
async function validateProjectInitParams(params, expandHome, pathExists, templateBaseDir, config) {
  const {
    TEMPLATE_DEFINITIONS,
    TEMPLATE_KEYS,
    DEFAULT_TEMPLATE_KEYS,
    SUPPORTED_GIT_MODES,
    PROJECT_NAME_INVALID_CHARS,
    PLANNED_DIRECTORIES,
  } = config

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
  const selectedTemplates = normalizeTemplateSelection(params.templates, TEMPLATE_KEYS, DEFAULT_TEMPLATE_KEYS)

  const errors = []
  const warnings = []
  const conflicts = []

  // 项目名称校验
  const projectNameError = validateProjectName(projectName, PROJECT_NAME_INVALID_CHARS)
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

  const expandedTargetPath = targetPathInput.length > 0 ? expandHome(targetPathInput) : null
  const projectRoot = expandedTargetPath && projectName
    ? path.join(expandedTargetPath, projectName)
    : null

  // 构建模板计划（仅 copy 型模板，排除 memoryProtocol）
  const copyableTemplates = selectedTemplates.filter((key) => TEMPLATE_DEFINITIONS[key])
  const templatePlans = copyableTemplates.map((templateKey) => {
    const definition = TEMPLATE_DEFINITIONS[templateKey]
    const sourcePath = path.join(templateBaseDir, definition.sourceFile)
    const targetPath = projectRoot
      ? path.join(projectRoot, ...definition.targetSegments)
      : null
    return { key: templateKey, sourcePath, targetPath }
  })

  // 目标路径校验
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

  // 模板源文件校验
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

  // 冲突检测
  const plannedDirectories = projectRoot
    ? PLANNED_DIRECTORIES.map((dir) => path.join(projectRoot, dir))
    : []

  if (projectRoot && errors.length === 0) {
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

    const hasBlockingConflict = conflicts.some((c) => (
      c.type === 'DIRECTORY_CONFLICT' || c.type === 'FILE_EXISTS'
    ))

    if (hasBlockingConflict) {
      errors.push(createValidationError('TARGET_CONFLICT', '目标路径存在冲突', { conflicts }))
    }
  }

  const gitInitPath = projectRoot
    ? (gitMode === 'root' ? projectRoot : (gitMode === 'code' ? path.join(projectRoot, 'code') : null))
    : null

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
      resolvedPaths: { targetPath: expandedTargetPath, projectRoot, gitInitPath },
      plannedDirectories,
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
    return { attempted: false, success: true, steps: rollbackSteps, error: null }
  }

  // 先恢复被覆盖文件
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

  // 项目根目录仅在"本次新建"场景删除
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

module.exports = {
  normalizeTemplateSelection,
  validateProjectName,
  hasAccess,
  findNearestExistingDir,
  createValidationError,
  createStep,
  normalizeExecutionError,
  runGitInit,
  checkGitAvailable,
  appendMemoryProtocol,
  validateProjectInitParams,
  runSafeRollback,
}
