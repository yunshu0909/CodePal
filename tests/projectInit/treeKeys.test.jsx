/**
 * 新建项目 · 目录树行的 key（specs/v2.1.7-新建项目小修 TC-001）
 *
 * 负责：目录树每行用完整相对路径当 key。原来用「层级-名字」，issues/、specs/、docs/
 * 下三个 README.md 撞成同一个 key，切 Git 档或改代码文件夹名时可能显示错乱。
 *
 * @module tests/projectInit/treeKeys
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { buildTree } from '../../shared/projectInitManifest.mjs'
import ProjectTree from '../../src/pages/projectInit/ProjectTree.jsx'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const CASES = [
  { gitMode: 'dual', codeDir: 'code' },
  { gitMode: 'code', codeDir: 'code' },
  { gitMode: 'none', codeDir: 'code' },
  { gitMode: 'dual', codeDir: 'app' },
]

describe('目录树行的 key', () => {
  it('TC-001 TREE_KEY_UNIQUE 每行带完整路径且互不相同，渲染没有重复 key 警告', () => {
    for (const { gitMode, codeDir } of CASES) {
      const { rows } = buildTree({ projectName: 'my-app', gitMode, codeDir })
      const paths = rows.map((row) => row.path)
      expect(paths.every((p) => typeof p === 'string' && p.length > 0), 'TREE_KEY_UNIQUE 每行要带 path').toBe(true)
      expect(new Set(paths).size, `TREE_KEY_UNIQUE ${gitMode}/${codeDir} 路径有重复`).toBe(paths.length)
      expect(paths.includes(codeDir), 'TREE_KEY_UNIQUE 代码文件夹跟着改名').toBe(true)

      const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
      render(<ProjectTree projectName="my-app" gitMode={gitMode} codeDirName={codeDir} />)
      const keyWarnings = errors.mock.calls.filter((args) => args.join(' ').includes('same key'))
      expect(keyWarnings.length, 'TREE_KEY_UNIQUE 渲染出现重复 key 警告').toBe(0)
      cleanup()
      errors.mockRestore()
    }
  })
})
