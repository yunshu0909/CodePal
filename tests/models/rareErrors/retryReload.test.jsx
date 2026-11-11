/** v2.1.29 TC-003（#78）：审核配置重试仍写不进去、重试后的重读也失败时（用户 11-11 选「留在页面，红字不再猜（推荐）」）：
 * 留在审核规则页、规则照常显示且还能改；红字不再说重试前那句（previous / defaults 两种都核），换成候选新句；
 * 重读和保存相撞后再读一次又失败也一样。 */
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'

vi.mock('../../../src/components/Toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
  default: () => null,
  resetToastForTests: vi.fn(),
}))
const { default: Page } = await import('../../../src/features/modelHub/ModelHubPage.jsx')

const ok = (data) => ({ success: true, data, error: null })
const DENIED = { success: false, data: null, error: { code: 'write_denied', message: '配置目录没有写入权限，检查权限后重试' } }
const READ_FAILED = { success: false, data: null, error: { message: '出错了' } }
const PREVIOUS_TEXT = '审核配置写不进去，dev 还在用上一次存下的规则；检查配置目录的权限后重试'
const DEFAULTS_TEXT = '审核配置写不进去，dev 暂时用默认规则；检查配置目录的权限后重试'
const UNKNOWN_TEXT = '审核配置写不进去，也读不出 dev 现在在用哪份规则；检查配置目录的权限后重试'

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
/** 审核规则读数：exportUsing 为 null 时算写进去了 */
const rules = ({ exportUsing = 'previous', selfReview = false, g1Rounds = 3 } = {}) => {
  const gates = structuredClone(GATES)
  gates['lite.G1'].rounds = g1Rounds
  return {
    effective: { selfReview, gates, advanced: { timeoutMinutes: 20, failoverMax: 3, autoExtendRounds: 1 } },
    changed: false,
    defaultsVersion: '2026.10.1',
    dev: { claude: 'ok', codex: 'ok' },
    exportOk: exportUsing === null,
    exportUsing,
  }
}
const deferred = () => {
  let resolve
  const promise = new Promise((r) => {
    resolve = r
  })
  return { promise, resolve }
}
/** 按调用顺序依次返回；队列用完后一直返回最后一个 */
function queue(...answers) {
  let index = 0
  return async () => {
    const answer = answers[Math.min(index, answers.length - 1)]
    index += 1
    return typeof answer === 'function' ? answer() : answer
  }
}

const tab = (name) => screen.getAllByRole('tab').find((el) => el.textContent.trim() === name)
async function openRules() {
  fireEvent.click(tab('审核规则'))
  await act(async () => {})
}
const redText = () => document.querySelector('[data-rules="export-error"]')
const gate = (id) => document.querySelector(`[data-gate="${id}"]`)
const roundsButton = (id) => gate(id).querySelector('.mh-gate-r')
const selfReviewSwitch = () => screen.getByRole('switch', { name: '写代码的那家也参与审核' })
async function retry() {
  await act(async () => fireEvent.click(within(redText()).getByRole('button', { name: '重试' })))
}
async function pickRounds(id, n) {
  fireEvent.click(roundsButton(id))
  await act(async () => fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitemradio', { name: `每个 ${n} 轮` })))
}

afterEach(() => {
  cleanup()
  delete window.electronAPI
})
function api(overrides) {
  return {
    modelsHubList: vi.fn(async () => ok(hub())),
    modelsHubSetEnabled: vi.fn(async (payload) => ok(payload)),
    modelsHubSetEffort: vi.fn(),
    modelsHubSetOrder: vi.fn(),
    modelsRulesGet: vi.fn(async () => ok(rules())),
    modelsRulesSet: vi.fn(async ({ key, value }) => ok({ key, value, changed: true })),
    modelsRulesReset: vi.fn(),
    modelsConfigRepublish: vi.fn(async () => ok({ exportOk: false })),
    ...overrides,
  }
}
async function show(overrides) {
  window.electronAPI = api(overrides)
  render(<Page />)
  await act(async () => {})
  await openRules()
  return window.electronAPI
}

for (const [using, before] of [
  ['previous', PREVIOUS_TEXT],
  ['defaults', DEFAULTS_TEXT],
]) {
  it(`TC-003 重试后重读失败（原来说 ${using}）：留在页面、规则照常显示还能改，红字换成不猜的那句`, async () => {
    const page = await show({ modelsRulesGet: vi.fn(queue(ok(rules({ exportUsing: using })), READ_FAILED)) })
    expect(redText()?.textContent).toContain(before)
    await retry()
    await act(async () => {})
    expect(page.modelsConfigRepublish).toHaveBeenCalledTimes(1)
    expect(redText()?.textContent, 'RETRY_KEEPS_STALE 重读失败了还沿用重试前那句').not.toContain(before)
    expect(redText()?.textContent).toContain(UNKNOWN_TEXT)
    expect(gate('lite.G1'), '规则照常显示').not.toBeNull()
    expect(roundsButton('lite.G1').textContent).toContain('3')
    await act(async () => fireEvent.click(selfReviewSwitch()))
    expect(page.modelsRulesSet, '还能改').toHaveBeenCalledWith({ key: 'selfReview', value: true })
  })
}

it('TC-003 重读和一项规则保存相撞，再读一次又失败：同样留在页面、红字换成不猜的那句', async () => {
  const firstRead = deferred()
  const page = await show({
    modelsRulesGet: vi.fn(queue(ok(rules()), () => firstRead.promise, READ_FAILED)),
    modelsRulesSet: vi.fn(async () => DENIED),
  })
  await retry()
  // 重读还在路上：改一项规则，没存成
  await act(async () => fireEvent.click(selfReviewSwitch()))
  await act(async () => firstRead.resolve(ok(rules())))
  await act(async () => {})
  expect(page.modelsRulesGet.mock.calls.length, 'RETRY_KEEPS_STALE 相撞后没再读').toBeGreaterThanOrEqual(3)
  expect(redText()?.textContent, 'RETRY_KEEPS_STALE 再读失败了还沿用重试前那句').toContain(UNKNOWN_TEXT)
  expect(gate('lite.G1')).not.toBeNull()
})
