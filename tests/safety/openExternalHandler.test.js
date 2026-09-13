/**
 * 外链 IPC — 行为测试
 *
 * 负责：
 * - open-external-link handler：白名单放行 / 危险与非法入参拒绝且不触碰 shell
 *
 * @module tests/safety/openExternalHandler.behavior.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { registerNavigationGuardHandlers } = require('../../electron/services/navigationGuardService')

describe('V1.9.8 open-external-link IPC', () => {
  let handlers
  let shell

  beforeEach(() => {
    handlers = new Map()
    shell = { openExternal: vi.fn().mockResolvedValue(undefined) }
    registerNavigationGuardHandlers({
      ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
      shell,
    })
  })

  it('OE-1: https 外链 → success 且 shell.openExternal 恰被调一次', async () => {
    const result = await handlers.get('open-external-link')({}, 'https://github.com/yunshu0909/CodePal')
    expect(result.success).toBe(true)
    expect(shell.openExternal).toHaveBeenCalledTimes(1)
  })

  it('OE-2: javascript: → BLOCKED_URL 且 shell 未被调', async () => {
    const result = await handlers.get('open-external-link')({}, 'javascript:alert(1)')
    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('BLOCKED_URL')
    expect(shell.openExternal).not.toHaveBeenCalled()
  })

  it('OE-3: 非 string 入参（对象/undefined）→ BLOCKED_URL 且 shell 未被调', async () => {
    for (const bad of [{ url: 'https://x.com' }, undefined, 123, null]) {
      const result = await handlers.get('open-external-link')({}, bad)
      expect(result.success).toBe(false)
      expect(result.errorCode).toBe('BLOCKED_URL')
    }
    expect(shell.openExternal).not.toHaveBeenCalled()
  })

  it('OE-4: shell.openExternal 抛错 → OPEN_FAILED 不崩', async () => {
    shell.openExternal.mockRejectedValueOnce(new Error('no handler'))
    const result = await handlers.get('open-external-link')({}, 'https://example.com')
    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('OPEN_FAILED')
  })
})
