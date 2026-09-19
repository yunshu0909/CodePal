/**
 * 会话状态监听与通知测试（#41）
 *
 * 负责：
 * - 第一份快照只记不通知
 * - 进入「等你确认」「完成了」各发一次，彩色小图与提示音不同；同一状态不重复；进行中不发
 * - 本页在前台时不发；功能关着时列表为空、不发
 *
 * @module tests/sessionStatusMonitor
 */

import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { createSessionStatusMonitor, buildSessionNotification } = require('../electron/services/sessionStatusMonitor')

const S = (state, extra = {}) => ({ key: 's1', state, epoch: 1, name: 'skills', source: 'Codex', task: '整理 ISSUES', ...extra })

function setup({ enabled = true, front = false } = {}) {
  let list = { sessions: [], total: 0 }
  const notify = vi.fn()
  const onChange = vi.fn()
  const monitor = createSessionStatusMonitor({
    statesDir: '/tmp/unused',
    listSessions: async () => list,
    isEnabled: () => enabled,
    isPageInFront: () => front,
    onChange,
    notify,
    iconDir: '/icons',
  })
  return { monitor, notify, onChange, set: (sessions) => { list = { sessions, total: sessions.length } } }
}

describe('sessionStatusMonitor', () => {
  it('第一份快照不通知；之后进入等你确认 / 完成了各通知一次，进行中和重复不发', async () => {
    const t = setup()
    t.set([S('attention')])
    await t.monitor.refresh()
    expect(t.notify).not.toHaveBeenCalled()

    t.set([S('busy')])
    await t.monitor.refresh()
    expect(t.notify).not.toHaveBeenCalled()

    t.set([S('attention', { ask: '要不要删掉旧分支？' })])
    await t.monitor.refresh()
    await t.monitor.refresh()
    expect(t.notify).toHaveBeenCalledTimes(1)
    expect(t.notify).toHaveBeenLastCalledWith({ title: 'skills · Codex 等你确认', body: '要不要删掉旧分支？', icon: '/icons/ask.png', sound: 'Ping' })

    t.set([S('done')])
    await t.monitor.refresh()
    expect(t.notify).toHaveBeenCalledTimes(2)
    expect(t.notify).toHaveBeenLastCalledWith({ title: 'skills · Codex 完成了', body: '整理 ISSUES', icon: '/icons/done.png', sound: 'Glass' })
    expect(t.onChange).toHaveBeenLastCalledWith({ sessions: [S('done')], total: 1, error: null })
  })

  it('本页在前台时只更新列表不发通知', async () => {
    const t = setup({ front: true })
    t.set([])
    await t.monitor.refresh()
    t.set([S('done')])
    await t.monitor.refresh()
    expect(t.notify).not.toHaveBeenCalled()
    expect(t.onChange).toHaveBeenCalledTimes(2)
  })

  it('功能关着：列表为空、不发通知', async () => {
    const t = setup({ enabled: false })
    await t.monitor.refresh()
    t.set([S('done')])
    await t.monitor.refresh()
    expect(t.notify).not.toHaveBeenCalled()
    expect(t.onChange).toHaveBeenLastCalledWith({ sessions: [], total: 0, error: null })
  })

  it('reset 之后重新记快照：刚打开时已有的状态不补发', async () => {
    const t = setup()
    await t.monitor.refresh()
    t.monitor.reset()
    t.set([S('done')])
    await t.monitor.refresh()
    expect(t.notify).not.toHaveBeenCalled()
  })

  it('同时触发多次重算也只通知一次', async () => {
    const t = setup()
    await t.monitor.refresh()
    t.set([S('done')])
    await Promise.all([t.monitor.refresh(), t.monitor.refresh(), t.monitor.refresh()])
    expect(t.notify).toHaveBeenCalledTimes(1)
  })

  it('读取失败时把原因推给页面', async () => {
    const monitor = createSessionStatusMonitor({
      statesDir: '/tmp/unused', listSessions: async () => { throw new Error('EACCES') }, isEnabled: () => true,
      isPageInFront: () => false, onChange: vi.fn(), notify: vi.fn(), iconDir: '/i',
    })
    expect(await monitor.refresh()).toEqual({ sessions: [], total: 0, error: 'EACCES' })
  })

  it('通知内容：完成时没有「在干嘛」就只写标题', () => {
    expect(buildSessionNotification(S('done', { task: '' }), '/i').body).toBe('')
    expect(buildSessionNotification(S('busy'), '/i')).toBeNull()
  })
  it('通知用的两张彩色小图真实存在，并在打包范围（electron/**）内', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const iconDir = path.join(root, 'electron', 'assets', 'notify')
    for (const name of ['done.png', 'ask.png']) {
      const file = path.join(iconDir, name)
      expect(fs.existsSync(file)).toBe(true)
      expect(fs.readFileSync(file).subarray(1, 4).toString()).toBe('PNG')
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
    expect(pkg.build.files).toContain('electron/**/*')
  })
})
