/**
 * 新建项目 · 执行创建（#59，specs/v2.1.6-新建项目 TC-009〜012）
 *
 * 负责：真 Git 下双层 / 只给代码建仓 / 跳过三档、Git 没配名字和邮箱、写到一半失败的整体撤回。
 * 全部在临时目录里建项目；Git 用临时 HOME 和独立全局配置，不碰本机真实配置。
 *
 * @module tests/projectInit/execute
 */
import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

// 共用小工具各测试文件各带一份（TDD 只允许声明过的测试文件在 RED 前出现）
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const root = path.resolve(__dirname, '..', '..')
const templateBaseDir = path.join(root, 'templates', 'project-init-v4')
const tempDirs = []

/** 新建一个临时目录，测试结束时 cleanupTemp() 统一删 */
function tempDir(prefix = 'pi-') {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function cleanupTemp() {
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true })
}

/**
 * 隔离的 Git 环境：临时 HOME + 独立的全局配置文件，不碰本机真实配置
 * @param {boolean} withIdentity - 是否配好提交用的名字和邮箱
 */
function gitEnv(withIdentity) {
  const home = tempDir('pi-home-')
  const globalConfig = path.join(home, '.gitconfig')
  writeFileSync(globalConfig, withIdentity ? '[user]\n\tname = 测试\n\temail = test@example.invalid\n' : '')
  return { HOME: home, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: '', GIT_COMMITTER_NAME: '', EMAIL: '' }
}

/** 加载主进程服务；还不存在或没有某个导出时返回 null，让测试以本行标记失败 */
function loadService() {
  try {
    return require('../../electron/services/projectInitService.js')
  } catch {
    return null
  }
}

const identity = (p) => p.replace(/^~(?=$|\/)/, os.homedir())

afterEach(() => cleanupTemp())

const git = (cwd, args, env) => execFileSync('git', args, { cwd, env: { ...process.env, ...env }, encoding: 'utf-8' }).trim()

async function create(gitMode, { withIdentity = true, codeDirName = 'code', fsOps } = {}) {
  const svc = loadService()
  if (!svc || typeof svc.executeProjectInit !== 'function') return { svc: null }
  const dir = tempDir()
  const env = gitEnv(withIdentity)
  const res = await svc.executeProjectInit(
    { projectName: 'my-app', targetPath: dir, codeDirName, gitMode },
    { expandHome: identity, templateBaseDir, gitEnv: env, fsOps },
  )
  return { svc, res, root: path.join(dir, 'my-app'), env, dir }
}

describe('执行创建', () => {
  it('TC-009 EXEC_DUAL 双层：整套生成，两个仓都在 main 上各一个初始提交，外层不收代码文件夹', async () => {
    const { svc, res, root: proj, env } = await create('dual')
    expect(svc, 'EXEC_DUAL').toBeTruthy()
    expect(res.success, 'EXEC_DUAL').toBe(true)
    expect(res.data, 'EXEC_DUAL').toMatchObject({ projectPath: proj, commit: 'done' })
    const { buildManifest } = await import(/* @vite-ignore */ pathToFileURL(path.join(root, 'shared', 'projectInitManifest.mjs')).href)
    for (const item of buildManifest({ gitMode: 'dual', codeDir: 'code' })) {
      expect(existsSync(path.join(proj, item.path)), `EXEC_DUAL ${item.path}`).toBe(true)
    }
    for (const repo of [proj, path.join(proj, 'code')]) {
      expect(git(repo, ['branch', '--show-current'], env), 'EXEC_DUAL').toBe('main')
      expect(git(repo, ['log', '--format=%s'], env), 'EXEC_DUAL').toBe('初始化项目结构')
    }
    expect(git(proj, ['ls-files'], env).split('\n').some((f) => f.startsWith('code/')), 'EXEC_DUAL').toBe(false)
    // 不再生成旧的示例单元与「记忆协议（详细）」附录
    expect(readdirSync(path.join(proj, 'specs')), 'EXEC_DUAL').toEqual(['README.md'])
    expect(readFileSync(path.join(proj, 'CLAUDE.md'), 'utf-8'), 'EXEC_DUAL').not.toContain('记忆协议（详细）')
  })

  it('TC-010 EXEC_MODES 只给代码建仓只有代码仓；跳过没有任何 .git', async () => {
    const codeOnly = await create('code')
    expect(codeOnly.svc, 'EXEC_MODES').toBeTruthy()
    expect(codeOnly.res.data.commit, 'EXEC_MODES').toBe('done')
    expect(existsSync(path.join(codeOnly.root, '.git')), 'EXEC_MODES').toBe(false)
    expect(git(path.join(codeOnly.root, 'code'), ['log', '--format=%s'], codeOnly.env), 'EXEC_MODES').toBe('初始化项目结构')

    const none = await create('none')
    expect(none.res.data.commit, 'EXEC_MODES').toBe('skipped-no-git')
    expect(existsSync(path.join(none.root, '.git')), 'EXEC_MODES').toBe(false)
    expect(existsSync(path.join(none.root, 'code', '.git')), 'EXEC_MODES').toBe(false)
  })

  it('TC-011 EXEC_NO_IDENTITY Git 没配名字和邮箱：仓建好、不提交、不撤回', async () => {
    const { svc, res, root: proj, env } = await create('dual', { withIdentity: false })
    expect(svc, 'EXEC_NO_IDENTITY').toBeTruthy()
    expect(res.success, 'EXEC_NO_IDENTITY').toBe(true)
    expect(res.data.commit, 'EXEC_NO_IDENTITY').toBe('skipped-no-identity')
    expect(existsSync(path.join(proj, '.git')), 'EXEC_NO_IDENTITY').toBe(true)
    expect(existsSync(path.join(proj, 'code', '.git')), 'EXEC_NO_IDENTITY').toBe(true)
    expect(() => git(proj, ['rev-parse', 'HEAD'], env), 'EXEC_NO_IDENTITY').toThrow()
  })

  it('TC-012 EXEC_ROLLBACK 写 docs/ 时失败：返回哪一步与原因，项目目录整个撤回', async () => {
    const fs = await import('node:fs/promises')
    const failing = {
      mkdir: fs.mkdir,
      writeFile: async (file, ...rest) => {
        if (file.includes(`${path.sep}docs${path.sep}`)) {
          const error = new Error('permission denied')
          error.code = 'EACCES'
          throw error
        }
        return fs.writeFile(file, ...rest)
      },
    }
    const { svc, res, root: proj } = await create('dual', { fsOps: failing })
    expect(svc, 'EXEC_ROLLBACK').toBeTruthy()
    expect(res.success, 'EXEC_ROLLBACK').toBe(false)
    expect(res.data.failedStep, 'EXEC_ROLLBACK').toMatch(/^写入 docs\//)
    expect(res.data.reason, 'EXEC_ROLLBACK').toBe('目标路径不可写')
    expect(res.data.rollback.success, 'EXEC_ROLLBACK').toBe(true)
    expect(existsSync(proj), 'EXEC_ROLLBACK').toBe(false)
  })
})
