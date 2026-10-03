// @vitest-environment node
/**
 * Skill 管理页真实渲染检查（specs/skills-redesign-dev TC-045）
 *
 * 负责：
 * - 起一个真实的 CodePal 窗口（临时 HOME + 临时用户数据，不碰你正在用的配置和 Skill），前端走本测试自己起的 vite
 * - 放一个名字很长、说明很长、快捷方式指到很深中文目录的 Skill，在最小窗口 720 × 500 量：
 *   右栏没有横向滚动、路径与说明完整折行不截断、开关在可见范围
 * - 按定稿状态目录的窗口号截图，存到 SKILLS_SHOTS_DIR（默认系统临时目录下 codepal-skills-shots），给验收页和定稿图并排
 * - 只在 macOS 本机跑；CI 没有桌面环境，跳过
 *
 * @module tests/skills/SkillsPage.visual.test
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SKIP = Boolean(process.env.CI) || process.platform !== 'darwin'
const SHOTS = process.env.SKILLS_SHOTS_DIR || path.join(os.tmpdir(), 'codepal-skills-shots')

const LONG_NAME = 'a-very-long-skill-name-used-to-check-that-titles-and-paths-wrap-instead-of-being-cut'
const LONG_DESCRIPTION = '这是一段很长的说明，用来检查右栏的说明和提示文字会不会被截断：'.repeat(6)

function writeSkill(rootDir, name, description) {
  const dir = path.join(rootDir, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`)
  return dir
}

describe.skipIf(SKIP)('Skill 管理页真实渲染', () => {
  let server
  let app
  let win
  let tmp
  let home

  beforeAll(async () => {
    const { createServer } = await import('vite')
    const { _electron } = await import('playwright')
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codepal-skills-visual-'))
    home = path.join(tmp, 'home')
    const central = path.join(home, 'Documents', 'SkillManager')
    writeSkill(central, 'page-solution-design', '和用户一起敲定一个前端页面的整页方案')
    writeSkill(central, LONG_NAME, LONG_DESCRIPTION)
    // 用过 Codex 的样子：有 ~/.codex，Codex 的开关状态经它的官方接口读（临时目录，不碰真实配置）
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true })
    const claudeSkills = path.join(home, '.claude', 'skills')
    fs.mkdirSync(claudeSkills, { recursive: true })
    fs.symlinkSync(path.join(central, LONG_NAME), path.join(claudeSkills, LONG_NAME), 'dir')
    fs.symlinkSync(path.join(central, 'page-solution-design'), path.join(claudeSkills, 'page-solution-design'), 'dir')
    const deep = path.join(home, 'Documents', 'projects', '云舒的知识库', '分享', '2026-09-Harness工坊', 'PPT', 'skill')
    writeSkill(deep, 'baseplate-deck', '用主办方给的 PPT 模板（导出成逐页底板图）做一套有设计感的深色演讲 PPT')
    fs.symlinkSync(path.join(deep, 'baseplate-deck'), path.join(claudeSkills, 'baseplate-deck'), 'dir')
    fs.rmSync(SHOTS, { recursive: true, force: true })
    fs.mkdirSync(SHOTS, { recursive: true })

    server = await createServer({ root, logLevel: 'silent', server: { port: 0, strictPort: false } })
    await server.listen()
    const url = server.resolvedUrls.local[0]
    app = await _electron.launch({
      executablePath: path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
      args: ['.', `--user-data-dir=${path.join(tmp, 'userData')}`],
      cwd: root,
      env: { ...process.env, HOME: home, CODEX_HOME: path.join(home, '.codex'), ELECTRON_DEV_ALLOW_MULTI: '1', VITE_DEV_SERVER_URL: url },
    })
    win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await win.waitForTimeout(1500)
    await setSize(800, 600)
  }, 120000)

  afterAll(async () => {
    await app?.close().catch(() => {})
    await server?.close().catch(() => {})
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  })

  async function setSize(w, h) {
    for (let i = 0; i < 5; i++) {
      try {
        await app.evaluate(({ BrowserWindow }, s) => {
          const bw = BrowserWindow.getAllWindows()[0]
          bw.setSize(s.w, s.h)
          bw.center()
        }, { w, h })
        break
      } catch {
        await win.waitForTimeout(500)
      }
    }
    await win.waitForTimeout(300)
  }

  const shot = (name) => win.screenshot({ path: path.join(SHOTS, `${name}.png`) })
  const openSkill = async (name) => {
    // v2.1.11 左栏改页签：不在当前页签就依次点页签去找
    const row = win.locator('.np-pane--list [role="option"]', { hasText: name }).first()
    const tabs = win.locator('.np-pane--list [role="tab"]')
    for (let index = 0; index < await tabs.count() && !(await row.count()); index += 1) await tabs.nth(index).click()
    await row.click()
    await win.locator('.np-pane--detail h2', { hasText: name }).waitFor()
  }

  /** 右栏的横向溢出、每条路径和说明是否被截断、开关是否都在右栏可见范围里 */
  const measureDetail = () => win.evaluate(() => {
    const pane = document.querySelector('.np-pane--detail')
    const body = pane.querySelector('.np-pane-body')
    const paneRect = pane.getBoundingClientRect()
    const clipped = [...pane.querySelectorAll('.sk-p, .np-row .ds, .np-pane-hd h2')]
      .filter((el) => el.scrollWidth > el.clientWidth + 1 || getComputedStyle(el).textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth)
      .map((el) => el.textContent.slice(0, 40))
    const switchesOut = [...pane.querySelectorAll('[role="switch"]')]
      .filter((el) => { const r = el.getBoundingClientRect(); return r.right > paneRect.right || r.left < paneRect.left })
      .length
    const longPath = [...pane.querySelectorAll('.sk-p')].find((el) => el.textContent.length > 60)
    const lines = longPath ? new Set([...(() => { const range = document.createRange(); range.selectNodeContents(longPath); return range.getClientRects() })()].map((r) => Math.round(r.top))).size : 0
    return { overflow: body.scrollWidth - body.clientWidth, clipped, switchesOut, longPathLines: lines }
  })

  it('TC-045 FULL_TEXT_WINDOW 最小窗口里长路径、长说明完整折行，右栏不横向滚动，开关可见；按窗口号截图', async () => {
    await win.getByText('Skills 管理', { exact: true }).first().click()
    await win.locator('.np-split').waitFor({ timeout: 20000 })
    await win.locator('.np-pane--list [role="option"]').first().waitFor()
    await shot('W1')

    await openSkill('page-solution-design')
    await shot('W2')
    await openSkill('baseplate-deck')
    await shot('W3')

    await setSize(720, 500)
    await openSkill(LONG_NAME)
    let result = await measureDetail()
    expect(result.overflow, 'FULL_TEXT_WINDOW 右栏横向溢出').toBe(0)
    expect(result.clipped, 'FULL_TEXT_WINDOW 有文字被截断').toEqual([])
    expect(result.switchesOut, 'FULL_TEXT_WINDOW 开关出了右栏').toBe(0)
    await shot('W6')

    await openSkill('baseplate-deck')
    result = await measureDetail()
    expect(result.overflow, 'FULL_TEXT_WINDOW 右栏横向溢出').toBe(0)
    expect(result.clipped, 'FULL_TEXT_WINDOW 有文字被截断').toEqual([])
    expect(result.longPathLines, 'FULL_TEXT_WINDOW 长路径没有折行').toBeGreaterThan(1)
    await setSize(800, 600)
  }, 120000)
})
