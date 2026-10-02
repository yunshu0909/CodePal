/**
 * README 新建项目截图与版本号（specs/v2.1.7-新建项目小修 TC-003、TC-004）
 *
 * 负责：README 新建项目一节引用的截图存在、是 WebP、和其他 README 截图同宽；
 * package.json、package-lock.json 与 README 版本徽章三处版本号一致。
 * 截图内容（是不是新页面、有没有露本机路径）靠人工核对，这里只守文件本身。
 *
 * @module tests/projectInit/readme
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(__dirname, '..', '..')
const read = (rel) => readFileSync(path.join(root, rel))

/** 读 WebP 画布宽度（VP8X 扩展格式、VP8 有损、VP8L 无损三种头） */
function webpWidth(buf) {
  const chunk = buf.toString('ascii', 12, 16)
  if (chunk === 'VP8X') return 1 + buf.readUIntLE(24, 3)
  if (chunk === 'VP8 ') return buf.readUInt16LE(26) & 0x3fff
  if (chunk === 'VP8L') return 1 + (buf.readUInt32LE(21) & 0x3fff)
  return null
}

describe('README', () => {
  it('TC-003 新建项目一节的截图存在、是 WebP、宽 2224', () => {
    const readme = read('README.md').toString('utf-8')
    const section = readme.slice(readme.indexOf('#### 新建项目'))
    expect(section.slice(0, 600)).toContain('docs/images/project-init.webp')
    const file = 'docs/images/project-init.webp'
    expect(existsSync(path.join(root, file))).toBe(true)
    const buf = read(file)
    expect(buf.toString('ascii', 0, 4)).toBe('RIFF')
    expect(buf.toString('ascii', 8, 12)).toBe('WEBP')
    expect(webpWidth(buf)).toBe(webpWidth(read('docs/images/skills.webp')))
    expect(webpWidth(buf)).toBe(2224)
  })

  it('TC-004 版本号三处一致', () => {
    const pkg = JSON.parse(read('package.json').toString('utf-8'))
    const lock = JSON.parse(read('package-lock.json').toString('utf-8'))
    const readme = read('README.md').toString('utf-8')
    expect(lock.version).toBe(pkg.version)
    expect(lock.packages[''].version).toBe(pkg.version)
    const badge = readme.match(/version-v(\d+\.\d+\.\d+)/)
    expect(badge && badge[1]).toBe(pkg.version)
  })
})
