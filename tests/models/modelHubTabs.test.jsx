/** v2.1.17 · 模型汇总两页签（模型 / 审核规则）界面行为；视觉对照另在真实窗口截图核对 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

vi.mock('../../src/components/Toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
  default: () => null,
  resetToastForTests: vi.fn(),
}))
const { toast } = await import('../../src/components/Toast')
const { default: Page } = await import('../../src/features/modelHub/ModelHubPage.jsx')
const { default: ModelDetail } = await import('../../src/features/models/ModelDetail.jsx')
const { capacityWarning } = await import('../../src/features/modelHub/reviewCapacity.js')

const levels = ['low', 'medium', 'high', 'xhigh', 'max']
const mk = (vendor, slug, displayName, enabled = false, efforts = levels, effort = 'high', extra = {}) => ({
  id: `${vendor}:${slug}`,
  displayName,
  enabled,
  efforts,
  effort,
  ...extra,
})
function hub() {
  return {
    providerConfigError: false,
    order: ['claude:opus', 'codex:gpt-6.1-sol', 'deepseek:deepseek-flash', 'minimax-plan:MiniMax-M3.1-Flash-Preview'],
    vendors: [
      {
        id: 'claude',
        name: 'Claude Code',
        color: 'var(--tool-claude)',
        blocked: null,
        models: [
          mk('claude', 'fable', 'Fable 5.1'),
          mk('claude', 'opus', 'Opus 5.5', true),
          mk('claude', 'sonnet', 'Sonnet 5.5'),
          mk('claude', 'haiku', 'Haiku 4.5'),
        ],
      },
      {
        id: 'codex',
        name: 'Codex',
        color: 'var(--tool-codex)',
        blocked: null,
        models: [
          mk('codex', 'gpt-6.1-sol', 'GPT-6.1-Sol', true, [...levels, 'ultra']),
          mk('codex', 'gpt-6-astra', 'GPT-6-Astra', false, [...levels, 'ultra']),
          ...Array.from({ length: 6 }, (_, i) => mk('codex', `other-${i}`, `Codex model ${i}`, false, [...levels, 'ultra'])),
        ],
      },
      {
        id: 'deepseek',
        name: 'DeepSeek',
        color: 'var(--ic-blue)',
        blocked: null,
        models: [mk('deepseek', 'deepseek-flash', 'deepseek-flash', true, ['low', 'high', 'max'], 'max')],
      },
      {
        id: 'minimax-plan',
        name: 'MiniMax M Plan',
        color: 'var(--ic-orange)',
        blocked: null,
        models: [mk('minimax-plan', 'MiniMax-M3.1-Flash-Preview', 'MiniMax-M3.1-Flash-Preview', true, levels, 'xhigh')],
      },
      {
        id: 'mimo-api',
        name: 'MiMo API',
        color: 'var(--ic-orange)',
        blocked: null,
        models: [mk('mimo-api', 'mimo-v2.6-pro', 'mimo-v2.6-pro', false, ['high'])],
      },
    ],
  }
}
const GATES = {
  'lite.G0': { reviewers: 1, rounds: 3 },
  'lite.G1': { reviewers: 2, rounds: 3 },
  'formal.G1': { reviewers: 1, rounds: 3 },
  'formal.G2b': { reviewers: 1, rounds: 2 },
  'formal.G3': { reviewers: 1, rounds: 3 },
  'formal.G4': { reviewers: 2, rounds: 3 },
}
function rules(patch = {}) {
  return {
    effective: { selfReview: false, gates: structuredClone(GATES), advanced: { timeoutMinutes: 20, failoverMax: 3, autoExtendRounds: 1 } },
    changed: false,
    defaultsVersion: '2026.10.1',
    dev: { claude: 'ok', codex: 'ok' },
    exportOk: true,
    ...patch,
  }
}
const ok = (data) => ({ success: true, data, error: null })
const DENIED = { success: false, data: null, error: { code: 'write_denied', message: '配置目录没有写入权限，检查权限后重试' } }
const deferred = () => {
  let resolve
  const promise = new Promise((r) => {
    resolve = r
  })
  return { promise, resolve }
}
function apiFor(data = hub(), rulesData = rules(), overrides = {}) {
  return {
    modelsHubList: vi.fn(async () => ok(structuredClone(data))),
    modelsHubSetEnabled: vi.fn(async (payload) => ok(payload)),
    modelsHubSetEffort: vi.fn(async (payload) => ok(payload)),
    modelsHubSetOrder: vi.fn(async (payload) => ok(payload)),
    modelsRulesGet: vi.fn(async () => ok(structuredClone(rulesData))),
    modelsRulesSet: vi.fn(async ({ key, value }) => ok({ key, value, changed: true })),
    modelsRulesReset: vi.fn(async () => ok({ effective: rules().effective, changed: false })),
    modelsConfigRepublish: vi.fn(async () => ok({ exportOk: true })),
    ...overrides,
  }
}
async function show(data, rulesData, overrides, props = {}) {
  const api = apiFor(data, rulesData, overrides)
  window.electronAPI = api
  const view = render(<Page {...props} />)
  await act(async () => {})
  return { api, ...view }
}
const tab = (name) => screen.getAllByRole('tab').find((el) => el.textContent.trim() === name)
async function rulesTab() {
  fireEvent.click(tab('审核规则'))
  await act(async () => {})
}
const enabledCard = () => document.querySelector('[data-hub-section="enabled"]')
const enabledIds = () => [...enabledCard().querySelectorAll('[data-hub-model]')].map((el) => el.getAttribute('data-hub-model'))
const row = (id) => document.querySelector(`[data-hub-model="${id}"]`)
const idx = (id) => row(id)?.querySelector('.mh-idx')?.textContent
const grip = (id) => row(id)?.querySelector('.mh-grip')
const toggleOf = (id) => within(row(id)).getByRole('switch')
const effortOf = (id) => row(id).querySelector('.mh-eff')
const fold = (name) =>
  screen.queryByRole('button', { name: `展开 ${name}` }) || screen.queryByRole('button', { name: `收起 ${name}` })
const gate = (id) => document.querySelector(`[data-gate="${id}"]`)
const gateButton = (id, kind) => gate(id).querySelector(kind === 'reviewers' ? '.mh-gate-n' : '.mh-gate-r')
const menu = () => screen.queryByRole('menu')
const pickItem = (name) => fireEvent.click(within(menu()).getByRole('menuitemradio', { name }))
const adv = (key) => document.querySelector(`[data-adv="${key}"]`)
const advFold = () => screen.queryByRole('button', { name: /高级/ })
const dialog = () => screen.queryByRole('dialog')
const text = () => document.body.textContent

/** 审核在用卡里每行 40 高，从 0 开始，拖动按鼠标纵坐标算落点 */
function layoutRows() {
  enabledCard()
    .querySelectorAll('[data-hub-model]')
    .forEach((el, i) => {
      el.getBoundingClientRect = () => ({ top: i * 40, bottom: i * 40 + 40, height: 40, left: 0, right: 400, width: 400, x: 0, y: i * 40 })
    })
}
function drag(id, toY) {
  layoutRows()
  const from = enabledIds().indexOf(id) * 40 + 20
  fireEvent.mouseDown(grip(id), { clientY: from, button: 0 })
  fireEvent.mouseMove(document, { clientY: toY })
  return () => fireEvent.mouseUp(document, { clientY: toY })
}

beforeEach(() => vi.clearAllMocks())
afterEach(() => {
  cleanup()
  document.querySelectorAll('.confirm-dialog-host').forEach((el) => el.remove())
  delete window.electronAPI
})

it('SC-001 打开默认在模型页签：两个不带数字的页签，审核在用按顺序带顺序号与把手，其余按来源折叠', async () => {
  await show()
  const tabs = screen.getAllByRole('tab')
  expect(tabs.map((el) => el.textContent.trim())).toEqual(['模型', '审核规则'])
  expect(document.querySelector('.tabbar__count')).toBeNull()
  expect(tab('模型')).toHaveAttribute('aria-selected', 'true')
  expect(document.querySelector('.np-toolbar, .page-shell')?.textContent || text()).toContain('模型汇总')
  expect(enabledIds()).toEqual(hub().order)
  expect(hub().order.map(idx)).toEqual(['1', '2', '3', '4'])
  for (const id of hub().order) expect(grip(id)).not.toBeNull()
  expect(within(enabledCard()).getByText('Claude Code')).toBeTruthy()
  expect(text()).toContain('4 个')
  for (const name of ['Claude Code', 'Codex', 'MiMo API']) expect(fold(name)).not.toBeNull()
  expect(fold('Codex')).toHaveAttribute('aria-expanded', 'false')
  expect(text()).toContain('「模型接入」里的模型要先测通，才会出现在这里')
})

it('SC-002 首次加载模型页签：页签先到，审核在用和其余模型出骨架', async () => {
  const pending = deferred()
  await show(undefined, undefined, { modelsHubList: vi.fn(() => pending.promise) })
  expect(screen.getAllByRole('tab')).toHaveLength(2)
  expect(enabledCard().querySelectorAll('.mh-skeleton-row').length).toBeGreaterThan(0)
  expect(document.querySelector('[data-hub-section="remaining"] .mh-skeleton-row')).not.toBeNull()
  expect(text()).not.toContain('读取失败')
  expect(text()).not.toContain('还没有打开的模型')
  await act(async () => pending.resolve(ok(hub())))
  expect(enabledIds()).toEqual(hub().order)
})

it('SC-003 一个都没开：审核在用只有空态一句，不写 0 个、卡内没有顺序号；其余模型照常', async () => {
  const data = hub()
  data.order = []
  data.vendors.forEach((v) => v.models.forEach((m) => (m.enabled = false)))
  await show(data)
  expect(within(enabledCard()).getByText('还没有打开的模型，审核会因为没有模型可用而停下')).toBeTruthy()
  expect(enabledCard().querySelector('.mh-idx')).toBeNull()
  expect(enabledCard().textContent).not.toMatch(/\d/)
  expect(text()).not.toContain('0 个')
  expect(fold('DeepSeek')).not.toBeNull()
  expect(fold('DeepSeek').textContent).toContain('1 个')
})

it('SC-004 本页设置坏了：两个页签都整块读取失败，可重试', async () => {
  const bad = { success: false, data: null, error: { code: 'HUB_FILE_INVALID', message: '模型汇总的设置文件无法解析，修好或删除它后重试' } }
  const { api } = await show(undefined, undefined, { modelsHubList: vi.fn(async () => bad), modelsRulesGet: vi.fn(async () => bad) })
  expect(text()).toContain('读取失败')
  expect(text()).toContain('模型汇总的设置文件无法解析，修好或删除它后重试')
  expect(enabledCard()).toBeNull()
  await rulesTab()
  expect(text()).toContain('模型汇总的设置文件无法解析，修好或删除它后重试')
  expect(gate('lite.G1')).toBeNull()
  api.modelsHubList.mockImplementation(async () => ok(hub()))
  api.modelsRulesGet.mockImplementation(async () => ok(rules()))
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  await act(async () => {})
  expect(api.modelsRulesGet.mock.calls.length + api.modelsHubList.mock.calls.length).toBeGreaterThan(2)
})

it('SC-005 最小窗口下的模型页签：长模型名单行省略并保留原名，来源、等级、开关不截', async () => {
  await show()
  const name = row('minimax-plan:MiniMax-M3.1-Flash-Preview').querySelector('.mh-name')
  expect(name).not.toBeNull()
  expect(name.textContent).toBe('MiniMax-M3.1-Flash-Preview')
  expect(name.closest('.mh-acts')).toBeNull()
  const acts = row('minimax-plan:MiniMax-M3.1-Flash-Preview').querySelector('.mh-acts')
  expect(acts.querySelector('.mh-eff')).not.toBeNull()
  expect(within(acts).getByRole('switch')).toBeTruthy()
  expect(row('minimax-plan:MiniMax-M3.1-Flash-Preview').querySelector('.mh-vd').textContent).toBe('MiniMax M Plan')
})

it('SC-006 离开再进入：重读、页签和展开回到默认、有上次结果先显示；去模型接入回来后新测通的出现在折叠条里', async () => {
  const onNavigate = vi.fn()
  const { api, unmount } = await show(undefined, undefined, undefined, { onNavigate })
  fireEvent.click(fold('Codex'))
  await rulesTab()
  fireEvent.click(advFold())
  expect(adv('timeoutMinutes')).not.toBeNull()
  unmount()
  const calls = api.modelsHubList.mock.calls.length
  const pending = deferred()
  api.modelsHubList.mockImplementation(() => pending.promise)
  render(<Page onNavigate={onNavigate} />)
  expect(tab('模型')).toHaveAttribute('aria-selected', 'true')
  expect(enabledIds()).toEqual(hub().order)
  expect(enabledCard().querySelector('.mh-skeleton-row')).toBeNull()
  expect(api.modelsHubList.mock.calls.length).toBe(calls + 1)
  const fresh = hub()
  fresh.vendors.find((v) => v.id === 'mimo-api').models.push(mk('mimo-api', 'mimo-v2.7', 'mimo-v2.7', false, ['high']))
  await act(async () => pending.resolve(ok(fresh)))
  expect(fold('Codex')).toHaveAttribute('aria-expanded', 'false')
  await rulesTab()
  expect(adv('timeoutMinutes')).toBeNull()
  fireEvent.click(tab('模型'))
  fireEvent.click(screen.getByRole('button', { name: '去模型接入' }))
  expect(onNavigate).toHaveBeenCalledWith('models')
  api.modelsHubList.mockImplementation(async () => ok(fresh))
  await act(async () => window.dispatchEvent(new Event('focus')))
  expect(fold('MiMo API').textContent).toContain('2 个')
  fireEvent.click(fold('MiMo API'))
  expect(toggleOf('mimo-api:mimo-v2.7')).toHaveAttribute('aria-checked', 'false')
})

it('SC-007 审核规则页签全貌：顶卡 dev 两端与默认值、派审核、两组六道关的默认个数轮数、高级默认收起', async () => {
  await show()
  await rulesTab()
  expect(tab('审核规则')).toHaveAttribute('aria-selected', 'true')
  for (const t of [
    'dev 插件',
    'Claude Code 端已生效',
    'Codex 端已生效',
    '默认值',
    '现在用的就是这个版本的建议值',
    '派审核',
    '写代码的那家也参与审核',
    '关着时只找别家的模型',
    '按「模型」里的顺序从上往下找，每道关派下面设的个数',
    '简单需求 · 快速开发',
    '复杂需求 · 完整开发',
    '其他',
  ])
    expect(text(), t).toContain(t)
  expect(screen.getByRole('button', { name: '恢复默认' })).toBeDisabled()
  expect(screen.getByRole('switch', { name: '写代码的那家也参与审核' })).toHaveAttribute('aria-checked', 'false')
  const expected = [
    ['lite.G0', '开工前检查', '计划和测试清单', '1 个模型', '每个 3 轮'],
    ['lite.G1', '代码审核', '代码改动和测试结果', '2 个模型', '每个 3 轮'],
    ['formal.G1', '需求对齐', '计划有没有理解歪你的原话', '1 个模型', '每个 3 轮'],
    ['formal.G2b', '答后再对齐', '选择题的回答有没有写对', '1 个模型', '每个 2 轮'],
    ['formal.G3', '开工前检查', '文档、测试用例和漏问的选择', '1 个模型', '每个 3 轮'],
    ['formal.G4', '代码审核', '代码改动、测试结果和截图', '2 个模型', '每个 3 轮'],
  ]
  for (const [id, name, sub, n, r] of expected) {
    expect(gate(id), id).not.toBeNull()
    expect(gate(id).textContent).toContain(name)
    expect(gate(id).textContent).toContain(sub)
    expect(gateButton(id, 'reviewers').textContent).toContain(n)
    expect(gateButton(id, 'rounds').textContent).toContain(r)
  }
  expect(advFold()).toHaveAttribute('aria-expanded', 'false')
  expect(advFold().textContent).toContain('最长时间、换模型次数、自动加轮')
  expect(adv('timeoutMinutes')).toBeNull()
  fireEvent.click(advFold())
  expect(adv('timeoutMinutes').textContent).toContain('一次审核最长')
  expect(adv('timeoutMinutes').textContent).toContain('20 分钟')
  expect(adv('failoverMax').textContent).toContain('一个模型挂了最多换')
  expect(adv('failoverMax').textContent).toContain('3 次')
  expect(adv('autoExtendRounds').textContent).toContain('轮次用完自动加')
  expect(adv('autoExtendRounds').textContent).toContain('1 轮')
})

it('SC-008 首次加载审核规则页签：分组标题先出、关卡行出骨架，不出数值和报错', async () => {
  const pending = deferred()
  await show(undefined, undefined, { modelsRulesGet: vi.fn(() => pending.promise) })
  await rulesTab()
  expect(text()).toContain('派审核')
  expect(text()).toContain('简单需求 · 快速开发')
  expect(text()).toContain('复杂需求 · 完整开发')
  expect(document.querySelectorAll('.mh-skeleton-row').length).toBeGreaterThan(0)
  expect(text()).not.toContain('每个 3 轮')
  expect(text()).not.toContain('读取失败')
  await act(async () => pending.resolve(ok(rules())))
  expect(gate('lite.G1')).not.toBeNull()
})

it('SC-009 审核规则文件坏了：只有审核规则页签整块失败可重试，模型页签照常', async () => {
  const bad = { success: false, data: null, error: { code: 'RULES_FILE_INVALID', message: '审核规则文件无法解析，修好或删除它后重试' } }
  const { api } = await show(undefined, undefined, { modelsRulesGet: vi.fn(async () => bad) })
  expect(enabledIds()).toEqual(hub().order)
  await rulesTab()
  expect(text()).toContain('读取失败')
  expect(text()).toContain('审核规则文件无法解析，修好或删除它后重试')
  expect(gate('lite.G1')).toBeNull()
  api.modelsRulesGet.mockImplementation(async () => ok(rules()))
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  await act(async () => {})
  expect(gate('lite.G1')).not.toBeNull()
  fireEvent.click(tab('模型'))
  expect(enabledIds()).toEqual(hub().order)
})

it('SC-010 最小窗口下的审核规则页签：关名小字可省略，两个选择按钮在同一行容器里', async () => {
  await show()
  await rulesTab()
  const sub = gate('lite.G0').querySelector('.mh-gsub')
  expect(sub).not.toBeNull()
  expect(sub.textContent).toBe('计划和测试清单')
  const acts = gate('lite.G0').querySelector('.mh-gate-acts')
  expect(acts.contains(gateButton('lite.G0', 'reviewers'))).toBe(true)
  expect(acts.contains(gateButton('lite.G0', 'rounds'))).toBe(true)
})

it('SC-011 窗口回到前台：只重读数据，仍停在审核规则页签，高级保持展开', async () => {
  const { api } = await show()
  await rulesTab()
  fireEvent.click(advFold())
  const hubCalls = api.modelsHubList.mock.calls.length
  const ruleCalls = api.modelsRulesGet.mock.calls.length
  await act(async () => window.dispatchEvent(new Event('focus')))
  expect(api.modelsHubList.mock.calls.length).toBe(hubCalls + 1)
  expect(api.modelsRulesGet.mock.calls.length).toBe(ruleCalls + 1)
  expect(tab('审核规则')).toHaveAttribute('aria-selected', 'true')
  expect(advFold()).toHaveAttribute('aria-expanded', 'true')
  expect(adv('timeoutMinutes')).not.toBeNull()
})

it('SC-012 打开一个模型排到最后；关掉回到折叠条、顺序号前移；关掉最后一个换成空态', async () => {
  const { api } = await show()
  fireEvent.click(fold('Codex'))
  await act(async () => fireEvent.click(toggleOf('codex:gpt-6-astra')))
  expect(api.modelsHubSetEnabled).toHaveBeenCalledWith({ id: 'codex:gpt-6-astra', enabled: true })
  expect(toast.success).toHaveBeenCalledWith('GPT-6-Astra 已用于审核')
  expect(enabledIds().at(-1)).toBe('codex:gpt-6-astra')
  expect(idx('codex:gpt-6-astra')).toBe('5')
  await act(async () => fireEvent.click(toggleOf('claude:opus')))
  expect(toast.success).toHaveBeenCalledWith('Opus 5.5 不再用于审核')
  expect(enabledIds()[0]).toBe('codex:gpt-6.1-sol')
  expect(idx('codex:gpt-6.1-sol')).toBe('1')
  fireEvent.click(fold('Claude Code'))
  expect(row('claude:opus').closest('[data-hub-section]')).toHaveAttribute('data-hub-section', 'remaining')
  expect(toggleOf('claude:opus')).toHaveAttribute('aria-checked', 'false')
  for (const id of [...enabledIds()]) await act(async () => fireEvent.click(toggleOf(id)))
  expect(within(enabledCard()).getByText('还没有打开的模型，审核会因为没有模型可用而停下')).toBeTruthy()
})

it('SC-013 开关保存中：先变成目标值并禁用，再点不重复提交', async () => {
  const pending = deferred()
  const { api } = await show(undefined, undefined, { modelsHubSetEnabled: vi.fn(() => pending.promise) })
  fireEvent.click(fold('Codex'))
  fireEvent.click(toggleOf('codex:gpt-6-astra'))
  expect(toggleOf('codex:gpt-6-astra')).toHaveAttribute('aria-checked', 'true')
  expect(toggleOf('codex:gpt-6-astra')).toHaveAttribute('aria-disabled', 'true')
  fireEvent.click(toggleOf('codex:gpt-6-astra'))
  expect(api.modelsHubSetEnabled).toHaveBeenCalledTimes(1)
  await act(async () => pending.resolve(ok({ id: 'codex:gpt-6-astra', enabled: true })))
})

it('SC-014 开关保存失败：退回原值并红色提示；退回也失败、写入锁被占各有原因', async () => {
  const { api } = await show(undefined, undefined, { modelsHubSetEnabled: vi.fn(async () => DENIED) })
  fireEvent.click(fold('Codex'))
  await act(async () => fireEvent.click(toggleOf('codex:gpt-6-astra')))
  expect(toggleOf('codex:gpt-6-astra')).toHaveAttribute('aria-checked', 'false')
  expect(toast.error).toHaveBeenCalledWith('保存失败：配置目录没有写入权限，检查权限后重试')
  api.modelsHubSetEnabled.mockImplementation(async () => ({
    success: false,
    data: null,
    error: { code: 'ROLLBACK_FAILED', message: '保存失败，也没能退回原来的设置；检查配置目录的权限后重启 CodePal' },
  }))
  await act(async () => fireEvent.click(toggleOf('codex:gpt-6-astra')))
  expect(toast.error).toHaveBeenLastCalledWith('保存失败，也没能退回原来的设置；检查配置目录的权限后重启 CodePal')
  api.modelsHubSetEnabled.mockImplementation(async () => ({
    success: false,
    data: null,
    error: { code: 'LOCK_BUSY', message: '另一个 CodePal 正在写这份配置，关掉它后重试' },
  }))
  await act(async () => fireEvent.click(toggleOf('codex:gpt-6-astra')))
  expect(toast.error).toHaveBeenLastCalledWith('保存失败：另一个 CodePal 正在写这份配置，关掉它后重试')
  expect(enabledIds()).toEqual(hub().order)
})

it('SC-015 只开了一家订阅且自审关：卡下橙字；自审开着、两家都开时不显示', async () => {
  const only = (vendor) => {
    const data = hub()
    data.vendors.forEach((v) => v.models.forEach((m) => (m.enabled = v.id === vendor && m.id.endsWith(vendor === 'codex' ? 'gpt-6.1-sol' : 'opus'))))
    data.order = [vendor === 'codex' ? 'codex:gpt-6.1-sol' : 'claude:opus']
    return data
  }
  await show(only('codex'))
  expect(document.querySelector('.mh-foot.warn')?.textContent).toBe('只开了 Codex：用 Codex 写代码时，没有别家模型来审')
  cleanup()
  await show(only('claude'))
  expect(document.querySelector('.mh-foot.warn')?.textContent).toBe('只开了 Claude：用 Claude Code 写代码时，没有别家模型来审')
  cleanup()
  await show(only('codex'), rules({ effective: { ...rules().effective, selfReview: true } }))
  expect(document.querySelector('.mh-foot.warn')).toBeNull()
  cleanup()
  await show()
  expect(document.querySelector('.mh-foot.warn')).toBeNull()
})

it('SC-016 拖动或键盘调整顺序：松手整串保存一次，顺序号重排；↑ ↓ 一次一位，首尾不越界', async () => {
  const { api } = await show()
  const release = drag('minimax-plan:MiniMax-M3.1-Flash-Preview', 50)
  await act(async () => release())
  const moved = ['claude:opus', 'minimax-plan:MiniMax-M3.1-Flash-Preview', 'codex:gpt-6.1-sol', 'deepseek:deepseek-flash']
  expect(api.modelsHubSetOrder).toHaveBeenCalledTimes(1)
  expect(api.modelsHubSetOrder).toHaveBeenCalledWith({ order: moved })
  expect(enabledIds()).toEqual(moved)
  expect(moved.map(idx)).toEqual(['1', '2', '3', '4'])
  expect(toast.success).toHaveBeenCalledWith('已保存')
  await act(async () => fireEvent.keyDown(grip('deepseek:deepseek-flash'), { key: 'ArrowUp' }))
  expect(api.modelsHubSetOrder).toHaveBeenLastCalledWith({
    order: ['claude:opus', 'minimax-plan:MiniMax-M3.1-Flash-Preview', 'deepseek:deepseek-flash', 'codex:gpt-6.1-sol'],
  })
  await act(async () => fireEvent.keyDown(grip('claude:opus'), { key: 'ArrowDown' }))
  expect(api.modelsHubSetOrder).toHaveBeenLastCalledWith({
    order: ['minimax-plan:MiniMax-M3.1-Flash-Preview', 'claude:opus', 'deepseek:deepseek-flash', 'codex:gpt-6.1-sol'],
  })
  const calls = api.modelsHubSetOrder.mock.calls.length
  await act(async () => fireEvent.keyDown(grip('minimax-plan:MiniMax-M3.1-Flash-Preview'), { key: 'ArrowUp' }))
  await act(async () => fireEvent.keyDown(grip('codex:gpt-6.1-sol'), { key: 'ArrowDown' }))
  expect(api.modelsHubSetOrder).toHaveBeenCalledTimes(calls)
  expect(grip('claude:opus').tagName).toBe('BUTTON')
})

it('SC-017 松手后保存中：先显示新顺序，整张卡禁用', async () => {
  const pending = deferred()
  const { api } = await show(undefined, undefined, { modelsHubSetOrder: vi.fn(() => pending.promise) })
  const release = drag('deepseek:deepseek-flash', 10)
  await act(async () => release())
  expect(enabledIds()[0]).toBe('deepseek:deepseek-flash')
  expect(enabledCard()).toHaveAttribute('aria-busy', 'true')
  expect(toggleOf('claude:opus')).toHaveAttribute('aria-disabled', 'true')
  expect(grip('claude:opus')).toBeDisabled()
  await act(async () => fireEvent.keyDown(grip('claude:opus'), { key: 'ArrowDown' }))
  expect(api.modelsHubSetOrder).toHaveBeenCalledTimes(1)
  await act(async () => pending.resolve(ok({ order: enabledIds() })))
  expect(enabledCard()).not.toHaveAttribute('aria-busy', 'true')
})

it('SC-018 拖动保存失败：回到原来的顺序并红色提示', async () => {
  await show(undefined, undefined, { modelsHubSetOrder: vi.fn(async () => DENIED) })
  const release = drag('deepseek:deepseek-flash', 10)
  await act(async () => release())
  expect(enabledIds()).toEqual(hub().order)
  expect(toast.error).toHaveBeenCalledWith('保存失败：配置目录没有写入权限，检查权限后重试')
})

it('SC-019 只有一个模型时不画把手，顺序号仍写 1', async () => {
  const data = hub()
  data.vendors.forEach((v) => v.models.forEach((m) => (m.enabled = m.id === 'codex:gpt-6.1-sol')))
  data.order = ['codex:gpt-6.1-sol']
  await show(data)
  expect(grip('codex:gpt-6.1-sol')).toBeFalsy()
  expect(row('codex:gpt-6.1-sol').querySelector('.mh-grip-space')).not.toBeNull()
  expect(idx('codex:gpt-6.1-sol')).toBe('1')
})

it('SC-020 拖动中按 Esc：放回原位，不保存', async () => {
  const { api } = await show()
  drag('deepseek:deepseek-flash', 10)
  await act(async () => fireEvent.keyDown(document, { key: 'Escape' }))
  fireEvent.mouseUp(document, { clientY: 10 })
  expect(api.modelsHubSetOrder).not.toHaveBeenCalled()
  expect(enabledIds()).toEqual(hub().order)
  expect(hub().order.map(idx)).toEqual(['1', '2', '3', '4'])
})

it('SC-021 换审核用的思考等级；档位不再支持显示默认档加小字；没有档位不显示按钮；模型接入页标出终端手动用', async () => {
  const data = hub()
  data.vendors.find((v) => v.id === 'mimo-api').models[0] = mk('mimo-api', 'mimo-v2.6-pro', 'mimo-v2.6-pro', true, ['high'], 'high', { effortUnsupported: 'max' })
  data.vendors.find((v) => v.id === 'minimax-plan').models.push(mk('minimax-plan', 'MiniMax-M3', 'MiniMax-M3', true, [], null))
  data.order = [...data.order, 'mimo-api:mimo-v2.6-pro', 'minimax-plan:MiniMax-M3']
  const { api } = await show(data)
  fireEvent.click(effortOf('deepseek:deepseek-flash'))
  await act(async () => pickItem('high'))
  expect(api.modelsHubSetEffort).toHaveBeenCalledWith({ id: 'deepseek:deepseek-flash', effort: 'high' })
  expect(toast.success).toHaveBeenCalledWith('已保存')
  expect(effortOf('deepseek:deepseek-flash').textContent).toContain('high')
  expect(effortOf('mimo-api:mimo-v2.6-pro').textContent).toContain('high')
  expect(row('mimo-api:mimo-v2.6-pro').textContent).toContain('原来的 max 不再支持')
  expect(effortOf('minimax-plan:MiniMax-M3')).toBeNull()
  cleanup()
  render(
    <ModelDetail
      model={{ id: 'deepseek-flash', name: 'deepseek-flash', effort: 'max', efforts: ['low', 'high', 'max'], contextTokens: 1000000, maxOutputTokens: 128000 }}
      otherNames={[]}
      command="codepal-deepseek--deepseek-flash"
      removing={false}
      onUpdate={vi.fn()}
      onRemove={vi.fn()}
    />,
  )
  expect(screen.getByText('终端手动用')).toBeTruthy()
})

it('SC-022 等级保存中：按钮先显示新档并禁用', async () => {
  const pending = deferred()
  await show(undefined, undefined, { modelsHubSetEffort: vi.fn(() => pending.promise) })
  fireEvent.click(effortOf('deepseek:deepseek-flash'))
  pickItem('high')
  expect(effortOf('deepseek:deepseek-flash').textContent).toContain('high')
  expect(effortOf('deepseek:deepseek-flash')).toBeDisabled()
  await act(async () => pending.resolve(ok({ id: 'deepseek:deepseek-flash', effort: 'high' })))
})

it('SC-023 等级保存失败：退回 max 并红色提示', async () => {
  await show(undefined, undefined, { modelsHubSetEffort: vi.fn(async () => DENIED) })
  fireEvent.click(effortOf('deepseek:deepseek-flash'))
  await act(async () => pickItem('high'))
  expect(effortOf('deepseek:deepseek-flash').textContent).toContain('max')
  expect(toast.error).toHaveBeenCalledWith('保存失败：配置目录没有写入权限，检查权限后重试')
})

it('SC-024 打开等级菜单后不选：只列支持的档位、当前打勾；Esc 收起、点当前档都不保存', async () => {
  const { api } = await show()
  fireEvent.click(effortOf('deepseek:deepseek-flash'))
  const items = within(menu()).getAllByRole('menuitemradio')
  expect(items.map((el) => el.getAttribute('aria-label'))).toEqual(['low', 'high', 'max'])
  expect(within(menu()).getByRole('menuitemradio', { name: 'max' })).toHaveAttribute('aria-checked', 'true')
  fireEvent.keyDown(menu(), { key: 'Escape' })
  expect(menu()).toBeNull()
  fireEvent.click(effortOf('deepseek:deepseek-flash'))
  await act(async () => pickItem('max'))
  expect(api.modelsHubSetEffort).not.toHaveBeenCalled()
  expect(effortOf('deepseek:deepseek-flash').textContent).toContain('max')
})

it('SC-025 每道关改个数和轮数：点了就保存，恢复默认变可点', async () => {
  const { api } = await show()
  await rulesTab()
  fireEvent.click(gateButton('lite.G1', 'reviewers'))
  expect(within(menu()).getAllByRole('menuitemradio').map((el) => el.getAttribute('aria-label'))).toEqual(['1 个模型', '2 个模型', '3 个模型'])
  await act(async () => pickItem('3 个模型'))
  expect(api.modelsRulesSet).toHaveBeenCalledWith({ key: 'gates.lite.G1.reviewers', value: 3 })
  expect(toast.success).toHaveBeenCalledWith('已保存')
  expect(gateButton('lite.G1', 'reviewers').textContent).toContain('3 个模型')
  expect(screen.getByRole('button', { name: '恢复默认' })).not.toBeDisabled()
  fireEvent.click(gateButton('formal.G3', 'rounds'))
  await act(async () => pickItem('每个 2 轮'))
  expect(api.modelsRulesSet).toHaveBeenLastCalledWith({ key: 'gates.formal.G3.rounds', value: 2 })
  expect(gateButton('formal.G3', 'rounds').textContent).toContain('每个 2 轮')
})

it('SC-026 个数保存中：按钮先显示新值并禁用', async () => {
  const pending = deferred()
  await show(undefined, undefined, { modelsRulesSet: vi.fn(() => pending.promise) })
  await rulesTab()
  fireEvent.click(gateButton('lite.G1', 'reviewers'))
  pickItem('3 个模型')
  expect(gateButton('lite.G1', 'reviewers').textContent).toContain('3 个模型')
  expect(gateButton('lite.G1', 'reviewers')).toBeDisabled()
  await act(async () => pending.resolve(ok({ key: 'gates.lite.G1.reviewers', value: 3, changed: true })))
})

it('SC-026 个数保存中：默认值一行跟着显示的值写「恢复成这个版本配好的建议值」、恢复默认可点；失败退回后恢复原样', async () => {
  const pending = deferred()
  await show(undefined, rules({ suggested: rules().effective }), { modelsRulesSet: vi.fn(() => pending.promise) })
  await rulesTab()
  const defaultsRow = () => document.querySelector('[data-rules="defaults"]')
  expect(defaultsRow().textContent).toContain('现在用的就是这个版本的建议值')
  fireEvent.click(gateButton('lite.G1', 'reviewers'))
  pickItem('3 个模型')
  expect(defaultsRow().textContent).toContain('恢复成这个版本配好的建议值')
  expect(within(defaultsRow()).getByRole('button', { name: '恢复默认' })).not.toBeDisabled()
  await act(async () => pending.resolve(DENIED))
  expect(gateButton('lite.G1', 'reviewers').textContent).toContain('2 个模型')
  expect(defaultsRow().textContent).toContain('现在用的就是这个版本的建议值')
  expect(within(defaultsRow()).getByRole('button', { name: '恢复默认' })).toBeDisabled()
})

it('SC-027 个数保存失败：退回原值并红色提示；退回也失败给出原因', async () => {
  const { api } = await show(undefined, undefined, { modelsRulesSet: vi.fn(async () => DENIED) })
  await rulesTab()
  fireEvent.click(gateButton('lite.G1', 'reviewers'))
  await act(async () => pickItem('3 个模型'))
  expect(gateButton('lite.G1', 'reviewers').textContent).toContain('2 个模型')
  expect(toast.error).toHaveBeenCalledWith('保存失败：配置目录没有写入权限，检查权限后重试')
  api.modelsRulesSet.mockImplementation(async () => ({
    success: false,
    data: null,
    error: { code: 'ROLLBACK_FAILED', message: '保存失败，也没能退回原来的设置；检查配置目录的权限后重启 CodePal' },
  }))
  fireEvent.click(gateButton('lite.G1', 'reviewers'))
  await act(async () => pickItem('3 个模型'))
  expect(toast.error).toHaveBeenLastCalledWith('保存失败，也没能退回原来的设置；检查配置目录的权限后重启 CodePal')
})

it('SC-028 能来审的不够设的个数：自审开关下橙字说明实际只派几个（两种情况人数不同时分开写）', async () => {
  const data = hub()
  data.vendors.forEach((v) => v.models.forEach((m) => (m.enabled = ['claude:opus', 'claude:sonnet', 'codex:gpt-6.1-sol'].includes(m.id))))
  data.order = ['claude:opus', 'claude:sonnet', 'codex:gpt-6.1-sol']
  const r = rules()
  r.effective.gates['lite.G1'].reviewers = 3
  await show(data, r)
  await rulesTab()
  const warning = document.querySelector('[data-rules="capacity"]')
  expect(warning?.textContent).toBe('用 Claude Code 写代码时只有 1 个模型能来审，用 Codex 写代码时只有 2 个；设成 2 个、3 个的关只会派这么多')
  expect(warning.textContent).toBe(
    capacityWarning(
      data.order.map((id) => ({ id, vendor: id.split(':')[0] })),
      false,
      r.effective.gates,
    ),
  )
  expect(warning.classList.contains('warn')).toBe(true)
  // 灰字说明常驻，橙字另起一行
  expect(text()).toContain('按「模型」里的顺序从上往下找，每道关派下面设的个数')
})

it('SC-029 打开个数菜单后不选：Esc 收起、点当前值都不保存；轮数菜单 1–5', async () => {
  const { api } = await show()
  await rulesTab()
  fireEvent.click(gateButton('lite.G1', 'reviewers'))
  expect(within(menu()).getByRole('menuitemradio', { name: '2 个模型' })).toHaveAttribute('aria-checked', 'true')
  fireEvent.keyDown(menu(), { key: 'Escape' })
  expect(menu()).toBeNull()
  fireEvent.click(gateButton('lite.G1', 'reviewers'))
  await act(async () => pickItem('2 个模型'))
  fireEvent.click(gateButton('lite.G1', 'rounds'))
  expect(within(menu()).getAllByRole('menuitemradio').map((el) => el.getAttribute('aria-label'))).toEqual([
    '每个 1 轮',
    '每个 2 轮',
    '每个 3 轮',
    '每个 4 轮',
    '每个 5 轮',
  ])
  fireEvent.keyDown(menu(), { key: 'Escape' })
  expect(api.modelsRulesSet).not.toHaveBeenCalled()
  expect(gateButton('lite.G1', 'reviewers').textContent).toContain('2 个模型')
})

it('SC-030 打开自审：点即保存不弹确认；保存失败退回关并红色提示', async () => {
  const { api } = await show()
  await rulesTab()
  const self = screen.getByRole('switch', { name: '写代码的那家也参与审核' })
  await act(async () => fireEvent.click(self))
  expect(dialog()).toBeNull()
  expect(api.modelsRulesSet).toHaveBeenCalledWith({ key: 'selfReview', value: true })
  expect(toast.success).toHaveBeenCalledWith('已保存')
  expect(self).toHaveAttribute('aria-checked', 'true')
  api.modelsRulesSet.mockImplementation(async () => DENIED)
  await act(async () => fireEvent.click(self))
  expect(self).toHaveAttribute('aria-checked', 'true')
  expect(toast.error).toHaveBeenCalledWith('保存失败：配置目录没有写入权限，检查权限后重试')
})

it('SC-031 自审保存中：开关先变开并禁用', async () => {
  const pending = deferred()
  await show(undefined, undefined, { modelsRulesSet: vi.fn(() => pending.promise) })
  await rulesTab()
  const self = screen.getByRole('switch', { name: '写代码的那家也参与审核' })
  fireEvent.click(self)
  expect(self).toHaveAttribute('aria-checked', 'true')
  expect(self).toHaveAttribute('aria-disabled', 'true')
  await act(async () => pending.resolve(ok({ key: 'selfReview', value: true, changed: true })))
})

it('SC-032 自审开着：只开一家的提示消失；能来审的重算后仍不够照样提示', async () => {
  const data = hub()
  data.vendors.forEach((v) => v.models.forEach((m) => (m.enabled = m.id === 'codex:gpt-6.1-sol')))
  data.order = ['codex:gpt-6.1-sol']
  const r = rules({ effective: { ...rules().effective, selfReview: true } })
  r.effective.gates['lite.G1'].reviewers = 3
  await show(data, r)
  expect(document.querySelector('.mh-foot.warn')).toBeNull()
  await rulesTab()
  expect(document.querySelector('[data-rules="capacity"]')?.textContent).toBe(
    '不管用 Claude Code 还是 Codex 写代码，都只有 1 个模型能来审；设成 2 个、3 个的关只会派 1 个',
  )
  cleanup()
  await show(hub(), rules({ effective: { ...rules().effective, selfReview: true } }))
  await rulesTab()
  expect(document.querySelector('[data-rules="capacity"]')).toBeNull()
})

it('SC-033 高级：改最长时间、换模型次数、自动加轮都点了就保存；保存中禁用、失败退回', async () => {
  const pending = deferred()
  const { api } = await show()
  await rulesTab()
  fireEvent.click(advFold())
  fireEvent.click(adv('timeoutMinutes').querySelector('button'))
  await act(async () => pickItem('30 分钟'))
  expect(api.modelsRulesSet).toHaveBeenCalledWith({ key: 'advanced.timeoutMinutes', value: 30 })
  expect(adv('timeoutMinutes').textContent).toContain('30 分钟')
  fireEvent.click(adv('failoverMax').querySelector('button'))
  await act(async () => pickItem('5 次'))
  expect(api.modelsRulesSet).toHaveBeenLastCalledWith({ key: 'advanced.failoverMax', value: 5 })
  fireEvent.click(adv('autoExtendRounds').querySelector('button'))
  await act(async () => pickItem('0 轮'))
  expect(api.modelsRulesSet).toHaveBeenLastCalledWith({ key: 'advanced.autoExtendRounds', value: 0 })
  api.modelsRulesSet.mockImplementation(() => pending.promise)
  fireEvent.click(adv('timeoutMinutes').querySelector('button'))
  pickItem('45 分钟')
  expect(adv('timeoutMinutes').querySelector('button')).toBeDisabled()
  expect(adv('timeoutMinutes').textContent).toContain('45 分钟')
  await act(async () => pending.resolve(DENIED))
  expect(adv('timeoutMinutes').textContent).toContain('30 分钟')
  expect(toast.error).toHaveBeenCalledWith('保存失败：配置目录没有写入权限，检查权限后重试')
})

it('SC-034 打开时间菜单后不选：7 档、当前打勾；Esc 与点当前档都不保存', async () => {
  const { api } = await show()
  await rulesTab()
  fireEvent.click(advFold())
  fireEvent.click(adv('timeoutMinutes').querySelector('button'))
  expect(within(menu()).getAllByRole('menuitemradio').map((el) => el.getAttribute('aria-label'))).toEqual([
    '5 分钟',
    '10 分钟',
    '15 分钟',
    '20 分钟',
    '30 分钟',
    '45 分钟',
    '60 分钟',
  ])
  expect(within(menu()).getByRole('menuitemradio', { name: '20 分钟' })).toHaveAttribute('aria-checked', 'true')
  fireEvent.keyDown(menu(), { key: 'Escape' })
  expect(menu()).toBeNull()
  fireEvent.click(adv('timeoutMinutes').querySelector('button'))
  await act(async () => pickItem('20 分钟'))
  expect(api.modelsRulesSet).not.toHaveBeenCalled()
})

it('SC-035 恢复默认成功：回到建议值，提示已恢复默认，按钮变灰', async () => {
  const r = rules({ changed: true })
  r.effective.gates['lite.G1'].reviewers = 3
  const { api } = await show(undefined, r)
  await rulesTab()
  fireEvent.click(screen.getByRole('button', { name: '恢复默认' }))
  await waitFor(() => expect(dialog()).not.toBeNull())
  await act(async () => fireEvent.click(within(dialog()).getByRole('button', { name: '恢复默认' })))
  expect(api.modelsRulesReset).toHaveBeenCalledTimes(1)
  expect(toast.success).toHaveBeenCalledWith('已恢复默认')
  await waitFor(() => expect(dialog()).toBeNull())
  expect(gateButton('lite.G1', 'reviewers').textContent).toContain('2 个模型')
  expect(text()).toContain('现在用的就是这个版本的建议值')
  expect(screen.getByRole('button', { name: '恢复默认' })).toBeDisabled()
})

it('SC-036 恢复中：对话框按钮禁用，不重复提交', async () => {
  const pending = deferred()
  const { api } = await show(undefined, rules({ changed: true }), { modelsRulesReset: vi.fn(() => pending.promise) })
  await rulesTab()
  fireEvent.click(screen.getByRole('button', { name: '恢复默认' }))
  await waitFor(() => expect(dialog()).not.toBeNull())
  const confirm = within(dialog()).getByRole('button', { name: '恢复默认' })
  fireEvent.click(confirm)
  await waitFor(() => expect(confirm).toBeDisabled())
  fireEvent.click(confirm)
  expect(api.modelsRulesReset).toHaveBeenCalledTimes(1)
  await act(async () => pending.resolve(ok({ effective: rules().effective, changed: false })))
})

it('SC-037 恢复失败：对话框留着并红色提示，规则不变', async () => {
  const r = rules({ changed: true })
  r.effective.gates['lite.G1'].reviewers = 3
  await show(undefined, r, { modelsRulesReset: vi.fn(async () => DENIED) })
  await rulesTab()
  fireEvent.click(screen.getByRole('button', { name: '恢复默认' }))
  await waitFor(() => expect(dialog()).not.toBeNull())
  await act(async () => fireEvent.click(within(dialog()).getByRole('button', { name: '恢复默认' })))
  expect(toast.error).toHaveBeenCalledWith('保存失败：配置目录没有写入权限，检查权限后重试')
  expect(dialog()).not.toBeNull()
  expect(gateButton('lite.G1', 'reviewers').textContent).toContain('3 个模型')
})

it('SC-038 改过规则时：说明换成恢复成建议值，按钮可点', async () => {
  await show(undefined, rules({ changed: true }))
  await rulesTab()
  expect(text()).toContain('恢复成这个版本配好的建议值')
  expect(text()).not.toContain('现在用的就是这个版本的建议值')
  expect(screen.getByRole('button', { name: '恢复默认' })).not.toBeDisabled()
})

it('SC-039 确认对话框：写明只恢复规则不动模型；取消什么都不改', async () => {
  const { api } = await show(undefined, rules({ changed: true }))
  await rulesTab()
  fireEvent.click(screen.getByRole('button', { name: '恢复默认' }))
  await waitFor(() => expect(dialog()).not.toBeNull())
  expect(dialog().textContent).toContain('恢复默认的审核规则？')
  expect(dialog().textContent).toContain('每道关的个数和轮数、自审开关、高级三项都回到这个版本配好的建议值；模型的开关、顺序和思考等级不变。')
  await act(async () => fireEvent.click(within(dialog()).getByRole('button', { name: '取消' })))
  await waitFor(() => expect(dialog()).toBeNull())
  expect(api.modelsRulesReset).not.toHaveBeenCalled()
})

it('SC-040 dev 两端都已生效：两个绿点', async () => {
  await show()
  await rulesTab()
  const claude = document.querySelector('[data-dev-end="claude"]')
  const codex = document.querySelector('[data-dev-end="codex"]')
  expect(claude.textContent).toBe('Claude Code 端已生效')
  expect(codex.textContent).toBe('Codex 端已生效')
  expect(claude.classList.contains('ok')).toBe(true)
  expect(codex.classList.contains('ok')).toBe(true)
})

it('SC-041 两端都没装 dev：两端标橙写没装，规则照样能改', async () => {
  const { api } = await show(undefined, rules({ dev: { claude: 'none', codex: 'none' } }))
  await rulesTab()
  expect(document.querySelector('[data-dev-end="claude"]').textContent).toBe('Claude Code 端没装')
  expect(document.querySelector('[data-dev-end="codex"]').textContent).toBe('Codex 端没装')
  expect(document.querySelector('[data-dev-end="codex"]').classList.contains('warn')).toBe(true)
  fireEvent.click(gateButton('lite.G1', 'reviewers'))
  await act(async () => pickItem('3 个模型'))
  expect(api.modelsRulesSet).toHaveBeenCalled()
})

it('SC-042 读不出版本：那一端标橙写版本未知，另一端照常', async () => {
  await show(undefined, rules({ dev: { claude: 'ok', codex: 'unknown' } }))
  await rulesTab()
  expect(document.querySelector('[data-dev-end="claude"]').textContent).toBe('Claude Code 端已生效')
  expect(document.querySelector('[data-dev-end="codex"]').textContent).toBe('Codex 端版本未知')
  expect(document.querySelector('[data-dev-end="codex"]').classList.contains('warn')).toBe(true)
  cleanup()
  await show(undefined, rules({ dev: { claude: 'unknown', codex: 'ok' } }))
  await rulesTab()
  expect(document.querySelector('[data-dev-end="claude"]').textContent).toBe('Claude Code 端版本未知')
})

it('SC-043 版本太旧：那一端标橙写版本太旧', async () => {
  await show(undefined, rules({ dev: { claude: 'old', codex: 'old' } }))
  await rulesTab()
  expect(document.querySelector('[data-dev-end="claude"]').textContent).toBe('Claude Code 端版本太旧')
  expect(document.querySelector('[data-dev-end="codex"]').textContent).toBe('Codex 端版本太旧')
})

it('SC-044 保存后重新生成审核配置：页面只弹已保存，不出红字', async () => {
  await show()
  await rulesTab()
  fireEvent.click(gateButton('lite.G1', 'reviewers'))
  await act(async () => pickItem('3 个模型'))
  expect(toast.success).toHaveBeenCalledWith('已保存')
  expect(text()).not.toContain('审核配置写不进去')
})

it('SC-045 审核配置没了或坏了且写不进去：顶卡下红字说明 dev 暂时用默认规则加重试，重试成功后红字消失', async () => {
  const { api } = await show(undefined, rules({ exportOk: false, exportUsing: 'defaults' }))
  await rulesTab()
  const bad = document.querySelector('[data-rules="export-error"]')
  expect(bad?.textContent).toContain('审核配置写不进去，dev 暂时用默认规则；检查配置目录的权限后重试')
  expect(bad.classList.contains('bad')).toBe(true)
  await act(async () => fireEvent.click(within(bad).getByRole('button', { name: '重试' })))
  expect(api.modelsConfigRepublish).toHaveBeenCalledTimes(1)
  expect(document.querySelector('[data-rules="export-error"]')).toBeNull()
})

it('SC-045 红字在保存成功后立即消失：本页改规则、模型页签的保存都算；重试遇写入锁被占时红字不变并提示原因', async () => {
  const LOCK = { success: false, data: null, error: { code: 'LOCK_BUSY', message: '另一个 CodePal 正在写这份配置，关掉它后重试' } }
  const { api } = await show(undefined, rules({ exportOk: false, exportUsing: 'defaults' }), {
    modelsConfigRepublish: vi.fn(async () => LOCK),
  })
  await rulesTab()
  const bad = () => document.querySelector('[data-rules="export-error"]')
  await act(async () => fireEvent.click(within(bad()).getByRole('button', { name: '重试' })))
  expect(api.modelsConfigRepublish).toHaveBeenCalledTimes(1)
  expect(bad()?.textContent).toContain('dev 暂时用默认规则')
  expect(toast.error).toHaveBeenCalledWith('保存失败：另一个 CodePal 正在写这份配置，关掉它后重试')
  fireEvent.click(gateButton('lite.G1', 'reviewers'))
  await act(async () => pickItem('3 个模型'))
  expect(bad()).toBeNull()
  cleanup()
  document.querySelectorAll('.confirm-dialog-host').forEach((el) => el.remove())

  // 模型页签保存成功：切回审核规则页签时红字已经没了
  await show(undefined, rules({ exportOk: false, exportUsing: 'previous' }), {
    modelsRulesGet: vi.fn().mockResolvedValueOnce(ok(rules({ exportOk: false, exportUsing: 'previous' }))).mockReturnValue(new Promise(() => {})),
  })
  await act(async () => fireEvent.click(toggleOf('deepseek:deepseek-flash')))
  await rulesTab()
  expect(bad()).toBeNull()
})

it('SC-016 拖动中蓝线画在真正放下的位置：往下拖时在目标行之后，拖到最后只画一条', async () => {
  await show()
  // 第 1 行拖到第 2、3 行之间（纵坐标 70：其余行里只有第 2 行的中线在上方）
  drag('claude:opus', 70)
  await act(async () => {})
  let lines = enabledCard().querySelectorAll('.mh-drop')
  expect(lines).toHaveLength(1)
  expect(lines[0].nextElementSibling.getAttribute('data-hub-model')).toBe('deepseek:deepseek-flash')
  fireEvent.keyDown(document, { key: 'Escape' })
  await act(async () => {})
  drag('claude:opus', 500)
  await act(async () => {})
  lines = enabledCard().querySelectorAll('.mh-drop')
  expect(lines).toHaveLength(1)
  expect(lines[0].nextElementSibling).toBeNull()
  fireEvent.keyDown(document, { key: 'Escape' })
})

it('SC-046 各来源都正常：折叠条写没开的个数、默认收起；某家全开不画折叠条', async () => {
  const data = hub()
  data.vendors.find((v) => v.id === 'deepseek').models[0].enabled = true
  await show(data)
  expect(fold('Codex').textContent).toContain('7 个')
  expect(fold('Claude Code').textContent).toContain('3 个')
  expect(fold('MiMo API').textContent).toContain('1 个')
  expect(fold('DeepSeek')).toBeNull()
  expect(fold('MiniMax M Plan')).toBeNull()
  expect(fold('Codex')).toHaveAttribute('aria-expanded', 'false')
})

it('SC-047 新电脑什么都没有：空态、两家写没装、没有接入各家的折叠条、引导去模型接入', async () => {
  await show({
    providerConfigError: false,
    order: [],
    vendors: [
      { id: 'claude', name: 'Claude Code', color: 'var(--tool-claude)', blocked: 'notInstalled', models: [] },
      { id: 'codex', name: 'Codex', color: 'var(--tool-codex)', blocked: 'notInstalled', models: [] },
    ],
  })
  expect(text()).toContain('还没有打开的模型，审核会因为没有模型可用而停下')
  expect(text()).toContain('没装 Claude Code')
  expect(text()).toContain('没装 Codex')
  expect(screen.queryAllByRole('button', { name: /^展开 / })).toEqual([])
  expect(screen.getByRole('button', { name: '去模型接入' })).toBeTruthy()
  expect(text()).toContain('「模型接入」里的模型要先测通，才会出现在这里')
})

it('SC-048 模型接入的配置读不出：说明行红字，Claude、Codex 照常', async () => {
  const data = hub()
  data.providerConfigError = true
  data.vendors = data.vendors.filter((v) => ['claude', 'codex'].includes(v.id))
  data.order = ['claude:opus', 'codex:gpt-6.1-sol']
  await show(data)
  const foot = [...document.querySelectorAll('.mh-foot')].find((el) => el.textContent.includes('模型接入的配置读不出'))
  expect(foot?.textContent).toContain('模型接入的配置读不出，去模型接入处理')
  expect(foot.classList.contains('bad')).toBe(true)
  expect(enabledIds()).toEqual(['claude:opus', 'codex:gpt-6.1-sol'])
})

it('SC-049 来源异常：没装、没登录、读不到清单各写原因，被挡住的不在审核在用', async () => {
  for (const [vendor, blocked, label] of [
    ['claude', 'notInstalled', '没装 Claude Code'],
    ['claude', 'notLoggedIn', 'Claude Code 没登录'],
    ['codex', 'notInstalled', '没装 Codex'],
    ['codex', 'notLoggedIn', 'Codex 没登录'],
    ['codex', 'noModelList', '读不到 Codex 的模型清单，打开一次 Codex 后再来'],
  ]) {
    const data = hub()
    const v = data.vendors.find((item) => item.id === vendor)
    v.blocked = blocked
    v.models = []
    data.order = data.order.filter((id) => !id.startsWith(`${vendor}:`))
    await show(data)
    expect(text(), label).toContain(label)
    expect(enabledIds()).toEqual(data.order)
    expect(fold(v.name)).toBeNull()
    cleanup()
  }
})

it('SC-050 还留着上一份审核配置但更新不了：红字说明 dev 还在用上一次存下的规则，可重试', async () => {
  const { api } = await show(undefined, rules({ exportOk: false, exportUsing: 'previous' }))
  await rulesTab()
  const bad = document.querySelector('[data-rules="export-error"]')
  expect(bad?.textContent).toContain('审核配置写不进去，dev 还在用上一次存下的规则；检查配置目录的权限后重试')
  expect(bad.textContent).not.toContain('dev 暂时用默认规则')
  expect(bad.classList.contains('bad')).toBe(true)
  api.modelsConfigRepublish.mockImplementation(async () => ok({ exportOk: false }))
  await act(async () => fireEvent.click(within(bad).getByRole('button', { name: '重试' })))
  expect(document.querySelector('[data-rules="export-error"]')).not.toBeNull()
})
