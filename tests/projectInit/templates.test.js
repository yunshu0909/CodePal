/**
 * 新建项目 · 模板内容与新项目里的工具（#59，specs/v2.1.6-新建项目 TC-013〜014）
 *
 * 负责：
 * - 协议两份一致、协议 v4 九节、项目名与代码文件夹名已替换；不含私人信息
 * - 私人路径清单只写 privatePaths（含 issues/，不含代码文件夹）；外层 .gitignore 跟着代码文件夹名
 * - 新项目里 issue-check、protocol-check 能直接跑通；生成的 ISSUES.md 就是工具生成的总览
 *
 * @module tests/projectInit/templates
 */
import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync, readdirSync, statSync, cpSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

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

async function createProject(gitMode, codeDirName) {
  const svc = loadService()
  if (!svc || typeof svc.executeProjectInit !== 'function') return null
  const dir = tempDir()
  const res = await svc.executeProjectInit(
    { projectName: 'demo-app', targetPath: dir, codeDirName, gitMode },
    { expandHome: identity, templateBaseDir, gitEnv: gitEnv(true) },
  )
  return res.success ? path.join(dir, 'demo-app') : null
}

/** 递归列出目录下的全部文件 */
function listFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    return statSync(full).isDirectory() ? listFiles(full) : [full]
  })
}

const PROTOCOL_SECTIONS = ['## 1. 你在哪', '## 2. 怎么协作', '## 3. 红线与必须先问', '## 4. 遇事去哪', '## 5. 记忆', '## 6. dev-workflow 项目参数', '## 7. 代码规范', '## 8. 知识地图', '## 9. 本协议怎么维护']
// 不能出现在模板里的私人信息：本机路径、用户名、邮箱、CodePal 自己的产品内容
const PRIVATE = [/\/Users\//, new RegExp(os.userInfo().username, 'i'), /yunshu/i, /@gmail/i, /trae_projects/, /skill-manager/, /0\.12\.5/, /design-operating-system/, /用量监测/, /订阅管理/]

describe('模板内容', () => {
  it('TC-013 TEMPLATE_CONTENT 协议、私人路径清单、.gitignore 与无私人信息', async () => {
    const proj = await createProject('dual', 'frontend')
    expect(proj, 'TEMPLATE_CONTENT').toBeTruthy()
    const claude = readFileSync(path.join(proj, 'CLAUDE.md'), 'utf-8')
    expect(readFileSync(path.join(proj, 'AGENTS.md'), 'utf-8'), 'TEMPLATE_CONTENT').toBe(claude)
    for (const heading of PROTOCOL_SECTIONS) expect(claude, `TEMPLATE_CONTENT ${heading}`).toContain(heading)
    expect(claude, 'TEMPLATE_CONTENT').toContain('demo-app')
    expect(claude, 'TEMPLATE_CONTENT').toContain('frontend/')
    expect(claude, 'TEMPLATE_CONTENT').not.toMatch(/\{\{[A-Z_]+\}\}/)

    const defaults = JSON.parse(readFileSync(path.join(proj, '.dev-workflow', 'project-defaults.json'), 'utf-8'))
    expect(Object.keys(defaults).filter((k) => k !== 'schemaVersion'), 'TEMPLATE_CONTENT').toEqual(['openSourceBoundary'])
    expect(defaults.openSourceBoundary.privatePaths, 'TEMPLATE_CONTENT').toEqual(
      expect.arrayContaining(['memory/', 'MEMORY.md', 'ISSUES.md', 'issues/', 'specs/', '.dev-workflow/']),
    )
    expect(defaults.openSourceBoundary.privatePaths.some((p) => /^(code|frontend)\/?$/.test(p)), 'TEMPLATE_CONTENT').toBe(false)

    const outerIgnore = readFileSync(path.join(proj, '.gitignore'), 'utf-8')
    expect(outerIgnore.split('\n'), 'TEMPLATE_CONTENT').toContain('frontend/')
    expect(statSync(path.join(proj, 'frontend', '.git')).isDirectory(), 'TEMPLATE_CONTENT').toBe(true)

    for (const file of listFiles(templateBaseDir)) {
      const text = readFileSync(file, 'utf-8')
      for (const re of PRIVATE) expect(re.test(text), `TEMPLATE_CONTENT ${path.relative(templateBaseDir, file)} ${re}`).toBe(false)
    }
  })

  it('TC-014 TOOLS_RUN 新项目里 issue-check 与 protocol-check 跑通，ISSUES.md 与工具输出一致', async () => {
    const proj = await createProject('none', 'code')
    expect(proj, 'TOOLS_RUN').toBeTruthy()
    const issue = spawnSync('python3', ['docs/issue-check.py', 'check'], { cwd: proj, encoding: 'utf-8' })
    expect(issue.status, `TOOLS_RUN ${issue.stdout}${issue.stderr}`).toBe(0)
    expect(issue.stdout, 'TOOLS_RUN').toContain('错误 0')
    const protocol = spawnSync('python3', ['docs/protocol-check.py'], { cwd: proj, encoding: 'utf-8' })
    expect(protocol.status, `TOOLS_RUN ${protocol.stdout}${protocol.stderr}`).toBe(0)

    const copy = path.join(tempDir(), 'copy')
    cpSync(proj, copy, { recursive: true })
    const build = spawnSync('python3', ['docs/issue-check.py', 'build', '--force'], { cwd: copy, encoding: 'utf-8' })
    expect(build.status, 'TOOLS_RUN').toBe(0)
    expect(readFileSync(path.join(copy, 'ISSUES.md'), 'utf-8'), 'TOOLS_RUN').toBe(readFileSync(path.join(proj, 'ISSUES.md'), 'utf-8'))
  })
})
