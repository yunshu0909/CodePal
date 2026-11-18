/** @vitest-environment node
 * 测试用临时文件夹：这条测试结束（过没过都算）就删掉，整套跑完不在临时目录里留东西。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import { tempDir } from './helpers/tempDir.js'

describe('tempDir', () => {
  let made
  it('建在系统临时目录下、名字带前缀', () => {
    made = tempDir('probe-')
    expect(fs.existsSync(made)).toBe(true)
    expect(made.startsWith(fs.realpathSync(os.tmpdir())) || made.startsWith(os.tmpdir())).toBe(true)
    expect(made).toMatch(/probe-[^/]+$/)
    fs.writeFileSync(`${made}/x.txt`, 'x')
  })
  it('上一条测试结束后它就被删了（连里面的文件）', () => {
    expect(fs.existsSync(made)).toBe(false)
  })
})
