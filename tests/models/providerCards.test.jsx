/**
 * 六张渠道卡的独立保存、自动测试和命令复制。
 * @module tests/models/providerCards.test
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { makeSandbox, CLI } from './helpers'
import ModelsPage from '../../src/features/models/ModelsPage'
import ModelHubPage from '../../src/features/modelHub/ModelHubPage'
vi.mock('../../src/components/Toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
const require = createRequire(import.meta.url)
const store = require('../../electron/modules/models/store.js')
const commands = require('../../electron/modules/models/commands.js')
const channels = [
  ['deepseek', 'DeepSeek', 'deepseek-flash'],
  ['mimo-api', 'MiMo API', 'mimo-v2.6-pro'],
  ['zhipu-api', '智谱 API', 'glm-5.3'],
  ['kimi-api', 'Kimi API', 'kimi-k3'],
  ['zhipu-coding', '智谱 Coding Plan', 'glm-5.3'],
  ['kimi-coding', 'Kimi Coding Plan', 'kimi-for-coding'],
  ['minimax-api', 'MiniMax API', 'MiniMax-M3'],
  ['minimax-plan', 'MiniMax M Plan', 'MiniMax-M3.1-Flash-Preview'],
]
const model = name => ({ id: name, name, effort: 'high', contextTokens: 1048576, maxOutputTokens: 32768, lastResult: null })
const card = name => within(screen.getByText(name).closest('section'))
async function mount(configured = false) {
  const providers = Object.fromEntries(channels.map(([id, , name]) => [id, { keySet: configured || id === 'deepseek', keyReadable: configured || id === 'deepseek', models: configured || id === 'deepseek' ? [{ ...model(name), lastResult: id === 'deepseek' ? { ok: true, at: '2026-09-28T00:00:00Z', source: 'test' } : null }] : [] }]))
  const api = {
    modelsList: vi.fn(async () => ({ success: true, data: { providers, claudeCode: { found: true, version: '2.1.283' }, commands: { installed: true, missing: [], missingEntries: [], onPath: true } } })),
    onModelsChanged: vi.fn(() => () => {}),
    modelsSetKey: vi.fn(async ({ providerId }) => ({ success: true, data: { provider: { keySet: true, keyReadable: true, models: [model(channels.find(c => c[0] === providerId)[2])] } } })),
    modelsTest: vi.fn(async () => ({ success: true, data: { lastResult: { ok: true, at: '2026-09-28T00:00:00Z', source: 'test' } } })),
  }
  window.electronAPI = api
  render(<ModelsPage />)
  await waitFor(() => expect(document.querySelector('.np-sk')).toBeNull())
  return api
}
afterEach(() => { cleanup(); delete window.electronAPI; vi.clearAllMocks(); vi.unstubAllEnvs() })
describe('TC-004 CHANNEL_CARDS', () => {
  it('六卡按顺序显示，每张保存只测试自己的默认模型', async () => {
    const api = await mount()
    expect(document.querySelectorAll('.mj-page section.np-card'), 'CHANNEL_CARDS').toHaveLength(8)
    const titles = [...document.querySelectorAll('.np-card-title')].map(n => n.childNodes[1].textContent)
    expect(titles).toEqual(channels.map(c => c[1]))
    for (const [id, name, defaultModel] of channels.slice(1)) {
      fireEvent.click(card(name).getByRole('button', { name: '填写 Key' }))
      const key = id === 'mimo-api' ? 'sk-fixture-card' : `fixture.${id}`
      fireEvent.change(screen.getByPlaceholderText('粘贴 Key'), { target: { value: key } })
      fireEvent.click(screen.getByRole('button', { name: '保存' }))
      await waitFor(() => expect(api.modelsSetKey).toHaveBeenLastCalledWith({ providerId: id, key }))
      await waitFor(() => expect(api.modelsTest).toHaveBeenLastCalledWith({ providerId: id, modelId: defaultModel }))
      await waitFor(() => expect(screen.queryByPlaceholderText('粘贴 Key')).toBeNull())
      expect(card(name).getByTitle(defaultModel)).toBeInTheDocument()
      expect(card('DeepSeek').getByText('可用')).toBeInTheDocument()
    }
    expect(api.modelsSetKey).toHaveBeenCalledTimes(7)
    expect(api.modelsTest).toHaveBeenCalledTimes(7)
  })
  it('复制的命令与真实安装文件一致，两个 glm-5.3 不串渠道', async () => {
    await mount(true)
    expect(document.querySelectorAll('.mj-page section.np-card'), 'CHANNEL_CARDS').toHaveLength(8)
    const sb = makeSandbox()
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    try {
      for (const [k, v] of Object.entries(sb.env)) vi.stubEnv(k, v)
      for (const [id] of channels) store.setKey(id, 'sk-fixture-card')
      commands.installCommands({ appExecPath: process.execPath, cliPath: CLI })
      for (const [id, name, defaultModel] of channels) {
        fireEvent.click(card(name).getByTitle(defaultModel))
        fireEvent.click(card(name).getByRole('button', { name: '复制命令' }))
        const expected = id === 'deepseek' ? `codepal-${defaultModel}` : `codepal-${id}--${defaultModel}`
        await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(expected))
        expect(fs.readFileSync(path.join(sb.bin, expected), 'utf8')).toContain(`launch ${id} ${defaultModel}`)
      }
    } finally { sb.cleanup() }
  })
  it('MiMo 拒绝错误前缀；无固定前缀渠道仍拒绝控制字符', async () => {
    const api = await mount()
    expect(document.querySelectorAll('.mj-page section.np-card'), 'CHANNEL_CARDS').toHaveLength(8)
    fireEvent.click(card('MiMo API').getByRole('button', { name: '填写 Key' }))
    fireEvent.change(screen.getByPlaceholderText('粘贴 Key'), { target: { value: 'wrong-prefix' } })
    fireEvent.keyDown(screen.getByPlaceholderText('粘贴 Key'), { key: 'Enter' })
    expect(screen.getByText('MiMo API 的 Key 以 sk- 开头')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    fireEvent.click(card('智谱 API').getByRole('button', { name: '填写 Key' }))
    fireEvent.change(screen.getByPlaceholderText('粘贴 Key'), { target: { value: 'fixture\tinvalid' } })
    fireEvent.keyDown(screen.getByPlaceholderText('粘贴 Key'), { key: 'Enter' })
    expect(screen.getByText('Key 格式不对')).toBeInTheDocument()
    expect(api.modelsSetKey).not.toHaveBeenCalled()
  })
})


it('TC-002 MINIMAX_TC_002 MiniMax empty cards reuse Key UI with no fabricated availability', async () => {
  const api = await mount()
  expect(screen.queryByText('MiniMax API'), 'MINIMAX_TC_002').toBeInTheDocument()
  for (const name of ['MiniMax API','MiniMax M Plan']) {
    expect(card(name).getByRole('button', {name:'填写 Key'})).toBeInTheDocument()
    expect(card(name).queryByText('可用')).toBeNull()
    expect(card(name).queryByRole('button', {name:'测一下'})).toBeNull()
  }
  expect(api.modelsSetKey).not.toHaveBeenCalled()
  expect(api.modelsTest).not.toHaveBeenCalled()
})

it('TC-016 MINIMAX_TC_016 original six cards and MiniMax hub controls retain existing UI', async () => {
  await mount(true)
  expect(document.querySelectorAll('.mj-page section.np-card'), 'MINIMAX_TC_016').toHaveLength(8)
  expect([...document.querySelectorAll('.np-card-title')].map(n=>n.childNodes[1].textContent)).toEqual(channels.map(c=>c[1]))
  cleanup()
  const levels = ['low','medium','high','xhigh','max']
  const api = {
    modelsHubList:vi.fn(async()=>({success:true,data:{providerConfigError:false,vendors:[
      {id:'minimax-api',name:'MiniMax API',color:'var(--ic-orange)',blocked:null,models:[{id:'minimax-api:MiniMax-M3',displayName:'MiniMax-M3',efforts:[],effort:null,enabled:true}]},
      {id:'minimax-plan',name:'MiniMax M Plan',color:'var(--ic-orange)',blocked:null,models:[{id:'minimax-plan:MiniMax-M3.1-Flash-Preview',displayName:'MiniMax-M3.1-Flash-Preview',efforts:levels,effort:'max',enabled:true}]},
    ]}})),
    modelsHubSetEffort:vi.fn(async()=>({success:true})),
    modelsHubSetEnabled:vi.fn(async()=>({success:true})),
  }
  window.electronAPI=api
  render(<ModelHubPage />)
  await screen.findByText('MiniMax-M3')
  expect(screen.queryByRole('button',{name:'MiniMax-M3 思考强度'})).toBeNull()
  expect(screen.queryByText('默认')).toBeNull()
  const button = screen.getByRole('button',{name:'MiniMax-M3.1-Flash-Preview 思考强度'})
  expect(button).toHaveTextContent('max')
  fireEvent.click(button)
  expect(screen.getAllByRole('menuitemradio').map(n=>n.getAttribute('aria-label'))).toEqual(levels)
  fireEvent.click(screen.getByRole('menuitemradio',{name:'medium'}))
  await waitFor(()=>expect(api.modelsHubSetEffort).toHaveBeenCalledWith({id:'minimax-plan:MiniMax-M3.1-Flash-Preview',effort:'medium'}))
})
