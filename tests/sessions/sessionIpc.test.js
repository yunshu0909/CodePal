/**
 * 对话回顾 IPC 与数据目录覆盖测试
 *
 * 负责：
 * - AC-11：handler 注册的 channel 集合；preload 改名、去掉删除
 * - 环境变量 CODEPAL_CLAUDE_PROJECTS_DIR 对两个服务都生效（截图与端到端用构造数据）
 *
 * @module tests/sessions/sessionIpc.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { L, stamp, makeProjectsDir } from './fixtures'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

afterEach(() => {
  delete process.env.CODEPAL_CLAUDE_PROJECTS_DIR
  vi.resetModules()
})

describe('IPC 注册', () => {
  it('TC-11 只注册 listRecent / readSession / search', () => {
    const { registerSessionBrowserHandlers } = require('../../electron/handlers/registerSessionBrowserHandlers.js')
    const channels = []
    registerSessionBrowserHandlers({ ipcMain: { handle: (ch) => channels.push(ch) } })
    expect(channels.sort()).toEqual(['session:listRecent', 'session:readSession', 'session:search'])
  })

  it('TC-11 preload 暴露新方法、不再有删除与旧列表', () => {
    const src = fs.readFileSync(path.join(root, 'electron/preload.js'), 'utf8')
    expect(src).toContain('listRecentSessions')
    expect(src).toContain("'session:listRecent'")
    expect(src).not.toContain('deleteSession')
    expect(src).not.toContain('session:listProjects')
    expect(src).not.toContain('session:listSessions')
    expect(src).not.toContain("'session:delete'")
  })

  it('TC-11 handler 返回统一结构；readSession 透传分页参数', async () => {
    const service = require('../../electron/services/sessionBrowserService.js')
    const spy = vi.spyOn(service, 'readSessionPage').mockResolvedValue({ messages: [], hasMore: false, cursor: 0 })
    const { registerSessionBrowserHandlers } = require('../../electron/handlers/registerSessionBrowserHandlers.js')
    const handlers = {}
    registerSessionBrowserHandlers({ ipcMain: { handle: (ch, fn) => { handlers[ch] = fn } } })
    const res = await handlers['session:readSession']({}, '-a', 's1', { limit: 50, before: 123 })
    expect(res).toEqual({ success: true, data: { messages: [], hasMore: false, cursor: 0 }, error: null })
    expect(spy).toHaveBeenCalledWith('-a', 's1', { limit: 50, before: 123 })
    spy.mockRejectedValueOnce(new Error('INVALID_ID'))
    expect(await handlers['session:readSession']({}, '..', 's1', {})).toEqual({ success: false, data: null, error: 'INVALID_ID' })
    spy.mockRestore()
  })
})

describe('数据目录覆盖', () => {
  it('TC-11 CODEPAL_CLAUDE_PROJECTS_DIR 对列表与工作目录读取都生效', async () => {
    const p = makeProjectsDir()
    try {
      p.write('-a', '11111111-2222-3333-4444-555555555555', stamp([L.user('构造对话')], { cwd: p.dir }))
      process.env.CODEPAL_CLAUDE_PROJECTS_DIR = p.dir
      const service = require('../../electron/services/sessionBrowserService.js')
      const resume = require('../../electron/services/sessionResumeService.js')
      const { sessions } = await service.listRecent()
      expect(sessions.map((s) => s.title)).toEqual(['构造对话'])
      const cwd = await resume.readSessionCwd('-a', '11111111-2222-3333-4444-555555555555')
      expect(cwd).toEqual({ cwd: p.dir, cwdExists: true })
    } finally {
      p.cleanup()
    }
  })
})
