/**
 * V0.7 Session API 配置 MVP 单元测试
 *
 * 负责：
 * - 验证 session->provider 绑定读写
 * - 验证按 session 应用 provider 的主链路
 * - 验证关键异常分支与参数校验
 *
 * @module 自动化测试/V0.7/tests/unit/store/sessionApiConfig.v07.session-mvp.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  SESSION_PROVIDER_BINDINGS_STORE_KEY,
  normalizeSessionId,
  getSessionProviderBinding,
  saveSessionProviderBinding,
  removeSessionProviderBinding,
  listSessionProviderBindings,
  applySessionProviderBinding,
} from '@/store/sessionApiConfig.js'

describe('V0.7 Session API Config MVP', () => {
  beforeEach(() => {
    window.electronAPI = {
      getStore: vi.fn().mockResolvedValue(null),
      setStore: vi.fn().mockResolvedValue(true),
      switchClaudeProvider: vi.fn().mockResolvedValue({
        success: true,
        error: null,
        errorCode: null,
      }),
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete window.electronAPI
  })

  it('UT-V07-SESSION-01: normalizeSessionId 应拒绝空值并保留有效值', () => {
    expect(normalizeSessionId('')).toBeNull()
    expect(normalizeSessionId('   ')).toBeNull()
    expect(normalizeSessionId('session-001')).toBe('session-001')
    expect(normalizeSessionId('  alpha-beta  ')).toBe('alpha-beta')
  })

  it('UT-V07-SESSION-02: saveSessionProviderBinding 应写入 session 绑定映射', async () => {
    const result = await saveSessionProviderBinding('session-001', 'kimi')

    expect(result.success).toBe(true)
    expect(result.binding?.providerId).toBe('kimi')
    expect(window.electronAPI.getStore).toHaveBeenCalledWith(SESSION_PROVIDER_BINDINGS_STORE_KEY)
    expect(window.electronAPI.setStore).toHaveBeenCalledTimes(1)

    const [, savedMap] = window.electronAPI.setStore.mock.calls[0]
    expect(savedMap['session-001'].providerId).toBe('kimi')
    expect(savedMap['session-001'].updatedAt).toBeTruthy()
  })

  it('UT-V07-SESSION-03: getSessionProviderBinding 应读取指定 session 绑定', async () => {
    window.electronAPI.getStore.mockResolvedValue({
      'session-001': {
        providerId: 'aicodemirror',
        updatedAt: '2026-02-19T12:00:00.000Z',
      },
    })

    const result = await getSessionProviderBinding('session-001')

    expect(result.success).toBe(true)
    expect(result.binding).toEqual({
      providerId: 'aicodemirror',
      updatedAt: '2026-02-19T12:00:00.000Z',
    })
  })

  it('UT-V07-SESSION-04: listSessionProviderBindings 应返回按更新时间倒序列表', async () => {
    window.electronAPI.getStore.mockResolvedValue({
      'session-a': { providerId: 'official', updatedAt: '2026-02-18T11:00:00.000Z' },
      'session-b': { providerId: 'kimi', updatedAt: '2026-02-19T11:00:00.000Z' },
    })

    const result = await listSessionProviderBindings()

    expect(result.success).toBe(true)
    expect(result.items.map((item) => item.sessionId)).toEqual(['session-b', 'session-a'])
  })

  it('UT-V07-SESSION-05: applySessionProviderBinding 应按绑定触发全局切换', async () => {
    window.electronAPI.getStore.mockResolvedValue({
      'session-apply-01': {
        providerId: 'qwen',
        updatedAt: '2026-02-19T12:00:00.000Z',
      },
    })

    const result = await applySessionProviderBinding('session-apply-01')

    expect(result.success).toBe(true)
    expect(result.providerId).toBe('qwen')
    expect(window.electronAPI.switchClaudeProvider).toHaveBeenCalledWith('qwen')
  })

  it('UT-V07-SESSION-06: applySessionProviderBinding 在无绑定时返回 NO_SESSION_BINDING', async () => {
    window.electronAPI.getStore.mockResolvedValue({})

    const result = await applySessionProviderBinding('session-empty')

    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('NO_SESSION_BINDING')
    expect(window.electronAPI.switchClaudeProvider).not.toHaveBeenCalled()
  })

  it('UT-V07-SESSION-07: removeSessionProviderBinding 应删除已有绑定', async () => {
    window.electronAPI.getStore.mockResolvedValue({
      'session-remove': {
        providerId: 'kimi',
        updatedAt: '2026-02-19T12:00:00.000Z',
      },
      'session-keep': {
        providerId: 'official',
        updatedAt: '2026-02-19T10:00:00.000Z',
      },
    })

    const result = await removeSessionProviderBinding('session-remove')

    expect(result.success).toBe(true)
    expect(result.removed).toBe(true)
    expect(window.electronAPI.setStore).toHaveBeenCalledTimes(1)

    const [, savedMap] = window.electronAPI.setStore.mock.calls[0]
    expect(savedMap['session-remove']).toBeUndefined()
    expect(savedMap['session-keep']).toBeTruthy()
  })

  it('UT-V07-SESSION-08: saveSessionProviderBinding 应拒绝非法 providerId', async () => {
    const result = await saveSessionProviderBinding('session-001', 'unknown-provider')

    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('INVALID_PROVIDER_ID')
    expect(window.electronAPI.setStore).not.toHaveBeenCalled()
  })
})
