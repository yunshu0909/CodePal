/** v2.1.24 TC-002（#72）：审核配置「重试」仍写不进去时，红字里「dev 在用什么」按重试之后的磁盘状态重读，
 * 不沿用点重试之前的判断（例：重试前还有上一份有效配置，重试途中那份没了 → 改说 dev 暂时用默认规则）。 */
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'

vi.mock('../../../src/components/Toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
  default: () => null,
  resetToastForTests: vi.fn(),
}))
const { toast } = await import('../../../src/components/Toast')
const { default: Page } = await import('../../../src/features/modelHub/ModelHubPage.jsx')

const ok = (data) => ({ success: true, data, error: null })
const hub = () => ({
  providerConfigError: false,
  order: ['deepseek:deepseek-flash'],
  vendors: [
    {
      id: 'deepseek',
      name: 'DeepSeek',
      color: 'var(--ic-blue)',
      blocked: null,
      models: [{ id: 'deepseek:deepseek-flash', displayName: 'deepseek-flash', enabled: true, efforts: ['low', 'high', 'max'], effort: 'high' }],
    },
  ],
})
const GATES = {
  'lite.G0': { reviewers: 1, rounds: 3 },
  'lite.G1': { reviewers: 2, rounds: 3 },
  'formal.G1': { reviewers: 1, rounds: 3 },
  'formal.G2b': { reviewers: 1, rounds: 2 },
  'formal.G3': { reviewers: 1, rounds: 3 },
  'formal.G4': { reviewers: 2, rounds: 3 },
}
const rules = (exportUsing) => ({
  effective: { selfReview: false, gates: structuredClone(GATES), advanced: { timeoutMinutes: 20, failoverMax: 3, autoExtendRounds: 1 } },
  changed: false,
  defaultsVersion: '2026.10.1',
  dev: { claude: 'ok', codex: 'ok' },
  exportOk: false,
  exportUsing,
})

afterEach(() => {
  cleanup()
  delete window.electronAPI
})

it('TC-002 重试仍失败：红字按重试后的磁盘状态说 dev 在用什么', async () => {
  let disk = 'previous'
  window.electronAPI = {
    modelsHubList: vi.fn(async () => ok(hub())),
    modelsHubSetEnabled: vi.fn(),
    modelsHubSetEffort: vi.fn(),
    modelsHubSetOrder: vi.fn(),
    modelsRulesGet: vi.fn(async () => ok(rules(disk))),
    modelsRulesSet: vi.fn(),
    modelsRulesReset: vi.fn(),
    // 重试途中上一份有效配置也没了，仍写不进去
    modelsConfigRepublish: vi.fn(async () => {
      disk = 'defaults'
      return ok({ exportOk: false })
    }),
  }
  render(<Page />)
  await act(async () => {})
  fireEvent.click(screen.getAllByRole('tab').find((el) => el.textContent.trim() === '审核规则'))
  await act(async () => {})
  const bad = () => document.querySelector('[data-rules="export-error"]')
  expect(bad()?.textContent).toContain('dev 还在用上一次存下的规则')
  await act(async () => fireEvent.click(within(bad()).getByRole('button', { name: '重试' })))
  await act(async () => {})
  expect(window.electronAPI.modelsConfigRepublish).toHaveBeenCalledTimes(1)
  expect(bad()?.textContent, 'RETRY_STALE_USING').toContain('审核配置写不进去，dev 暂时用默认规则；检查配置目录的权限后重试')
  expect(toast.error).not.toHaveBeenCalled()
})
