/**
 * 主进程要求切页的页面端接线测试
 *
 * 负责：
 * - 挂载时领取窗口创建前记下的待跳转（点通知时窗口已关的情况）
 * - 收到 app:navigate 推送时切页；不认识的模块忽略；卸载时取消订阅
 *
 * @module tests/network/useMainNavigation.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import useMainNavigation from '../../src/hooks/useMainNavigation'

const VALID = new Set(['usage', 'network'])

afterEach(() => { delete window.electronAPI })

describe('useMainNavigation', () => {
  it('TC-16 挂载时领取待跳转并切页', async () => {
    const go = vi.fn()
    window.electronAPI = { consumePendingNavigation: vi.fn(async () => 'network'), onNavigate: vi.fn(() => () => {}) }
    renderHook(() => useMainNavigation(go, VALID))
    await waitFor(() => expect(go).toHaveBeenCalledWith('network'))
  })

  it('TC-16 收到推送切页；不认识的模块和空领取都忽略；卸载取消订阅', async () => {
    const go = vi.fn()
    let push
    const off = vi.fn()
    window.electronAPI = { consumePendingNavigation: vi.fn(async () => null), onNavigate: vi.fn((cb) => { push = cb; return off }) }
    const { unmount } = renderHook(() => useMainNavigation(go, VALID))
    await waitFor(() => expect(window.electronAPI.consumePendingNavigation).toHaveBeenCalled())
    push('harness-unknown')
    push('network')
    expect(go).toHaveBeenCalledTimes(1)
    expect(go).toHaveBeenCalledWith('network')
    unmount()
    expect(off).toHaveBeenCalled()
  })
})
