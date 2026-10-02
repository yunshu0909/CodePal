/**
 * 新建项目 · 创建时 Git 找不到 / git 报错（specs/v2.1.7-新建项目小修 TC-002、TC-005）
 *
 * 负责：启动 git 失败（找不到可执行文件）时失败原因转述成「没找到 Git」；
 * git 跑起来后报错、文件读写缺文件时仍显示原始信息。都要整体撤回。
 * 全部在临时目录里建项目，PATH 只在传给 git 的环境里替换，不碰本机配置。
 *
 * @module tests/projectInit/gitMissing
 */
import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const root = path.resolve(__dirname, '..', '..')
const templateBaseDir = path.join(root, 'templates', 'project-init-v4')
const svc = require('../../electron/services/projectInitService.js')
const tempDirs = []

function tempDir(prefix = 'pi-') {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true })
})

const identity = (p) => p

/** 只含给定脚本的 PATH；不给脚本时是一个空目录（找不到 git） */
function pathWith(gitScript) {
  const bin = tempDir('pi-bin-')
  if (gitScript) {
    const file = path.join(bin, 'git')
    writeFileSync(file, gitScript)
    chmodSync(file, 0o755)
  }
  const home = tempDir('pi-home-')
  return { PATH: bin, HOME: home, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1' }
}

async function create(gitEnv, fsOps) {
  const target = tempDir('pi-target-')
  const res = await svc.executeProjectInit(
    { projectName: 'my-app', targetPath: target, codeDirName: 'code', gitMode: 'dual' },
    { expandHome: identity, templateBaseDir, gitEnv, fsOps },
  )
  return { res, proj: path.join(target, 'my-app') }
}

describe('创建时 Git 找不到', () => {
  it('TC-002 GIT_MISSING PATH 里没有 git：建 Git 仓时失败，原因是没找到 Git，整体撤回；缺文件不误报', async () => {
    const { res, proj } = await create(pathWith(null))
    expect(res.success, 'GIT_MISSING').toBe(false)
    expect(res.data.failedStep, 'GIT_MISSING').toBe('建 Git 仓')
    expect(res.data.reason, 'GIT_MISSING').toBe('没找到 Git')
    expect(existsSync(proj), 'GIT_MISSING 没撤回').toBe(false)

    const fs = await import('node:fs/promises')
    const missingFile = {
      mkdir: fs.mkdir,
      writeFile: async (file, ...rest) => {
        if (file.endsWith('MEMORY.md')) {
          const error = new Error(`ENOENT: no such file or directory, open '${file}'`)
          error.code = 'ENOENT'
          error.path = file
          error.syscall = 'open'
          throw error
        }
        return fs.writeFile(file, ...rest)
      },
    }
    const second = await create(pathWith(null), missingFile)
    expect(second.res.success, 'GIT_MISSING').toBe(false)
    expect(second.res.data.reason, 'GIT_MISSING 缺文件误报成没找到 Git').not.toBe('没找到 Git')
    expect(second.res.data.reason, 'GIT_MISSING').toContain('ENOENT')
  })

  it('TC-005 git 跑起来后报错：仍显示原始报错，不是没找到 Git，整体撤回', async () => {
    const { res, proj } = await create(pathWith('#!/bin/sh\necho "fatal: boom-from-git" >&2\nexit 1\n'))
    expect(res.success).toBe(false)
    expect(res.data.failedStep).toBe('建 Git 仓')
    expect(res.data.reason).not.toBe('没找到 Git')
    expect(res.data.reason).toContain('boom-from-git')
    expect(existsSync(proj)).toBe(false)
  })
})

