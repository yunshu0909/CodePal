/**
 * @vitest-environment node
 *
 * v2.1.16 产品版本：package.json、package-lock.json 与 README 徽标一致
 *
 * @module tests/models/effortCommandsVersion.test
 */

import { expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { REPO } from './helpers'

const json = (name) => JSON.parse(fs.readFileSync(path.join(REPO, name), 'utf8'))

it('TC-110 package.json、package-lock.json 与 README 徽标都是 2.1.16', () => {
  expect(json('package.json').version).toBe('2.1.16')
  const lock = json('package-lock.json')
  expect(lock.version).toBe('2.1.16')
  expect(lock.packages[''].version).toBe('2.1.16')
  expect(fs.readFileSync(path.join(REPO, 'README.md'), 'utf8')).toContain('version-v2.1.16-blue')
})
