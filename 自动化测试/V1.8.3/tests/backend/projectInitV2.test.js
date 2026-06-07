/**
 * V1.8.3 新建项目生成器升级 — 后端测试
 *
 * 负责：
 * - specs 工作单元目录递归拷贝（fs.cp）
 * - AGENTS 标题修复 + 两份内容一致 + 记忆协议追加
 * - specs 目标冲突、回滚整树、向后兼容
 * - 模板通用化硬验收（不含 CodePal 专属词）
 *
 * @module 自动化测试/V1.8.3/tests/backend/projectInitV2.test
 */

import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'

const require = createRequire(import.meta.url)
const { registerProjectInitHandlers } = require('../../../../electron/handlers/registerProjectInitHandlers')
const { runSafeRollback } = require('../../../../electron/services/projectInitService')

function createRegisteredHandlers() {
  const handlers = new Map()
  const templateBaseDir = path.resolve(process.cwd(), 'templates', 'project-init-v2')
  const ipcMain = { handle: (name, fn) => handlers.set(name, fn) }
  registerProjectInitHandlers({
    ipcMain,
    expandHome: (p) => (p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p),
    pathExists: async (p) => {
      try { await fs.access(p); return true } catch { return false }
    },
    templateBaseDir,
  })
  return { handlers, templateBaseDir }
}

const ALL = ['agents', 'claude', 'memory', 'specs', 'gitignore']

describe('V1.8.3 新建项目 v2 模板', () => {
  let handlers
  let templateBaseDir
  let tempBasePath

  beforeEach(async () => {
    const r = createRegisteredHandlers()
    handlers = r.handlers
    templateBaseDir = r.templateBaseDir
    tempBasePath = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-v2-test-'))
  })

  afterEach(async () => {
    await fs.rm(tempBasePath, { recursive: true, force: true })
  })

  it('BE-2: validate 的 templatePlans 含 specs(dir) 与 gitignore(file→.gitignore)', async () => {
    const validate = handlers.get('project-init-validate')
    const result = await validate({}, {
      projectName: 'p', targetPath: tempBasePath, gitMode: 'none', templates: ALL, overwrite: false,
    })
    expect(result.valid).toBe(true)
    const plans = result.data.templatePlans
    expect(plans.find((p) => p.key === 'specs').type).toBe('dir')
    const gi = plans.find((p) => p.key === 'gitignore')
    expect(gi.type).toBe('file')
    expect(gi.targetPath.endsWith('.gitignore')).toBe(true)
  })

  it('BE-1/BE-9: execute 生成 specs 工作单元树 + .gitignore', async () => {
    const execute = handlers.get('project-init-execute')
    const projectRoot = path.join(tempBasePath, 'p1')
    const result = await execute({}, {
      projectName: 'p1', targetPath: tempBasePath, gitMode: 'none', templates: ALL, overwrite: false,
    })
    expect(result.success).toBe(true)
    const unit = path.join(projectRoot, 'specs', '_example-示例功能')
    for (const f of ['1-plan.md', '2-design.md', '3-prd.md', '4-test-cases.md', 'README.md']) {
      await expect(fs.access(path.join(unit, f))).resolves.toBeUndefined()
    }
    await expect(fs.access(path.join(unit, '_review', 'index.html'))).resolves.toBeUndefined()
    await expect(fs.access(path.join(projectRoot, 'specs', 'README.md'))).resolves.toBeUndefined()
    await expect(fs.access(path.join(projectRoot, '.gitignore'))).resolves.toBeUndefined()
  })

  it('BE-3: AGENTS.md 首行为 # AGENTS.md（标题 bug 已修）', async () => {
    const execute = handlers.get('project-init-execute')
    const projectRoot = path.join(tempBasePath, 'p2')
    await execute({}, { projectName: 'p2', targetPath: tempBasePath, gitMode: 'none', templates: ['agents', 'claude'], overwrite: false })
    const agents = await fs.readFile(path.join(projectRoot, 'AGENTS.md'), 'utf-8')
    expect(agents.split('\n')[0]).toBe('# AGENTS.md')
  })

  it('BE-4: AGENTS 与 CLAUDE 除首行一致，且都含同步提示', async () => {
    const execute = handlers.get('project-init-execute')
    const projectRoot = path.join(tempBasePath, 'p3')
    await execute({}, { projectName: 'p3', targetPath: tempBasePath, gitMode: 'none', templates: ['agents', 'claude'], overwrite: false })
    const a = (await fs.readFile(path.join(projectRoot, 'AGENTS.md'), 'utf-8')).split('\n')
    const c = (await fs.readFile(path.join(projectRoot, 'CLAUDE.md'), 'utf-8')).split('\n')
    expect(a.slice(1).join('\n')).toBe(c.slice(1).join('\n'))
    expect(a.join('\n')).toContain('改一份请同步另一份')
  })

  it('BE-5: 勾记忆系统时追加记忆协议且含「最近 7 天」', async () => {
    const execute = handlers.get('project-init-execute')
    const projectRoot = path.join(tempBasePath, 'p4')
    await execute({}, { projectName: 'p4', targetPath: tempBasePath, gitMode: 'none', templates: ['agents', 'memory'], overwrite: false })
    const agents = await fs.readFile(path.join(projectRoot, 'AGENTS.md'), 'utf-8')
    expect(agents).toContain('冷启动') // 仅 memory-protocol.md 追加才有
    expect(agents).toContain('最近 7 天')
  })

  it('BE-7: 目标已存在 specs/ → 报冲突，不合并', async () => {
    const validate = handlers.get('project-init-validate')
    const projectRoot = path.join(tempBasePath, 'p5')
    await fs.mkdir(path.join(projectRoot, 'specs'), { recursive: true })
    const result = await validate({}, { projectName: 'p5', targetPath: tempBasePath, gitMode: 'none', templates: ['specs'], overwrite: false })
    expect(result.valid).toBe(false)
    expect(result.data.conflicts.some((c) => c.path && c.path.endsWith('specs'))).toBe(true)
  })

  it('BE-8: 旧 payload（无 specs/gitignore）仍正常，不建 specs/', async () => {
    const execute = handlers.get('project-init-execute')
    const projectRoot = path.join(tempBasePath, 'p6')
    const result = await execute({}, { projectName: 'p6', targetPath: tempBasePath, gitMode: 'none', templates: ['agents', 'claude', 'memory'], overwrite: false })
    expect(result.success).toBe(true)
    await expect(fs.access(path.join(projectRoot, 'specs'))).rejects.toBeTruthy()
    await expect(fs.access(path.join(projectRoot, '.gitignore'))).rejects.toBeTruthy()
  })

  it('BE-6: runSafeRollback 删除 createdTrees 整树', async () => {
    const treePath = path.join(tempBasePath, 'tree-x')
    await fs.mkdir(path.join(treePath, 'sub'), { recursive: true })
    await fs.writeFile(path.join(treePath, 'sub', 'a.md'), 'x')
    const pathExists = async (p) => { try { await fs.access(p); return true } catch { return false } }
    const rb = await runSafeRollback({
      createdFiles: [], createdTrees: [treePath], createdDirectories: [],
      createdGitDir: null, projectRootCreated: false, projectRoot: null, overwrittenSnapshots: [],
    }, pathExists)
    expect(rb.success).toBe(true)
    expect(rb.steps.some((s) => s.step === 'ROLLBACK_REMOVE_TREE')).toBe(true)
    await expect(fs.access(treePath)).rejects.toBeTruthy()
  })

  it('GN-1/GN-2: 模板通用化 — 不含 CodePal 专属词', async () => {
    const forbidden = /design-operating-system|cool steel|pageshell|派生快照|双层仓库/i
    const files = ['AGENTS.md', 'CLAUDE.md', 'specs/README.md', 'specs/_example-示例功能/2-design.md']
    for (const f of files) {
      const content = await fs.readFile(path.join(templateBaseDir, f), 'utf-8')
      expect(forbidden.test(content), `${f} 含专属词`).toBe(false)
    }
  })
})
