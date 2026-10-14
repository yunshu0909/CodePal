/**
 * v2.1.24 TC-010（#72）：版本号三处一致——package.json、package-lock.json 根版本、README 版本角标。
 * 不写死某一版，发版时跟着 package.json 走。
 */
import fs from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'

const root = path.resolve(__dirname, '../../..')
const json = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))

it('TC-010 package.json、package-lock.json 根版本与 README 角标一致', () => {
  const version = json('package.json').version
  const lock = json('package-lock.json')
  expect(lock.version).toBe(version)
  expect(lock.packages[''].version).toBe(version)
  expect(fs.readFileSync(path.join(root, 'README.md'), 'utf8')).toContain('badge/version-v' + version + '-blue')
})
