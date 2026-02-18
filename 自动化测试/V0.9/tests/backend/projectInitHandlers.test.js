/**
 * V0.9 新建项目初始化后端测试
 *
 * 负责：
 * - 校验 project-init-validate 的参数、冲突与覆盖规则
 * - 校验 project-init-execute 的目录/模板/Git 步骤行为
 * - 校验执行失败时的回滚安全性
 *
 * @module 自动化测试/V0.9/tests/backend/projectInitHandlers.test
 */

import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'

const require = createRequire(import.meta.url)
const { registerProjectInitHandlers } = require('../../../../electron/handlers/registerProjectInitHandlers')

/**
 * 创建可用于测试的 handler 映射
 * @returns {{handlers: Map<string, Function>, templateBaseDir: string}}
 */
function createRegisteredHandlers() {
  const handlers = new Map()
  const templateBaseDir = path.resolve(process.cwd(), 'templates', 'project-init-v0.9')
  const ipcMain = {
    handle: (name, fn) => handlers.set(name, fn),
  }

  registerProjectInitHandlers({
    ipcMain,
    expandHome: (inputPath) => (
      inputPath.startsWith('~/')
        ? path.join(os.homedir(), inputPath.slice(2))
        : inputPath
    ),
    pathExists: async (checkPath) => {
      try {
        await fs.access(checkPath)
        return true
      } catch {
        return false
      }
    },
    templateBaseDir,
  })

  return { handlers, templateBaseDir }
}

describe('V0.9 Project Init Handlers', () => {
  let handlers
  let tempBasePath
  let templateBaseDir

  beforeEach(async () => {
    const registered = createRegisteredHandlers()
    handlers = registered.handlers
    templateBaseDir = registered.templateBaseDir
    tempBasePath = await fs.mkdtemp(path.join(os.tmpdir(), 'project-init-handler-test-'))
  })

  afterEach(async () => {
    await fs.rm(tempBasePath, { recursive: true, force: true })
  })

  it('UT-V09-BE-01: 校验应拦截空项目名', async () => {
    const validate = handlers.get('project-init-validate')

    const result = await validate({}, {
      projectName: '   ',
      targetPath: tempBasePath,
      gitMode: 'root',
      templates: ['agents'],
      overwrite: false,
    })

    expect(result.success).toBe(true)
    expect(result.valid).toBe(false)
    expect(result.error).toBe('VALIDATION_FAILED')
    expect(result.data.errors.some((item) => item.code === 'INVALID_PROJECT_NAME')).toBe(true)
  })

  it('UT-V09-BE-02: 校验应拦截目录型目标文件冲突', async () => {
    const validate = handlers.get('project-init-validate')
    const projectRoot = path.join(tempBasePath, 'demo-project')

    await fs.mkdir(path.join(projectRoot, 'design', 'design-system.html'), { recursive: true })

    const result = await validate({}, {
      projectName: 'demo-project',
      targetPath: tempBasePath,
      gitMode: 'none',
      templates: ['design'],
      overwrite: true,
    })

    expect(result.success).toBe(true)
    expect(result.valid).toBe(false)
    expect(result.data.conflicts.some((item) => item.type === 'DIRECTORY_CONFLICT')).toBe(true)
  })

  it('UT-V09-BE-03: 未开启覆盖时应拦截已存在模板文件', async () => {
    const validate = handlers.get('project-init-validate')
    const projectRoot = path.join(tempBasePath, 'demo-file-conflict')

    await fs.mkdir(projectRoot, { recursive: true })
    await fs.writeFile(path.join(projectRoot, 'AGENTS.md'), 'legacy-content\n', 'utf-8')

    const result = await validate({}, {
      projectName: 'demo-file-conflict',
      targetPath: tempBasePath,
      gitMode: 'none',
      templates: ['agents'],
      overwrite: false,
    })

    expect(result.success).toBe(true)
    expect(result.valid).toBe(false)
    expect(result.error).toBe('VALIDATION_FAILED')
    expect(result.data.conflicts.some((item) => item.type === 'FILE_EXISTS')).toBe(true)
  })

  it('UT-V09-BE-04: 开启覆盖时应允许继续并给出覆盖告警', async () => {
    const validate = handlers.get('project-init-validate')
    const projectRoot = path.join(tempBasePath, 'demo-overwrite-validate')

    await fs.mkdir(projectRoot, { recursive: true })
    await fs.writeFile(path.join(projectRoot, 'AGENTS.md'), 'legacy-content\n', 'utf-8')

    const result = await validate({}, {
      projectName: 'demo-overwrite-validate',
      targetPath: tempBasePath,
      gitMode: 'none',
      templates: ['agents'],
      overwrite: true,
    })

    expect(result.success).toBe(true)
    expect(result.valid).toBe(true)
    expect(result.error).toBeNull()
    expect(result.data.warnings.some((item) => item.code === 'WILL_OVERWRITE_TARGET_FILE')).toBe(true)
  })

  it('UT-V09-BE-05: 执行应按 none 模式创建目录与模板文件', async () => {
    const execute = handlers.get('project-init-execute')
    const projectName = 'demo-execute-ok'
    const projectRoot = path.join(tempBasePath, projectName)

    const result = await execute({}, {
      projectName,
      targetPath: tempBasePath,
      gitMode: 'none',
      templates: ['agents', 'claude', 'design'],
      overwrite: false,
    })

    expect(result.success).toBe(true)
    expect(result.error).toBeNull()

    await expect(fs.access(path.join(projectRoot, 'AGENTS.md'))).resolves.toBeUndefined()
    await expect(fs.access(path.join(projectRoot, 'CLAUDE.md'))).resolves.toBeUndefined()
    await expect(fs.access(path.join(projectRoot, 'design', 'design-system.html'))).resolves.toBeUndefined()
    await expect(fs.access(path.join(projectRoot, 'prd'))).resolves.toBeUndefined()
    await expect(fs.access(path.join(projectRoot, 'code'))).resolves.toBeUndefined()
  })

  it('UT-V09-BE-06: 开启覆盖后应替换既有模板文件', async () => {
    const execute = handlers.get('project-init-execute')
    const projectName = 'demo-overwrite-execute'
    const projectRoot = path.join(tempBasePath, projectName)
    const agentsPath = path.join(projectRoot, 'AGENTS.md')
    const templateAgentsPath = path.join(templateBaseDir, 'AGENTS.md')
    const templateAgentsContent = await fs.readFile(templateAgentsPath, 'utf-8')

    await fs.mkdir(path.join(projectRoot, 'prd'), { recursive: true })
    await fs.mkdir(path.join(projectRoot, 'design'), { recursive: true })
    await fs.mkdir(path.join(projectRoot, 'code'), { recursive: true })
    await fs.writeFile(agentsPath, 'legacy-content\n', 'utf-8')

    const result = await execute({}, {
      projectName,
      targetPath: tempBasePath,
      gitMode: 'none',
      templates: ['agents'],
      overwrite: true,
    })

    expect(result.success).toBe(true)
    expect(result.error).toBeNull()
    expect(result.data.summary.overwrittenFiles).toContain(agentsPath)

    const overwrittenContent = await fs.readFile(agentsPath, 'utf-8')
    expect(overwrittenContent).toBe(templateAgentsContent)
  })

  it('UT-V09-BE-07: code 模式下若已存在 .git 应跳过初始化并成功', async () => {
    const execute = handlers.get('project-init-execute')
    const projectName = 'demo-code-git-exists'
    const projectRoot = path.join(tempBasePath, projectName)
    const codeGitDir = path.join(projectRoot, 'code', '.git')

    await fs.mkdir(codeGitDir, { recursive: true })

    const result = await execute({}, {
      projectName,
      targetPath: tempBasePath,
      gitMode: 'code',
      templates: ['claude'],
      overwrite: false,
    })

    expect(result.success).toBe(true)
    const gitStep = result.data.steps.find((step) => step.step === 'INIT_GIT')
    expect(gitStep).toBeTruthy()
    expect(gitStep.status).toBe('skipped')
    expect(gitStep.code).toBe('GIT_ALREADY_INITIALIZED')
  })

  it('UT-V09-BE-08: Git 初始化失败时应触发安全回滚', async () => {
    const execute = handlers.get('project-init-execute')
    const projectName = 'demo-execute-git-fail'
    const projectRoot = path.join(tempBasePath, projectName)
    const originalPath = process.env.PATH

    process.env.PATH = ''
    const result = await execute({}, {
      projectName,
      targetPath: tempBasePath,
      gitMode: 'root',
      templates: ['agents'],
      overwrite: false,
    })
    process.env.PATH = originalPath

    expect(result.success).toBe(false)
    expect(result.error).toBe('GIT_NOT_INSTALLED')
    expect(result.data.rollback.attempted).toBe(true)
    expect(result.data.rollback.success).toBe(true)

    await expect(fs.access(projectRoot)).rejects.toBeTruthy()
  })
})
