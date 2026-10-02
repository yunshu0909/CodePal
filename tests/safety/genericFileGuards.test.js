/**
 * 渲染层 store 键止损 — 行为测试（架构优化第一批 Task 3）
 *
 * 负责：
 * - 渲染层 store 键白名单（只开放用量目标两个键）
 * - main.js 的 get/set/delete-store 都经过白名单检查；导航守卫拿到应用入口路径（源码结构断言，主进程入口无法在单测里真实启动）
 *
 * 原先这里还测配置读写、Skill 复制与删除这几个通用文件入口（TC-1～6、9、10，R-1～8）；
 * 它们只服务 Skills 旧导入 / 推送引擎，已随旧引擎退役删除（specs/v2.1.9-Skills只留一套引擎），
 * 不复活由 tests/safety/deadCode.test.js 的 TC-001 守着。
 *
 * @module tests/safety/genericFileGuards.test
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const guards = require('../../electron/services/genericFileGuards')

describe('store', () => {
  it('TC-7 store 只开放用量目标两个键', () => {
    expect(guards.isRendererStoreKey('usageGoal')).toBe(true)
    expect(guards.isRendererStoreKey('usageGoalDismissed')).toBe(true)
    for (const key of ['plan', 'codepal-active-module', 'docBrowser', '', null]) expect(guards.isRendererStoreKey(key)).toBe(false)
  })
})

describe('main.js 接线', () => {
  const main = readFileSync(path.resolve(__dirname, '..', '..', 'electron', 'main.js'), 'utf-8')
  const handler = (channel) => {
    const start = main.indexOf(`ipcMain.handle('${channel}'`)
    expect(start).toBeGreaterThan(-1)
    return main.slice(start, main.indexOf('\n})', start))
  }

  it('TC-7 get/set/delete-store 检查键白名单', () => {
    for (const ch of ['get-store', 'set-store', 'delete-store']) expect(handler(ch)).toMatch(/isRendererStoreKey\(/)
  })
  it('TC-8 导航守卫拿到应用入口路径', () => expect(main).toMatch(/appEntryPath/))
})
