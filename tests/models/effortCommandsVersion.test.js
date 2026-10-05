/**
 * @vitest-environment node
 *
 * 产品版本：package.json、package-lock.json 与 README 徽标一致（2.1.16 加入；不写死某一版，升版本时不必改这里）
 *
 * @module tests/models/effortCommandsVersion.test
 */

import { expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { REPO } from './helpers'

const json = (name) => JSON.parse(fs.readFileSync(path.join(REPO, name), 'utf8'))

it('TC-110 package.json、package-lock.json 与 README 徽标版本一致', () => {
  const version = json('package.json').version
  expect(version).toMatch(/^\d+\.\d+\.\d+$/)
  const lock = json('package-lock.json')
  expect(lock.version).toBe(version)
  expect(lock.packages[''].version).toBe(version)
  expect(fs.readFileSync(path.join(REPO, 'README.md'), 'utf8')).toContain(`version-v${version}-blue`)
})
