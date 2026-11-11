/** v2.1.29 TC-005（#78）：重试后的重读还在路上，模型页保存成功清掉了红字：比它早发出的重读结果作废，迟到的旧读数不把红字带回来。 */
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

it('TC-005 重读途中模型页保存成功清掉红字：迟到的旧读数不把红字带回来', async () => {
  const firstRead = deferred()
  const page = await show({
    // 第 1 次打开页面；第 2 次是重试后的重读（迟到、还是旧的写不进去）；之后磁盘上已经写进去了
    modelsRulesGet: vi.fn(queue(ok(rules()), () => firstRead.promise, ok(rules({ exportUsing: null })))),
  })
  expect(redText()).not.toBeNull()
  await retry()
  // 重读还在路上：去模型页关掉再打开一个模型，保存成功（审核配置也写进去了，红字清掉）
  fireEvent.click(tab('模型'))
  await act(async () => {})
  const toggle = within(document.querySelector('[data-hub-model="deepseek:deepseek-flash"]')).getByRole('switch')
  await act(async () => fireEvent.click(toggle))
  expect(page.modelsHubSetEnabled).toHaveBeenCalled()
  await openRules()
  expect(redText(), '模型页保存成功清掉了红字').toBeNull()
  // 迟到的旧读数回来
  await act(async () => firstRead.resolve(ok(rules())))
  await act(async () => {})
  expect(redText(), 'STALE_RED_BACK 迟到的旧读数把红字带回来了').toBeNull()
})

it('TC-005 重读途中模型页保存成功清掉红字，之后的再读又失败：红字不回来（G1 第 1 轮 F-003）', async () => {
  const firstRead = deferred()
  await show({
    // 第 2 次是重试后的重读（迟到）；之后再读一律失败
    modelsRulesGet: vi.fn(queue(ok(rules()), () => firstRead.promise, READ_FAILED)),
  })
  await retry()
  fireEvent.click(tab('模型'))
  await act(async () => {})
  const toggle = within(document.querySelector('[data-hub-model="deepseek:deepseek-flash"]')).getByRole('switch')
  await act(async () => fireEvent.click(toggle))
  await openRules()
  expect(redText(), '模型页保存成功清掉了红字').toBeNull()
  await act(async () => firstRead.resolve(ok(rules())))
  await act(async () => {})
  expect(redText(), 'STALE_RED_BACK 保存成功之后，旧重读链再读失败把红字带回来了').toBeNull()
})

it('TC-005 保存失败后的再读还在路上，第二次重试成功：迟到的旧读数不把红字带回来（G1 第 1 轮 F-003）', async () => {
  const firstRead = deferred()
  const secondRead = deferred()
  const page = await show({
    // 第 2 次是第一次重试后的重读；第 3 次是保存失败相撞后的再读（都迟到、都还是旧的写不进去）
    modelsRulesGet: vi.fn(queue(ok(rules()), () => firstRead.promise, () => secondRead.promise)),
    modelsRulesSet: vi.fn(async () => DENIED),
    modelsConfigRepublish: vi.fn(queue(ok({ exportOk: false }), ok({ exportOk: true }))),
  })
  await retry()
  // 重读还在路上：开自审没存成（和重读相撞，要再读一遍）
  await act(async () => fireEvent.click(selfReviewSwitch()))
  await act(async () => firstRead.resolve(ok(rules())))
  await act(async () => {})
  expect(page.modelsRulesGet.mock.calls.length).toBe(3)
  // 再读还在路上：再点一次重试，这次写进去了，红字清掉
  await retry()
  expect(redText(), '第二次重试成功清掉了红字').toBeNull()
  await act(async () => secondRead.resolve(ok(rules())))
  await act(async () => {})
  expect(redText(), 'STALE_RED_BACK 重试成功之后，迟到的旧读数把红字带回来了').toBeNull()
})

it('TC-005 重试的响应还没回来，模型页保存成功清掉红字；迟到的「没写进去」响应和之后失败的重读都不把红字带回来（G1 第 2 轮 I-003）', async () => {
  const response = deferred()
  await show({
    modelsRulesGet: vi.fn(queue(ok(rules()), READ_FAILED)),
    modelsConfigRepublish: vi.fn(() => response.promise),
  })
  fireEvent.click(within(redText()).getByRole('button', { name: '重试' }))
  fireEvent.click(tab('模型'))
  await act(async () => {})
  const toggle = within(document.querySelector('[data-hub-model="deepseek:deepseek-flash"]')).getByRole('switch')
  await act(async () => fireEvent.click(toggle))
  await openRules()
  expect(redText(), '模型页保存成功清掉了红字').toBeNull()
  await act(async () => response.resolve(ok({ exportOk: false })))
  await act(async () => {})
  expect(redText(), 'STALE_RED_BACK 迟到的重试响应把红字带回来了').toBeNull()
})

it('TC-005 窗口回到前台的重读还在路上，重试成功清掉红字：迟到的旧读数不把红字带回来（G1 第 2 轮 I-003）', async () => {
  const focusRead = deferred()
  await show({
    modelsRulesGet: vi.fn(queue(ok(rules()), () => focusRead.promise)),
    modelsConfigRepublish: vi.fn(async () => ok({ exportOk: true })),
  })
  await act(async () => window.dispatchEvent(new Event('focus')))
  await retry()
  expect(redText(), '重试成功清掉了红字').toBeNull()
  await act(async () => focusRead.resolve(ok(rules())))
  await act(async () => {})
  expect(redText(), 'STALE_RED_BACK 窗口回到前台的旧读数把红字带回来了').toBeNull()
})

it('TC-005 读取失败的错误态里重试、重读还在路上，模型页保存成功：迟到的旧读数不把红字带回来（G1 第 3 轮 I-003）', async () => {
  const staleRead = deferred()
  await show({
    // 打开页面 → 窗口回前台读失败（错误态）→ 错误态重试的读（迟到、还是旧的）→ 之后磁盘上已写进去
    modelsRulesGet: vi.fn(queue(ok(rules()), READ_FAILED, () => staleRead.promise, ok(rules({ exportUsing: null })))),
  })
  await act(async () => window.dispatchEvent(new Event('focus')))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '重试' })))
  fireEvent.click(tab('模型'))
  await act(async () => {})
  const toggle = within(document.querySelector('[data-hub-model="deepseek:deepseek-flash"]')).getByRole('switch')
  await act(async () => fireEvent.click(toggle))
  await openRules()
  await act(async () => staleRead.resolve(ok(rules())))
  await act(async () => {})
  expect(document.querySelector('[data-gate="lite.G1"]'), '规则照常显示').not.toBeNull()
  expect(redText(), 'STALE_RED_BACK 模型页保存成功之后，错误态重试的旧读数把红字带回来了').toBeNull()
})

it('TC-005 连点两次重试，先发的写进去了、后发的没写进去：红字按后发的那次和磁盘说（G1 第 3 轮 F-001）', async () => {
  const first = deferred()
  const second = deferred()
  await show({
    modelsRulesGet: vi.fn(queue(ok(rules()), ok(rules({ exportUsing: 'defaults' })))),
    modelsConfigRepublish: vi.fn(queue(() => first.promise, () => second.promise)),
  })
  const button = within(redText()).getByRole('button', { name: '重试' })
  fireEvent.click(button)
  fireEvent.click(button)
  await act(async () => first.resolve(ok({ exportOk: true })))
  expect(redText(), '先发的那次写进去了，红字先清掉').toBeNull()
  await act(async () => second.resolve(ok({ exportOk: false })))
  await act(async () => {})
  expect(redText()?.textContent ?? '', 'STALE_RED_BACK 后发的那次没写进去，却被当成旧结果、红字没回来').toContain(DEFAULTS_TEXT)
})

/** 模型页保存还在路上时的页面（保存结果由测试放行） */
async function showWithPendingModelSave(overrides) {
  const save = deferred()
  const page = await show({ modelsHubSetEnabled: vi.fn(() => save.promise), ...overrides })
  fireEvent.click(tab('模型'))
  await act(async () => {})
  const toggle = within(document.querySelector('[data-hub-model="deepseek:deepseek-flash"]')).getByRole('switch')
  await act(async () => fireEvent.click(toggle))
  await openRules()
  return { page, save }
}

it('TC-005 先发模型页保存、后发重试：保存的成功先回来、重试的失败后回来，红字按磁盘说（G1 第 4 轮 F-001）', async () => {
  const response = deferred()
  const { save } = await showWithPendingModelSave({
    modelsRulesGet: vi.fn(queue(ok(rules()), ok(rules({ exportUsing: 'defaults' })))),
    modelsConfigRepublish: vi.fn(() => response.promise),
  })
  fireEvent.click(within(redText()).getByRole('button', { name: '重试' }))
  await act(async () => save.resolve(ok({ id: 'deepseek:deepseek-flash', enabled: false })))
  await act(async () => response.resolve(ok({ exportOk: false })))
  await act(async () => {})
  expect(redText()?.textContent ?? '', 'STALE_RED_BACK 后发的重试没写进去，被先发的模型页保存压掉了').toContain(DEFAULTS_TEXT)
})

it('TC-005 先发模型页保存、后发重试：重试的失败先回来、保存的成功后回来，红字按磁盘说（G1 第 4 轮 F-001）', async () => {
  const response = deferred()
  const { save } = await showWithPendingModelSave({
    modelsRulesGet: vi.fn(queue(ok(rules()), ok(rules({ exportUsing: 'defaults' })))),
    modelsConfigRepublish: vi.fn(() => response.promise),
  })
  fireEvent.click(within(redText()).getByRole('button', { name: '重试' }))
  await act(async () => response.resolve(ok({ exportOk: false })))
  await act(async () => {})
  await act(async () => save.resolve(ok({ id: 'deepseek:deepseek-flash', enabled: false })))
  await act(async () => {})
  expect(redText()?.textContent ?? '', 'STALE_RED_BACK 先发的模型页保存迟到的成功清掉了后发重试的失败').toContain(DEFAULTS_TEXT)
})
