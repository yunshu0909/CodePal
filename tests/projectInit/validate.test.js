/**
 * 新建项目 · 创建前校验（#59，specs/v2.1.6-新建项目 TC-004〜008）
 *
 * 负责：项目名称非法、同名目录已存在、代码文件夹撞名与非法、Git 三档、路径不可写（现有文案）。
 * 全部在临时目录里校验，不碰真实家目录。
 *
 * @module tests/projectInit/validate
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, chmodSync, existsSync } from 'node:fs'
// 共用小工具各测试文件各带一份（TDD 只允许声明过的测试文件在 RED 前出现）
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const root = path.resolve(__dirname, '..', '..')
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

const exists = async (p) => existsSync(p)

/** 新旧两种签名都能调：新版 (params, expandHome)，旧版多出 pathExists、模板目录与配置 */
async function validate(params) {
  const svc = loadService()
  if (!svc) return null
  let cfg = {}
  try { cfg = require('../../electron/config/projectInitConfig.js') } catch { cfg = {} }
  const res = await svc.validateProjectInitParams(params, identity, exists, path.join(root, 'templates', 'project-init-v3'), cfg)
  return { valid: res.valid, errors: res.errors || res.data?.errors || [] }
}

const base = (dir, extra = {}) => ({ projectName: 'my-app', targetPath: dir, codeDirName: 'code', gitMode: 'dual', ...extra })
const errorOf = (res, field) => res && res.errors.find((e) => e.field === field)

describe('创建前校验', () => {
  it('TC-004 NAME_INVALID 项目名称含非法字符或为 . / ..', async () => {
    const dir = tempDir()
    for (const name of ['a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b', '.', '..']) {
      const res = await validate(base(dir, { projectName: name }))
      expect(errorOf(res, 'projectName')?.message, `NAME_INVALID ${name}`).toBe('项目名称包含非法字符')
    }
  })

  it('TC-005 ROOT_EXISTS 同名目录已存在（哪怕是空目录）就算冲突', async () => {
    const dir = tempDir()
    mkdirSync(path.join(dir, 'my-app'))
    const res = await validate(base(dir))
    expect(res?.valid, 'ROOT_EXISTS').toBe(false)
    expect(errorOf(res, 'projectName'), 'ROOT_EXISTS').toMatchObject({ code: 'TARGET_CONFLICT', message: '目标路径存在冲突' })
  })

  it('TC-006 CODE_DIR_RULES 代码文件夹撞名（不分大小写）、非法、为空按 code', async () => {
    const dir = tempDir()
    for (const name of ['docs', 'Docs', 'specs', 'issues', 'MEMORY.md', '.dev-workflow']) {
      const res = await validate(base(dir, { codeDirName: name }))
      expect(errorOf(res, 'codeDirName'), `CODE_DIR_RULES ${name}`).toMatchObject({ code: 'CODE_DIR_CONFLICT', message: '不能和外层的文件或文件夹同名' })
    }
    const bad = await validate(base(dir, { codeDirName: 'a/b' }))
    expect(errorOf(bad, 'codeDirName')?.message, 'CODE_DIR_RULES').toBe('代码文件夹名包含非法字符')
    const empty = await validate(base(dir, { codeDirName: '' }))
    expect(empty?.valid, 'CODE_DIR_RULES').toBe(true)
  })

  it('TC-007 GIT_MODES dual / code / none 通过，root 与其他值不支持', async () => {
    const dir = tempDir()
    for (const mode of ['dual', 'code', 'none']) {
      const res = await validate(base(dir, { gitMode: mode }))
      expect(res?.valid, `GIT_MODES ${mode}`).toBe(true)
    }
    for (const mode of ['root', 'both', '']) {
      const res = await validate(base(dir, { gitMode: mode }))
      expect(errorOf(res, 'gitMode')?.message, `GIT_MODES ${mode}`).toBe('Git 模式不受支持')
    }
  })

  it('TC-008 路径不可写 / 不是目录 / 为空时 field=targetPath，沿用原文', async () => {
    const dir = tempDir()
    const ro = path.join(dir, 'ro')
    mkdirSync(ro)
    chmodSync(ro, 0o555)
    try {
      const res = await validate(base(ro, { gitMode: 'none' }))
      expect(errorOf(res, 'targetPath')?.message).toBe('目标路径不可写')
    } finally {
      chmodSync(ro, 0o755)
    }
    // 另外两句沿用的原文：路径是文件、路径为空
    const file = path.join(dir, 'a-file')
    writeFileSync(file, 'x')
    expect(errorOf(await validate(base(file, { gitMode: 'none' })), 'targetPath')?.message).toBe('目标路径必须是目录')
    expect(errorOf(await validate(base('', { gitMode: 'none' })), 'targetPath')?.message).toBe('目标路径不能为空')
  })
})
