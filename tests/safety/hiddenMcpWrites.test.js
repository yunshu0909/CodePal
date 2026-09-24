/**
 * 隐藏 MCP 停止写入 — 接线守护测试（架构优化第一批 Task 1）
 *
 * 负责：
 * - 主进程启动不再调用 provider_registry 安装逻辑（它会往 ~/.claude.json、~/.codex/config.toml 补写条目）
 * - 主进程不再注册 mcp:* 通道，preload 不再暴露 electronAPI.mcp
 * - mcp 不再是有效页面模块
 * - mcp/ 脚本仍随包发布：用户配置里已写入的条目还指向它，第②步清理前不能删
 *
 * 主进程入口无法在单测里真实启动，这里用源码结构断言守住接线；真实启动由 _review/smoke 的隔离 HOME 冒烟覆盖。
 *
 * @module tests/safety/hiddenMcpWrites.test
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(__dirname, '..', '..')
const read = (rel) => readFileSync(resolve(root, rel), 'utf-8')
// 去掉注释再断言：注释里提到旧名字不算接线
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

describe('Task 1 · 停止隐藏 MCP 的新增写入', () => {
  it('TC-1 主进程启动不再调用 provider_registry 安装逻辑', () => {
    const main = code('electron/main.js')
    expect(main).not.toMatch(/builtinMcpInstallerService/)
    expect(main).not.toMatch(/ensureBuiltinProviderRegistryInstalled/)
  })

  it('TC-2 主进程不再注册 MCP 管理接口', () => {
    const main = code('electron/main.js')
    expect(main).not.toMatch(/registerMcpHandlers/)
  })

  it('TC-3 preload 不再暴露 mcp 接口', () => {
    const preload = code('electron/preload.js')
    expect(preload).not.toMatch(/['"]mcp:/)
    expect(preload).not.toMatch(/^\s*mcp\s*:/m)
  })

  it('TC-4 mcp 不再是有效页面模块', () => {
    const app = code('src/App.jsx')
    const valid = app.match(/VALID_ACTIVE_MODULES\s*=\s*new Set\(\[([^\]]*)\]\)/)
    expect(valid).not.toBeNull()
    expect(valid[1]).not.toMatch(/['"]mcp['"]/)
    expect(app).not.toMatch(/McpPage/)
  })

  it('TC-5 mcp/ 脚本仍随包发布（用户配置仍引用它）', () => {
    const pkg = JSON.parse(read('package.json'))
    expect(pkg.build.files).toContain('mcp/**/*')
    expect(existsSync(resolve(root, 'mcp/provider_registry_mcp.js'))).toBe(true)
  })
})
