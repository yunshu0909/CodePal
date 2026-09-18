/**
 * Claude Code 设置页入口与删减静态检查
 *
 * 负责：
 * - 侧栏只保留「Claude Code 设置」入口，旧 statusline-settings 模块整体下线
 * - 旧额度链路、模型 Tab 与主进程 Codex 额度服务已删除
 * - 模型配置与权限重置 / 恢复主进程接口、全局 statusLine 静默维护保留
 * - 焦点光圈只写在 :focus-visible
 *
 * @module tests/claudeSettingsWiring.test
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')
const exists = (rel) => fs.existsSync(path.join(root, rel))

describe('入口', () => {
  it('TC-001 侧栏「工具设置」首项为 Claude Code 设置，没有状态栏设置', () => {
    const nav = read('src/components/WorkbenchLayout.jsx')
    expect(nav).toMatch(/id:\s*'permission',\s*label:\s*'Claude Code 设置'/)
    expect(nav).not.toContain('statusline-settings')
    expect(nav).not.toContain('状态栏设置')
  })

  it('TC-002 statusline-settings 模块下线，旧值回落到 permission', () => {
    const app = read('src/App.jsx')
    expect(app).not.toContain('statusline-settings')
    expect(app).not.toContain('StatusLineSettingsPage')
    expect(app).toContain("DEFAULT_ACTIVE_MODULE = 'permission'")
    expect(app).toContain("activeModule === 'permission' && <PermissionModePage />")
  })
})

describe('删减与保留', () => {
  it('TC-024 Codex 额度接口删除，模型配置、权限重置与静默维护保留', () => {
    const preload = read('electron/preload.js')
    const main = read('electron/main.js')
    const app = read('src/App.jsx')
    expect(preload).not.toContain('getCodexUsageStatusState')
    expect(main).not.toContain('registerCodexUsageStatusHandlers')
    for (const rel of [
      'electron/handlers/registerCodexUsageStatusHandlers.js',
      'electron/services/codexUsageStatusService.js',
      'src/pages/ModelConfigTab.jsx',
      'src/pages/StatusLineSettingsPage.jsx',
      'src/pages/ClaudeUsageStatusPage.jsx',
      'src/pages/usage.css',
      'src/styles/permission-mode.css',
      'src/pages/usage/useCodexUsageStatus.js',
      'src/pages/usage/components/DualUsageCard.jsx',
      'src/pages/usage/components/DualUsageCard.css',
      'src/pages/usage/components/ClaudeUsageColumn.jsx',
      'src/pages/usage/components/CodexUsageColumn.jsx',
      'src/pages/usage/components/usageColumnKit.jsx',
      'src/pages/usage/components/ClaudeUsageSettingsModal.jsx',
      'src/pages/usage/components/ClaudeUsageSettingsModal.css',
      'src/pages/usage/components/ClaudeUsageStatusCard.jsx',
      'src/pages/usage/components/ClaudeUsageStatusCard.css',
    ]) expect(exists(rel), rel).toBe(false)
    for (const api of ['getModelConfig', 'setModelConfig', 'resetModelConfig', 'resetPermissionMode', 'restorePermissionMode']) {
      expect(preload).toContain(`${api}:`)
    }
    expect(app).toContain("ensureClaudeUsageStatusInstalled({ force: false, intent: 'silent' })")
    const pkg = JSON.parse(read('package.json'))
    expect(Object.keys(pkg.scripts)).not.toContain('test:statusline-settings')
  })

  it('TC-035 / TC-042 焦点光圈只写在 :focus-visible，预览行单行省略，接管弹窗样式随弹窗保留', () => {
    const css = read('src/pages/claudeSettings/claudeSettings.css')
    expect(css).toMatch(/\.cc-pop:focus\s*\{\s*outline:\s*none;?\s*\}/)
    expect(css).toContain('.cc-pop:focus-visible')
    expect(css).toMatch(/\.cc-term div\s*\{[^}]*white-space:\s*nowrap;[^}]*text-overflow:\s*ellipsis/)
    expect(css).toMatch(/\.cc-btn:focus\s*\{\s*outline:\s*none;?\s*\}/)
    const modal = read('src/pages/usage/components/ClaudeStatusLineTakeoverModal.jsx')
    expect(modal).toContain("import './ClaudeStatusLineTakeoverModal.css'")
    expect(read('src/pages/usage/components/ClaudeStatusLineTakeoverModal.css')).toContain('.claude-takeover-copy')
  })
})
