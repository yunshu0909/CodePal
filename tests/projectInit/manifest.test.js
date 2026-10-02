/**
 * 新建项目 · 共用清单与打包接线（#59，specs/v2.1.6-新建项目 TC-001〜003、TC-023）
 *
 * 负责：
 * - 会生成什么：双层 / 只给代码建仓 / 跳过三档的清单与仓库标签
 * - 代码文件夹改名后清单跟着变、外层保留名不含代码文件夹
 * - 打包带上 shared/、新测试接进 npm test、README 版本徽章与 package.json 一致
 *
 * 清单模块用动态导入：模块还不存在时以本行的标记失败，而不是整份文件加载失败。
 *
 * @module tests/projectInit/manifest
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const root = path.resolve(__dirname, '..', '..')

async function loadManifest(token) {
  // 地址运行时才拼出来：模块还不存在时只让本行失败，不让整份测试文件加载失败
  const url = pathToFileURL(path.join(root, 'shared', 'projectInitManifest.mjs')).href
  const mod = await import(/* @vite-ignore */ url).catch(() => null)
  expect(mod, token).toBeTruthy()
  return mod
}

const paths = (items) => items.map((item) => item.path)

describe('会生成什么（共用清单）', () => {
  it('TC-001 TREE_DUAL 双层：整套外层 + 代码文件夹，两种仓库标签，每项有说明', async () => {
    const m = await loadManifest('TREE_DUAL')
    const items = m.buildManifest({ gitMode: 'dual', codeDir: 'code' })
    expect(paths(items), 'TREE_DUAL').toEqual(expect.arrayContaining([
      'AGENTS.md', 'CLAUDE.md', 'MEMORY.md', 'memory', 'memory/topics', 'memory/archive',
      'ISSUES.md', 'issues', 'issues/README.md', 'issues/收件箱.md', 'issues/_模板.md',
      'issues/未关闭', 'issues/已完成', 'issues/已作废',
      'specs', 'specs/README.md',
      'docs', 'docs/README.md', 'docs/plan', 'docs/research', 'docs/archive', 'docs/issue-check.py', 'docs/protocol-check.py',
      '.dev-workflow', '.dev-workflow/project-defaults.json', '.gitignore', 'code', 'code/.gitignore',
    ]))
    const tree = m.buildTree({ projectName: 'my-app', gitMode: 'dual', codeDir: 'code' })
    expect(tree.root, 'TREE_DUAL').toMatchObject({ name: 'my-app/', tag: 'private' })
    expect(tree.rows.find((r) => r.name === 'code/'), 'TREE_DUAL').toMatchObject({ tag: 'code', depth: 1 })
    const silent = ['未关闭/', '已完成/', '已作废/', '.dev-workflow/']
    for (const row of tree.rows.filter((r) => !silent.includes(r.name))) {
      expect(row.note, `TREE_DUAL ${row.name}`).toBeTruthy()
    }
  })

  it('TC-002 TREE_MODES 只给代码建仓 / 跳过：.gitignore、.dev-workflow 与标签按档出现', async () => {
    const m = await loadManifest('TREE_MODES')
    const codeOnly = paths(m.buildManifest({ gitMode: 'code', codeDir: 'code' }))
    expect(codeOnly, 'TREE_MODES').not.toContain('.gitignore')
    expect(codeOnly, 'TREE_MODES').toEqual(expect.arrayContaining(['.dev-workflow/project-defaults.json', 'code/.gitignore']))
    const codeTree = m.buildTree({ projectName: 'my-app', gitMode: 'code' })
    expect(codeTree.root.tag, 'TREE_MODES').toBeUndefined()
    expect(codeTree.rows.find((r) => r.name === 'code/').tag, 'TREE_MODES').toBe('code')

    const none = paths(m.buildManifest({ gitMode: 'none', codeDir: 'code' }))
    expect(none, 'TREE_MODES').not.toContain('.gitignore')
    expect(none, 'TREE_MODES').not.toContain('code/.gitignore')
    expect(none.some((p) => p.startsWith('.dev-workflow')), 'TREE_MODES').toBe(false)
    const noneTree = m.buildTree({ projectName: 'my-app', gitMode: 'none' })
    expect(noneTree.root.tag, 'TREE_MODES').toBeUndefined()
    expect(noneTree.rows.every((r) => !r.tag), 'TREE_MODES').toBe(true)
  })

  it('TC-003 TREE_CODE_DIR 代码文件夹改名：清单跟着改，保留名不含代码文件夹', async () => {
    const m = await loadManifest('TREE_CODE_DIR')
    const items = paths(m.buildManifest({ gitMode: 'dual', codeDir: 'my-app' }))
    expect(items, 'TREE_CODE_DIR').toEqual(expect.arrayContaining(['my-app', 'my-app/.gitignore']))
    expect(items, 'TREE_CODE_DIR').not.toContain('code')
    expect(m.resolveCodeDir(''), 'TREE_CODE_DIR').toBe('code')
    expect(m.OUTER_RESERVED_NAMES, 'TREE_CODE_DIR').not.toContain('code')
    expect(m.OUTER_RESERVED_NAMES, 'TREE_CODE_DIR').toEqual(expect.arrayContaining(['docs', 'specs', 'issues', 'memory', '.dev-workflow', 'ISSUES.md']))
  })
})

describe('打包与测试接线', () => {
  it('TC-023 PACKAGING 打包带上 shared/；新测试接进 npm test；README 徽章与版本一致', () => {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf-8'))
    expect(pkg.build.files, 'PACKAGING').toContain('shared/**/*')
    expect(pkg.scripts['test:project-init'], 'PACKAGING').toMatch(/tests\/projectInit/)
    expect(pkg.scripts.test, 'PACKAGING').toContain('npm run test:project-init')
    const readme = readFileSync(path.join(root, 'README.md'), 'utf-8')
    expect(readme, 'PACKAGING').toContain(`version-v${pkg.version}-blue`)
  })
})
