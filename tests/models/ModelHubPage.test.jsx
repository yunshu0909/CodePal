/** Signed model hub interactions; absent new page falls back to the real old page for behavioral RED. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'
vi.mock('../../src/components/Toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
  default: () => null,
  resetToastForTests: vi.fn(),
}))
const { toast } = await import('../../src/components/Toast')
const pages = import.meta.glob('../../src/features/modelHub/ModelHubPage.jsx')
const Page = pages['../../src/features/modelHub/ModelHubPage.jsx']
  ? (await pages['../../src/features/modelHub/ModelHubPage.jsx']()).default
  : (await import('../../src/features/models/ModelsPage.jsx')).default
const levels = ['low', 'medium', 'high', 'xhigh', 'max']
const makeModel = (
  vendor,
  slug,
  displayName,
  enabled = false,
  efforts = levels,
  effort = 'high',
) => ({ id: `${vendor}:${slug}`, displayName, enabled, efforts, effort })
const base = () => ({
  providerConfigError: false,
  vendors: [
    {
      id: 'claude',
      name: 'Claude Code',
      color: 'var(--tool-claude)',
      blocked: null,
      models: [
        makeModel('claude', 'fable', 'Fable 5.1'),
        makeModel('claude', 'opus', 'Opus 5.5', true),
        makeModel('claude', 'sonnet', 'Sonnet 5.5'),
        makeModel('claude', 'haiku', 'Haiku 4.5'),
      ],
    },
    {
      id: 'codex',
      name: 'Codex',
      color: 'var(--tool-codex)',
      blocked: null,
      models: [
        makeModel('codex', 'gpt-6-astra', 'GPT-6-Astra', true, [
          ...levels,
          'ultra',
        ]),
        ...Array.from({ length: 7 }, (_, i) =>
          makeModel('codex', `other-${i}`, `Codex model ${i}`, false, [
            ...levels,
            'ultra',
          ]),
        ),
      ],
    },
    {
      id: 'deepseek',
      name: 'DeepSeek',
      color: 'var(--ic-blue)',
      blocked: null,
      models: [
        makeModel(
          'deepseek',
          'deepseek-flash',
          'deepseek-flash',
          true,
          ['low', 'high', 'max'],
          'max',
        ),
      ],
    },
    {
      id: 'mimo-api',
      name: 'MiMo API',
      color: 'var(--ic-orange)',
      blocked: null,
      models: [
        makeModel('mimo-api', 'mimo-v2.6-pro', 'mimo-v2.6-pro', false, [
          'high',
        ]),
      ],
    },
    {
      id: 'zhipu-api',
      name: '智谱 API',
      color: 'var(--ic-green)',
      blocked: null,
      models: [
        makeModel('zhipu-api', 'glm-5.3', 'glm-5.3', false, [
          'low',
          'high',
          'max',
        ]),
        makeModel('zhipu-api', 'glm-other', 'glm-other', false, [
          'low',
          'high',
          'max',
        ]),
      ],
    },
  ],
})
const empty = () => {
  const data = base()
  data.vendors.forEach((v) =>
    v.models.forEach((m) => {
      m.enabled = false
    }),
  )
  return data
}
const blocked = () => ({
  providerConfigError: false,
  vendors: [
    {
      id: 'claude',
      name: 'Claude Code',
      color: 'var(--tool-claude)',
      blocked: 'notInstalled',
      models: [],
    },
    {
      id: 'codex',
      name: 'Codex',
      color: 'var(--tool-codex)',
      blocked: 'notInstalled',
      models: [],
    },
  ],
})
const success = (data) => ({ success: true, data, error: null })
const failure = () => ({
  success: false,
  data: null,
  error: {
    code: 'write_denied',
    message: '配置目录没有写入权限，检查权限后重试',
  },
})
const deferred = () => {
  let resolve
  const promise = new Promise((r) => {
    resolve = r
  })
  return { promise, resolve }
}
function apiFor(data, overrides = {}) {
  return {
    modelsHubList: vi.fn(async () => success(structuredClone(data))),
    modelsHubSetEnabled: vi.fn(async (payload) => success(payload)),
    modelsHubSetEffort: vi.fn(async (payload) => success(payload)),
    // Real old page has an ordinary, valid provider response during RED; no missing import failure.
    modelsList: vi.fn(async () =>
      success({
        claudeCode: { found: true },
        commands: { installed: true, missing: [], onPath: true },
        providers: {
          deepseek: {
            keySet: true,
            keyReadable: true,
            models: [
              {
                id: 'deepseek-flash',
                name: 'deepseek-flash',
                effort: 'max',
                contextTokens: 1000000,
                maxOutputTokens: 128000,
                lastResult: { ok: true, at: '2026-10-03T12:00:00Z' },
              },
            ],
          },
        },
      }),
    ),
    onModelsChanged: vi.fn(() => () => {}),
    ...overrides,
  }
}
async function show(data = base(), overrides = {}, props = {}) {
  const api = apiFor(data, overrides)
  window.electronAPI = api
  const view = render(<Page {...props} />)
  await act(async () => {})
  return { api, ...view }
}
const enabledCard = () => document.querySelector('[data-hub-section="enabled"]')
const remainingCard = () =>
  document.querySelector('[data-hub-section="remaining"]')
const row = (id) => document.querySelector(`[data-hub-model="${id}"]`)
const fold = (name) =>
  screen.queryByRole('button', { name: `展开 ${name}` }) ||
  screen.queryByRole('button', { name: `收起 ${name}` })
const toggle = (id) => {
  const el = row(id)
  expect(el).not.toBeNull()
  return within(el).getByRole('switch')
}
const effort = (id) => {
  const el = row(id)
  expect(el).not.toBeNull()
  return within(el).getByRole('button', { name: /思考强度/ })
}
function expand(name) {
  const el = fold(name)
  expect(el).not.toBeNull()
  fireEvent.click(el)
}
function assertLocation(id, section) {
  expect(row(id)).not.toBeNull()
  expect(row(id).closest('[data-hub-section]')).toHaveAttribute(
    'data-hub-section',
    section,
  )
}
async function pick(id, value) {
  fireEvent.click(effort(id))
  const menu = screen.queryByRole('menu')
  expect(menu).not.toBeNull()
  fireEvent.click(within(menu).getByRole('menuitemradio', { name: value }))
}
beforeEach(() => vi.clearAllMocks())
afterEach(() => {
  cleanup()
  delete window.electronAPI
})
it('SC-001 TC-050 固定排序、三行、两卡与真实导航契约；再次进入静默重读', async () => {
  const { api, unmount } = await show()
  expect(enabledCard()).not.toBeNull()
  expect(
    [...enabledCard().querySelectorAll('[data-hub-model]')].map(
      (e) => e.dataset.hubModel,
    ),
  ).toEqual(['claude:opus', 'codex:gpt-6-astra', 'deepseek:deepseek-flash'])
  expect(
    within(screen.getByText('审核在用').closest('.np-glabel')).getByText(
      '3 个',
    ),
  ).toBeInTheDocument()
  expect(screen.getByText('审核在用')).toBeInTheDocument()
  expect(screen.getByText('其余模型')).toBeInTheDocument()
  expect(fold('Claude Code')).toHaveAttribute('aria-expanded', 'false')
  expect(screen.queryByText('Fable 5.1')).toBeNull()
  expect(
    document.querySelector('.page-shell--native .np-scroll'),
  ).not.toBeNull()
  const root = path.resolve(__dirname, '../..')
  const app = fs.readFileSync(path.join(root, 'src/App.jsx'), 'utf8')
  expect(app).toMatch(/VALID_ACTIVE_MODULES[^\n]*['"]modelHub['"]/)
  expect(app).toMatch(/activeModule === ['"]modelHub['"]/)
  const nav = fs.readFileSync(
    path.join(root, 'src/components/WorkbenchLayout.jsx'),
    'utf8',
  )
  expect(nav).toMatch(
    /id: 'models'[^}]*\},\s*\{ id: 'modelHub', label: '模型汇总', macOnly: true/,
  )
  expect(nav).toMatch(/macOnly/)
  const preload = fs.readFileSync(
    path.join(root, 'electron/preload.js'),
    'utf8',
  )
  for (const action of ['List', 'SetEnabled', 'SetEffort'])
    expect(preload).toContain(`modelsHub${action}`)
  expand('Claude Code')
  unmount()
  const pending = deferred()
  api.modelsHubList.mockReturnValueOnce(pending.promise)
  render(<Page />)
  expect(row('claude:opus')).not.toBeNull()
  expect(document.querySelector('.np-sk')).toBeNull()
  expect(fold('Claude Code')).toHaveAttribute('aria-expanded', 'false')
  const next = base()
  next.vendors[0].models[1].displayName = 'Opus refreshed'
  await act(async () => pending.resolve(success(next)))
  expect(screen.getByText('Opus refreshed')).toBeInTheDocument()
  expect(api.modelsHubList).toHaveBeenCalledTimes(2)
})
it('SC-002 TC-051 首次读取只显示3+5行骨架', async () => {
  await show(base(), { modelsHubList: vi.fn(() => new Promise(() => {})) })
  expect(
    document.querySelectorAll('[data-hub-section] .mh-skeleton-row'),
  ).toHaveLength(8)
  expect(screen.queryByText('Opus 5.5')).toBeNull()
  expect(screen.queryByText('加载中...')).toBeNull()
})
it('SC-003 TC-052 合法全关显示原文空态且省略零计数', async () => {
  await show(empty())
  expect(
    screen.queryByText('还没有打开的模型，审核会因为没有模型可用而停下'),
  ).not.toBeNull()
  expect(screen.queryByText('0 个')).toBeNull()
  expect(fold('DeepSeek')).not.toBeNull()
})
it('SC-004 TC-053 坏hub整块失败；重试回骨架后恢复', async () => {
  const wait = deferred()
  const list = vi
    .fn()
    .mockResolvedValueOnce({
      success: false,
      error: { code: 'HUB_FILE_INVALID' },
    })
    .mockReturnValueOnce(wait.promise)
  await show(base(), { modelsHubList: list })
  expect(
    screen.queryByText('模型汇总的设置文件无法解析，修好或删除它后重试'),
  ).not.toBeNull()
  expect(screen.getByRole('alert')).toBeInTheDocument()
  expect(enabledCard()).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  expect(document.querySelector('.np-sk')).not.toBeNull()
  await act(async () => wait.resolve(success(base())))
  expect(row('claude:opus')).not.toBeNull()
})
it('SC-005 TC-054 打开移到固定位置、正确计数与Toast', async () => {
  const { api } = await show()
  expand('Claude Code')
  fireEvent.click(toggle('claude:fable'))
  await waitFor(() =>
    expect(toast.success).toHaveBeenCalledWith('Fable 5.1 已用于审核'),
  )
  assertLocation('claude:fable', 'enabled')
  expect(
    [...enabledCard().querySelectorAll('[data-hub-model]')]
      .slice(0, 2)
      .map((e) => e.dataset.hubModel),
  ).toEqual(['claude:fable', 'claude:opus'])
  expect(screen.getByText('4 个')).toBeInTheDocument()
  expect(api.modelsHubSetEnabled).toHaveBeenCalledWith({
    id: 'claude:fable',
    enabled: true,
  })
})
it('SC-006 TC-055 开启等待拨到目标值、禁用、原行不移动', async () => {
  const wait = deferred()
  await show(base(), { modelsHubSetEnabled: vi.fn(() => wait.promise) })
  expand('Claude Code')
  fireEvent.click(toggle('claude:fable'))
  expect(toggle('claude:fable')).toHaveAttribute('aria-checked', 'true')
  expect(toggle('claude:fable')).toHaveAttribute('aria-disabled', 'true')
  assertLocation('claude:fable', 'remaining')
  await act(async () =>
    wait.resolve(success({ id: 'claude:fable', enabled: true })),
  )
  assertLocation('claude:fable', 'enabled')
})
it('SC-007 TC-056 开启失败控件与行位置恢复', async () => {
  await show(base(), { modelsHubSetEnabled: vi.fn(async () => failure()) })
  expand('Claude Code')
  fireEvent.click(toggle('claude:fable'))
  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith(
      '保存失败：配置目录没有写入权限，检查权限后重试',
    ),
  )
  expect(toggle('claude:fable')).toHaveAttribute('aria-checked', 'false')
  assertLocation('claude:fable', 'remaining')
})
it('SC-008 TC-057 开启中重复点击与键盘只提交一次', async () => {
  const wait = deferred()
  const { api } = await show(base(), {
    modelsHubSetEnabled: vi.fn(() => wait.promise),
  })
  expand('Claude Code')
  const control = toggle('claude:fable')
  fireEvent.click(control)
  fireEvent.click(control)
  fireEvent.keyDown(control, { key: ' ' })
  fireEvent.keyDown(control, { key: 'Enter' })
  expect(api.modelsHubSetEnabled).toHaveBeenCalledTimes(1)
  await act(async () =>
    wait.resolve(success({ id: 'claude:fable', enabled: true })),
  )
})
it('SC-009 TC-058 关闭回对应折叠区域；不按点击顺序', async () => {
  await show()
  fireEvent.click(toggle('codex:gpt-6-astra'))
  await waitFor(() =>
    expect(toast.success).toHaveBeenCalledWith('GPT-6-Astra 不再用于审核'),
  )
  expect(row('codex:gpt-6-astra')).toBeNull()
  expand('Codex')
  assertLocation('codex:gpt-6-astra', 'remaining')
  expect(toggle('codex:gpt-6-astra')).toHaveAttribute('aria-checked', 'false')
})
it('SC-010 TC-059 关闭等待留在在用卡、目标关闭且禁用', async () => {
  const wait = deferred()
  await show(base(), { modelsHubSetEnabled: vi.fn(() => wait.promise) })
  fireEvent.click(toggle('codex:gpt-6-astra'))
  expect(toggle('codex:gpt-6-astra')).toHaveAttribute('aria-checked', 'false')
  expect(toggle('codex:gpt-6-astra')).toHaveAttribute('aria-disabled', 'true')
  assertLocation('codex:gpt-6-astra', 'enabled')
  await act(async () =>
    wait.resolve(success({ id: 'codex:gpt-6-astra', enabled: false })),
  )
})
it('SC-011 TC-060 关闭最后一个显示空态并恢复收起的来源', async () => {
  const data = empty()
  data.vendors[2].models[0].enabled = true
  await show(data)
  expect(fold('DeepSeek')).toBeNull()
  fireEvent.click(toggle('deepseek:deepseek-flash'))
  await waitFor(() =>
    expect(
      screen.queryByText('还没有打开的模型，审核会因为没有模型可用而停下'),
    ).not.toBeNull(),
  )
  expect(fold('DeepSeek')).toHaveAttribute('aria-expanded', 'false')
  expect(toast.success).toHaveBeenCalledWith('deepseek-flash 不再用于审核')
})
it('SC-012 TC-061 关闭失败恢复开启且不移行', async () => {
  await show(base(), { modelsHubSetEnabled: vi.fn(async () => failure()) })
  fireEvent.click(toggle('codex:gpt-6-astra'))
  await waitFor(() => expect(toast.error).toHaveBeenCalled())
  expect(toggle('codex:gpt-6-astra')).toHaveAttribute('aria-checked', 'true')
  assertLocation('codex:gpt-6-astra', 'enabled')
})
it('SC-013 TC-062 关闭中防重复提交', async () => {
  const wait = deferred()
  const { api } = await show(base(), {
    modelsHubSetEnabled: vi.fn(() => wait.promise),
  })
  const control = toggle('codex:gpt-6-astra')
  fireEvent.click(control)
  fireEvent.click(control)
  expect(api.modelsHubSetEnabled).toHaveBeenCalledTimes(1)
  await act(async () =>
    wait.resolve(success({ id: 'codex:gpt-6-astra', enabled: false })),
  )
})
it('SC-014 TC-063 档位与勾选来自模型真实支持；开关、折叠、菜单可键盘操作', async () => {
  const { api } = await show()
  const button = effort('codex:gpt-6-astra')
  expect(button).toHaveTextContent('high')
  fireEvent.click(button)
  expect(
    screen
      .getAllByRole('menuitemradio')
      .map((e) => e.textContent.replace('✓', '').trim()),
  ).toEqual([...levels, 'ultra'])
  expect(
    screen.getByRole('menuitemradio', { name: /high/, checked: true }),
  ).toHaveTextContent('high')
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('menu')).toBeNull()
  fireEvent.click(effort('deepseek:deepseek-flash'))
  expect(
    screen
      .getAllByRole('menuitemradio')
      .map((e) => e.textContent.replace('✓', '').trim()),
  ).toEqual(['low', 'high', 'max'])
  fireEvent.keyDown(document, { key: 'Escape' })
  const control = toggle('claude:opus')
  expect(control).toHaveAttribute('tabindex', '0')
  fireEvent.keyDown(control, { key: ' ' })
  await waitFor(() =>
    expect(api.modelsHubSetEnabled).toHaveBeenCalledWith({
      id: 'claude:opus',
      enabled: false,
    }),
  )
  const group = fold('Claude Code')
  expect(group).toHaveAttribute('tabindex', '0')
  fireEvent.keyDown(group, { key: 'Enter' })
  expect(fold('Claude Code')).toHaveAttribute('aria-expanded', 'true')
})
it('SC-015 TC-064 Esc、外部点击与当前档均不写', async () => {
  const { api } = await show()
  fireEvent.click(effort('codex:gpt-6-astra'))
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('menu')).toBeNull()
  fireEvent.click(effort('codex:gpt-6-astra'))
  fireEvent.pointerDown(document.body)
  expect(screen.queryByRole('menu')).toBeNull()
  await pick('codex:gpt-6-astra', 'high')
  expect(api.modelsHubSetEffort).not.toHaveBeenCalled()
  expect(effort('codex:gpt-6-astra')).toHaveTextContent('high')
})
it('SC-016 TC-065 去接入并返回重读，新测通的保持关闭', async () => {
  const navigate = vi.fn()
  const { api, unmount } = await show(base(), {}, { onNavigate: navigate })
  const link = screen.queryByRole('button', { name: '去模型接入' })
  expect(link).not.toBeNull()
  fireEvent.click(link)
  expect(navigate).toHaveBeenCalledWith('models')
  unmount()
  const next = base()
  next.vendors[2].models.push(
    makeModel(
      'deepseek',
      'new-tested',
      'new-tested',
      false,
      ['low', 'high', 'max'],
      'high',
    ),
  )
  api.modelsHubList.mockResolvedValue(success(next))
  render(<Page onNavigate={navigate} />)
  await act(async () => {})
  expand('DeepSeek')
  expect(toggle('deepseek:new-tested')).toHaveAttribute('aria-checked', 'false')
})
it('SC-018 TC-067 接入配置坏了只降级第三方来源', async () => {
  const data = base()
  data.providerConfigError = true
  data.vendors = data.vendors.slice(0, 2)
  await show(data)
  expect(
    screen.queryByText('模型接入的配置读不出，去模型接入处理'),
  ).not.toBeNull()
  expect(row('claude:opus')).not.toBeNull()
  expect(row('codex:gpt-6-astra')).not.toBeNull()
  expect(screen.getByRole('button', { name: '去模型接入' })).toBeInTheDocument()
  expect(screen.queryByRole('alert')).toBeNull()
})
it('SC-019 TC-068 整行折叠不分页，重进清空展开，不自动滚动', async () => {
  const { api, unmount } = await show()
  const scroll = document.querySelector('.np-scroll')
  expect(fold('Codex')).not.toBeNull()
  scroll.scrollTop = 19
  fireEvent.click(fold('Codex'))
  expect(scroll.scrollTop).toBe(19)
  expect(remainingCard().querySelectorAll('[data-hub-model]')).toHaveLength(7)
  fireEvent.click(fold('Codex'))
  expect(remainingCard().querySelectorAll('[data-hub-model]')).toHaveLength(0)
  expand('Claude Code')
  unmount()
  render(<Page />)
  await act(async () => {})
  expect(fold('Claude Code')).toHaveAttribute('aria-expanded', 'false')
  expect(api.modelsHubList).toHaveBeenCalledTimes(2)
})
it('SC-020 TC-069 所有来源全开省略整个其余卡及零计数', async () => {
  const data = base()
  data.vendors.forEach((v) =>
    v.models.forEach((m) => {
      m.enabled = true
    }),
  )
  await show(data)
  expect(enabledCard()).not.toBeNull()
  expect(remainingCard()).toBeNull()
  expect(screen.queryByText('0 个')).toBeNull()
  expect(screen.queryByRole('button', { name: /展开/ })).toBeNull()
  expect(screen.getByRole('button', { name: '去模型接入' })).toBeInTheDocument()
})
it('SC-021 TC-070 长名完整标题，真实页面整页滚动规则；控件不换行', async () => {
  const data = base()
  const name = 'very-long-model-name-'.repeat(8)
  data.vendors[1].models[0].displayName = name
  await show(data)
  expect(screen.queryByTitle(name)).not.toBeNull()
  const item = row('codex:gpt-6-astra')
  expect(within(item).getByRole('switch')).toBeInTheDocument()
  const css = fs.readFileSync(
    path.resolve(__dirname, '../../src/features/modelHub/modelHub.css'),
    'utf8',
  )
  expect(css).toMatch(/text-overflow:\s*ellipsis/)
  expect(css).toMatch(/white-space:\s*nowrap/)
  expect(
    document.querySelector('.page-shell--native .np-scroll'),
  ).not.toBeNull()
})
it('SC-022 TC-071 后续新模型保持关闭，静默重读且不重置已有选择', async () => {
  const { api, unmount } = await show()
  const next = base()
  next.vendors[1].models.push(makeModel('codex', 'new-model', 'New Codex'))
  api.modelsHubList.mockResolvedValue(success(next))
  unmount()
  render(<Page />)
  await act(async () => {})
  expect(fold('Codex')).not.toBeNull()
  expand('Codex')
  expect(toggle('codex:new-model')).toHaveAttribute('aria-checked', 'false')
  expect(toggle('codex:gpt-6-astra')).toHaveAttribute('aria-checked', 'true')
})
it('SC-023 TC-072 新电脑同时空态、两条橙点、无开关箭头', async () => {
  await show(blocked())
  expect(
    screen.queryByText('还没有打开的模型，审核会因为没有模型可用而停下'),
  ).not.toBeNull()
  expect(screen.getByText('没装 Claude Code')).toBeInTheDocument()
  expect(screen.getByText('没装 Codex')).toBeInTheDocument()
  expect(document.querySelectorAll('.np-st.warn')).toHaveLength(2)
  expect(screen.queryByRole('switch')).toBeNull()
  expect(document.querySelector('.np-disc')).toBeNull()
})
it.each([
  ['claude', 'notInstalled', '没装 Claude Code'],
  ['claude', 'notLoggedIn', 'Claude Code 没登录'],
  ['codex', 'notInstalled', '没装 Codex'],
  ['codex', 'notLoggedIn', 'Codex 没登录'],
  ['codex', 'noModelList', '读不到 Codex 的模型清单，打开一次 Codex 后再来'],
])(
  'SC-024 TC-073 %s %s 局部挡住不含箭头、模型或可点开关',
  async (id, reason, text) => {
    const data = base()
    const vendor = data.vendors.find((v) => v.id === id)
    vendor.blocked = reason
    vendor.models = []
    await show(data)
    expect(screen.queryByText(text)).not.toBeNull()
    expect(fold(vendor.name)).toBeNull()
    const blockedRow = screen.getByText(text).closest('.np-row')
    expect(blockedRow.querySelector('.np-disc')).toBeNull()
    expect(within(blockedRow).queryByRole('switch')).toBeNull()
    expect(
      row(id === 'claude' ? 'claude:opus' : 'codex:gpt-6-astra'),
    ).toBeNull()
  },
)
it.each(['claude', 'codex', 'deepseek'])(
  'SC-025 TC-074 仅%s；订阅一家提示，第三方单家不提示',
  async (id) => {
    const data = empty()
    const vendor = data.vendors.find((v) => v.id === id)
    vendor.models[0].enabled = true
    await show(data)
    expect(enabledCard()).not.toBeNull()
    const copy =
      id === 'codex'
        ? '只开了 Codex：用 Codex 写代码时，没有别家模型来审'
        : '只开了 Claude：用 Claude Code 写代码时，没有别家模型来审'
    if (id === 'deepseek')
      expect(document.querySelector('.mh-foot.warn')).toBeNull()
    else expect(screen.getByText(copy)).toBeInTheDocument()
  },
)
it('SC-026 TC-075 强度成功后显示新值及Toast；第三方用原值', async () => {
  const { api } = await show()
  expect(effort('deepseek:deepseek-flash')).toHaveTextContent('max')
  await pick('codex:gpt-6-astra', 'xhigh')
  await waitFor(() =>
    expect(effort('codex:gpt-6-astra')).toHaveTextContent('xhigh'),
  )
  expect(api.modelsHubSetEffort).toHaveBeenCalledWith({
    id: 'codex:gpt-6-astra',
    effort: 'xhigh',
  })
  expect(toast.success).toHaveBeenCalledWith('已保存')
})
it('SC-027 TC-076 强度等待不提前显示新值、关闭菜单并禁用', async () => {
  const wait = deferred()
  await show(base(), { modelsHubSetEffort: vi.fn(() => wait.promise) })
  await pick('codex:gpt-6-astra', 'xhigh')
  expect(effort('codex:gpt-6-astra')).toBeDisabled()
  expect(effort('codex:gpt-6-astra')).toHaveTextContent('high')
  expect(screen.queryByRole('menu')).toBeNull()
  await act(async () =>
    wait.resolve(success({ id: 'codex:gpt-6-astra', effort: 'xhigh' })),
  )
})
it('SC-028 TC-077 强度失败保留原值并显示原文错误', async () => {
  await show(base(), { modelsHubSetEffort: vi.fn(async () => failure()) })
  await pick('codex:gpt-6-astra', 'xhigh')
  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith(
      '保存失败：配置目录没有写入权限，检查权限后重试',
    ),
  )
  expect(effort('codex:gpt-6-astra')).toHaveTextContent('high')
  expect(effort('codex:gpt-6-astra')).not.toBeDisabled()
})
it('SC-029 TC-078 强度中重复操作不重开菜单、不再提交', async () => {
  const wait = deferred()
  const { api } = await show(base(), {
    modelsHubSetEffort: vi.fn(() => wait.promise),
  })
  await pick('codex:gpt-6-astra', 'xhigh')
  fireEvent.click(effort('codex:gpt-6-astra'))
  expect(screen.queryByRole('menu')).toBeNull()
  expect(api.modelsHubSetEffort).toHaveBeenCalledTimes(1)
  await act(async () =>
    wait.resolve(success({ id: 'codex:gpt-6-astra', effort: 'xhigh' })),
  )
})

it.each(['claude', 'codex'])(
  'SC-025 另一家被挡住不计入在用家数：仅%s仍提示',
  async (id) => {
    const data = base()
    const other = data.vendors.find(
      (vendor) => vendor.id === (id === 'claude' ? 'codex' : 'claude'),
    )
    other.blocked = 'notLoggedIn'
    for (const vendor of data.vendors) {
      if (vendor.id !== id && vendor !== other) {
        vendor.models.forEach((model) => {
          model.enabled = false
        })
      }
    }
    // Even a stale enabled flag on a blocked source cannot suppress the warning.
    await show(data)
    expect(enabledCard()).not.toBeNull()
    expect(
      screen.getByText(
        id === 'claude'
          ? '只开了 Claude：用 Claude Code 写代码时，没有别家模型来审'
          : '只开了 Codex：用 Codex 写代码时，没有别家模型来审',
      ),
    ).toBeInTheDocument()
    expect(
      [...enabledCard().querySelectorAll('[data-hub-model]')].every((row) =>
        row.dataset.hubModel.startsWith(`${id}:`),
      ),
    ).toBe(true)
  },
)

it('SC-017 没有测通的第三方来源不画折叠条，保留灰字说明与去接入', async () => {
  const data = base()
  data.vendors = data.vendors.slice(0, 2)
  await show(data)
  expect(enabledCard()).not.toBeNull()
  expect(fold('DeepSeek')).toBeNull()
  expect(
    screen.getByText('「模型接入」里的模型要先测通，才会出现在这里'),
  ).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '去模型接入' })).toBeInTheDocument()
})
