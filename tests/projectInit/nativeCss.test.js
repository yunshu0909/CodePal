/**
 * native.css 只追加（#59，specs/v2.1.6-新建项目 TC-029）
 *
 * 新建项目页往共用的 native.css 加了动作行等新类；守住「现有规则一个不改」，其他新样式页面因此不受影响。
 * 对比对象是目标分支 master 上的 native.css：它的全部内容必须原样是当前文件的开头。
 *
 * @module tests/projectInit/nativeCss
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const root = path.resolve(__dirname, '..', '..')

describe('native.css 只追加', () => {
  it('TC-029 改前内容原样是改后内容的开头', () => {
    let base
    try {
      base = execFileSync('git', ['show', 'master:src/styles/native.css'], { cwd: root, encoding: 'utf-8' })
    } catch {
      base = null // 没有 master（例如打包后的源码里）时跳过对比
    }
    const current = readFileSync(path.join(root, 'src', 'styles', 'native.css'), 'utf-8')
    if (base !== null) expect(current.startsWith(base)).toBe(true)
  })
})
