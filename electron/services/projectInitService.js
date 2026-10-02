/**
 * 新建项目服务
 *
 * 负责：
 * - 创建前校验（项目名称、放在哪、代码文件夹、Git 方式），错误带 field 方便界面落到对应输入框
 * - 按共用清单（shared/projectInitManifest.mjs）生成整套目录与模板
 * - 按 Git 方式建仓，每个仓做一次初始提交（分支 main）；Git 没配名字和邮箱时只建仓不提交
 * - 任何一步失败都把本次新建的项目目录整个撤回
 * - Git 可用性检测
 *
 * 项目目录必须事先不存在，所以撤回就是删掉本次建出来的那一个目录，不会碰到用户已有文件。
 *
 * @module electron/services/projectInitService
 */

const fs = require('fs/promises')
const { constants: fsConstants } = require('fs')
const path = require('path')
const { execFile } = require('child_process')
const { promisify } = require('util')

const manifest = require('../../shared/projectInitManifest.mjs')

const execFileAsync = promisify(execFile)

const INITIAL_COMMIT_MESSAGE = '初始化项目结构'
const DEFAULT_BRANCH = 'main'
const IDENT_ENV_KEYS = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL']

/**
 * 生成一条校验错误
 * @param {string} code - 错误码
 * @param {string} message - 界面直接显示的一句话
 * @param {string} [field] - 出错的输入：projectName / targetPath / codeDirName / gitMode
 * @returns {{code: string, message: string, field?: string}}
 */
function createValidationError(code, message, field) {
  return field ? { code, message, field } : { code, message }
}

/**
 * 路径是否具备指定访问权限
 * @param {string} checkPath
 * @param {number} mode - fs 权限常量（W_OK 等）
 * @returns {Promise<boolean>}
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
 * 路径是否存在
 * @param {string} checkPath
 * @returns {Promise<boolean>}
 */
async function pathExists(checkPath) {
  try {
    await fs.lstat(checkPath)
    return true
  } catch {
    return false
  }
}

/**
 * 从给定路径往上找最近的已存在目录（目标路径不存在时判断能否创建）
 * @param {string} targetPath
 * @returns {Promise<string|null>}
 */
async function findNearestExistingDir(targetPath) {
  let current = path.resolve(targetPath)
  while (true) {
    if (await pathExists(current)) return current
    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

/**
 * 创建前校验
 * @param {Object} params
 * @param {string} params.projectName - 项目名称（外层文件夹名）
 * @param {string} params.targetPath - 放在哪（可含 ~）
 * @param {string} [params.codeDirName] - 代码文件夹名，空时为 code
 * @param {string} [params.gitMode] - dual / code / none
 * @param {(filepath: string) => string} expandHome - 家目录展开
 * @returns {Promise<{valid: boolean, errors: Array, resolved: {projectRoot: string|null, codeDir: string, gitMode: string}}>}
 */
async function validateProjectInitParams(params, expandHome) {
  const input = params && typeof params === 'object' ? params : {}
  const projectName = typeof input.projectName === 'string' ? input.projectName.trim() : ''
  const targetInput = typeof input.targetPath === 'string' ? input.targetPath.trim() : ''
  const rawCodeDir = typeof input.codeDirName === 'string' ? input.codeDirName.trim() : ''
  const codeDir = manifest.resolveCodeDir(rawCodeDir)
  const gitMode = typeof input.gitMode === 'string' ? input.gitMode : manifest.DEFAULT_GIT_MODE
  const errors = []

  if (!manifest.isValidName(projectName)) {
    errors.push(createValidationError('INVALID_PROJECT_NAME', '项目名称包含非法字符', 'projectName'))
  }
  if (!manifest.isValidName(codeDir)) {
    errors.push(createValidationError('INVALID_CODE_DIR', '代码文件夹名包含非法字符', 'codeDirName'))
  } else if (manifest.conflictsWithOuter(codeDir)) {
    errors.push(createValidationError('CODE_DIR_CONFLICT', '不能和外层的文件或文件夹同名', 'codeDirName'))
  }
  if (!manifest.GIT_MODES.includes(gitMode)) {
    errors.push(createValidationError('INVALID_GIT_MODE', 'Git 模式不受支持', 'gitMode'))
  }
  if (!targetInput) {
    errors.push(createValidationError('INVALID_TARGET_PATH', '目标路径不能为空', 'targetPath'))
  }

  const targetPath = targetInput ? expandHome(targetInput) : null
  let projectRoot = null

  if (targetPath) {
    if (await pathExists(targetPath)) {
      const stat = await fs.stat(targetPath)
      if (!stat.isDirectory()) {
        errors.push(createValidationError('TARGET_PATH_NOT_DIRECTORY', '目标路径必须是目录', 'targetPath'))
      } else if (!(await hasAccess(targetPath, fsConstants.W_OK))) {
        errors.push(createValidationError('TARGET_PATH_NOT_WRITABLE', '目标路径不可写', 'targetPath'))
      }
    } else {
      const nearest = await findNearestExistingDir(targetPath)
      if (!nearest || nearest === path.parse(targetPath).root) {
        errors.push(createValidationError('TARGET_PATH_NOT_FOUND', '目标路径及其父目录不存在', 'targetPath'))
      } else if (!(await hasAccess(nearest, fsConstants.W_OK))) {
        errors.push(createValidationError('TARGET_PATH_NOT_WRITABLE', '目标路径不可写', 'targetPath'))
      }
    }
    if (projectName && manifest.isValidName(projectName)) {
      projectRoot = path.join(targetPath, projectName)
      // 同名的文件或文件夹已存在（哪怕是空目录）都算冲突：不往已有目录里合并写
      if (await pathExists(projectRoot)) {
        errors.push(createValidationError('TARGET_CONFLICT', '目标路径存在冲突', 'projectName'))
      }
    }
  }

  return { valid: errors.length === 0, errors, resolved: { projectRoot, codeDir, gitMode } }
}

/**
 * 运行 git 命令
 * @param {string} cwd
 * @param {string[]} args
 * @param {Object} [env] - 额外环境变量（测试用临时 HOME）
 * @returns {Promise<string>} stdout
 */
async function runGit(cwd, args, env) {
  const merged = { ...process.env, ...(env || {}) }
  // 作者名 / 邮箱环境变量是空字符串时 Git 会报「empty ident」：空值当作没设置，交给 git config
  for (const key of IDENT_ENV_KEYS) {
    if (merged[key] === '') delete merged[key]
  }
  const { stdout } = await execFileAsync('git', args, { cwd, env: merged })
  return stdout.trim()
}

/**
 * 在目录里建仓，分支设成 main（Git 太旧不认 -b 时改用 symbolic-ref）
 * @param {string} dir
 * @param {Object} [env]
 */
async function initRepo(dir, env) {
  try {
    await runGit(dir, ['init', '-b', DEFAULT_BRANCH], env)
  } catch {
    await runGit(dir, ['init'], env)
    await runGit(dir, ['symbolic-ref', 'HEAD', `refs/heads/${DEFAULT_BRANCH}`], env)
  }
}

/**
 * Git 是否配了提交用的名字和邮箱（在这个目录生效的配置）
 * @param {string} dir
 * @param {Object} [env]
 * @returns {Promise<boolean>}
 */
async function hasCommitIdentity(dir, env) {
  try {
    const name = await runGit(dir, ['config', 'user.name'], env)
    const email = await runGit(dir, ['config', 'user.email'], env)
    return Boolean(name && email)
  } catch {
    return false
  }
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

/** 失败原因的中文说法：常见系统错误码转成一句话，其余用原始信息 */
function describeError(error) {
  const code = error && error.code
  if (code === 'EACCES' || code === 'EPERM') return '目标路径不可写'
  if (code === 'ENOSPC') return '磁盘空间不足'
  if (code === 'EEXIST') return '目标路径存在冲突'
  if (code === 'ENOENT' && error.path === undefined) return '没找到 Git'
  return (error && error.message) || '未知错误'
}

/**
 * 生成项目：建目录、写模板、建仓、初始提交；失败整体撤回
 * @param {Object} params - 同 validateProjectInitParams
 * @param {Object} deps
 * @param {(filepath: string) => string} deps.expandHome
 * @param {string} deps.templateBaseDir - 模板目录（templates/project-init-v4）
 * @param {Object} [deps.fsOps] - 可注入的 fs（测试制造写入失败用），默认 fs/promises
 * @param {Object} [deps.gitEnv] - 额外 git 环境变量（测试用临时 HOME）
 * @returns {Promise<{success: boolean, error: string|null, data: Object}>}
 *   成功 data：{ projectPath, commit: 'done'|'skipped-no-identity'|'skipped-no-git' }
 *   失败 data：{ errors }（校验没过）或 { failedStep, reason, rollback: {success, path} }
 */
async function executeProjectInit(params, deps) {
  const { expandHome, templateBaseDir, gitEnv } = deps
  const ops = deps.fsOps || fs
  const validation = await validateProjectInitParams(params, expandHome)
  if (!validation.valid) {
    return { success: false, error: 'VALIDATION_FAILED', data: { errors: validation.errors } }
  }

  const { projectRoot, codeDir, gitMode } = validation.resolved
  const projectName = path.basename(projectRoot)
  const targetPath = path.dirname(projectRoot)
  const targetExisted = await pathExists(targetPath)
  let rootCreated = false
  let step = `创建 ${projectName}/`

  try {
    await ops.mkdir(targetPath, { recursive: true })
    await ops.mkdir(projectRoot) // 不递归：同名目录这时才出现也会报错，绝不往已有目录里写
    rootCreated = true

    for (const item of manifest.buildManifest({ gitMode, codeDir })) {
      const dest = path.join(projectRoot, ...item.path.split('/'))
      if (item.kind === 'dir') {
        step = `创建 ${item.path}/`
        await ops.mkdir(dest, { recursive: true })
        continue
      }
      step = `写入 ${item.path}`
      let content = await fs.readFile(path.join(templateBaseDir, ...item.source.split('/')), 'utf-8')
      if (item.template) {
        content = content.split('{{PROJECT_NAME}}').join(projectName).split('{{CODE_DIR}}').join(codeDir)
      }
      await ops.writeFile(dest, content, 'utf-8')
    }

    let commit = 'skipped-no-git'
    if (gitMode !== 'none') {
      step = '建 Git 仓'
      const codeRoot = path.join(projectRoot, codeDir)
      const repos = gitMode === 'dual' ? [codeRoot, projectRoot] : [codeRoot]
      for (const repo of repos) await initRepo(repo, gitEnv)

      step = '初始提交'
      if (await hasCommitIdentity(codeRoot, gitEnv)) {
        for (const repo of repos) {
          await runGit(repo, ['add', '-A'], gitEnv)
          await runGit(repo, ['commit', '-m', INITIAL_COMMIT_MESSAGE], gitEnv)
        }
        commit = 'done'
      } else {
        commit = 'skipped-no-identity'
      }
    }

    return { success: true, error: null, data: { projectPath: projectRoot, commit } }
  } catch (error) {
    const reason = describeError(error)
    let rollbackOk = true
    if (rootCreated) {
      try {
        await fs.rm(projectRoot, { recursive: true, force: true })
      } catch {
        rollbackOk = false
      }
    }
    if (!targetExisted) {
      // 本次顺手建出来的「放在哪」目录如果还是空的，也一并撤掉
      await fs.rmdir(targetPath).catch(() => {})
    }
    return {
      success: false,
      error: 'EXECUTION_FAILED',
      data: { failedStep: step, reason, rollback: { success: rollbackOk, path: projectRoot } },
    }
  }
}

module.exports = {
  INITIAL_COMMIT_MESSAGE,
  createValidationError,
  validateProjectInitParams,
  executeProjectInit,
  checkGitAvailable,
}
