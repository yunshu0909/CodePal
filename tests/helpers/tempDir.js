/**
 * 测试用临时文件夹：建在系统临时目录下，这条测试结束（过没过都算）就连同里面的东西一起删掉。
 * 在测试里或 beforeEach 里调用都行。以前各测试自己 mkdtemp、不删，整套跑一次留下几十个文件夹。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { onTestFinished } from 'vitest'

/** @param {string} prefix 文件夹名前缀，例如 'ss-home-' @returns {string} 新建的文件夹路径 */
export function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
