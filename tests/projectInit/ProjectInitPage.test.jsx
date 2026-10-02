/**
 * 新建项目页（#59，specs/v2.1.6-新建项目 TC-015〜022、TC-027、TC-028）
 *
 * 负责：对照定稿包 specs/v2.1.5-设计-新建项目/新建项目-定稿/（状态目录 W1–W11、状态清单 A/C/E/F）
 * - 打开页面、切 Git、实时校验、创建成功 / 没做初始提交 / 失败、没装 Git、键盘、浏览、动作行优先级
 * 主进程接口全部用替身（window.electronAPI），不真的建项目。
 *
 * @module tests/projectInit/ProjectInitPage
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'
import * as ToastModule from '../../src/components/Toast'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

let Page = null
async function renderPage(token) {
  const mod = await import('../../src/pages/ProjectInitPage').catch(() => null)
  Page = mod && mod.default
  expect(Page, token).toBeTruthy()
  return render(<Page />)
}

let api
function mockApi(overrides = {}) {
  api = {
    checkGitAvailable: vi.fn(async () => ({ success: true, data: { available: true } })),
    validateProjectInit: vi.fn(async () => ({ success: true, valid: true, data: { errors: [] } })),
    executeProjectInit: vi.fn(async () => ({ success: true, data: { projectPath: '/tmp/projects/my-app', commit: 'done' } })),
    selectFolder: vi.fn(async () => ({ success: true, canceled: false, path: '/tmp/picked' })),
    ...overrides,
  }
  window.electronAPI = api
}

let toastSpy
beforeEach(() => {
  mockApi()
  toastSpy = {
    success: vi.spyOn(ToastModule.toast, 'success').mockImplementation(() => {}),
    error: vi.spyOn(ToastModule.toast, 'error').mockImplementation(() => {}),
  }
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async () => {}) } })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  delete window.electronAPI
})

const nameInput = () => screen.getByTestId('pi-name')
const createButton = () => screen.getByRole('button', { name: /创建项目|创建中…/ })
const treeText = () => screen.getByTestId('pi-tree').textContent
const message = () => screen.queryByTestId('pi-message')?.textContent || ''

async function typeName(value) {
  fireEvent.change(nameInput(), { target: { value } })
  await waitFor(() => expect(api.validateProjectInit).toHaveBeenCalled())
}

describe('新建项目页', () => {
  it('TC-015 PAGE_INITIAL 打开页面：新样式外壳、没有勾选框、名称为空不能创建', async () => {
    const { container } = await renderPage('PAGE_INITIAL')
    expect(container.querySelector('.page-shell--native'), 'PAGE_INITIAL').toBeTruthy()
    expect(screen.getByText('新建项目'), 'PAGE_INITIAL').toBeTruthy()
    expect(container.querySelectorAll('input[type="checkbox"]').length, 'PAGE_INITIAL').toBe(0)
    expect(createButton(), 'PAGE_INITIAL').toBeDisabled()
    expect(message(), 'PAGE_INITIAL').toBe('先填项目名称')
    expect(treeText(), 'PAGE_INITIAL').toContain('项目名称/')
    expect(screen.getByTestId('pi-code').value, 'PAGE_INITIAL').toBe('code')
    expect(screen.getByRole('radio', { name: '双层' }), 'PAGE_INITIAL').toHaveAttribute('aria-checked', 'true')
  })

  it('TC-016 PAGE_GIT_SWITCH 切 Git：说明换句，.gitignore、.dev-workflow、标签跟着变', async () => {
    await renderPage('PAGE_GIT_SWITCH')
    expect(screen.getByText('外层一个私人仓、代码一个仓，互不包含'), 'PAGE_GIT_SWITCH').toBeTruthy()
    expect(treeText(), 'PAGE_GIT_SWITCH').toContain('私人仓')
    fireEvent.click(screen.getByRole('radio', { name: '只给代码建仓' }))
    expect(screen.getByText('只有代码文件夹是 Git 仓，外层不建仓'), 'PAGE_GIT_SWITCH').toBeTruthy()
    expect(treeText(), 'PAGE_GIT_SWITCH').not.toContain('私人仓')
    expect(treeText(), 'PAGE_GIT_SWITCH').toContain('代码仓')
    fireEvent.click(screen.getByRole('radio', { name: '跳过' }))
    expect(screen.getByText('先不建仓，以后自己 git init'), 'PAGE_GIT_SWITCH').toBeTruthy()
    // 页面目录树和主进程生成读同一份清单：逐行和共用清单的输出一致
    const url = pathToFileURL(path.resolve(__dirname, '..', '..', 'shared', 'projectInitManifest.mjs')).href
    const manifest = await import(/* @vite-ignore */ url).catch(() => null)
    expect(manifest, 'PAGE_GIT_SWITCH').toBeTruthy()
    const { root, rows } = manifest.buildTree({ projectName: '', gitMode: 'none', codeDir: 'code' })
    const shown = screen.getAllByTestId('pi-tree-row').map((row) => row.querySelector('.pi-nm').textContent)
    expect(shown, 'PAGE_GIT_SWITCH').toEqual([root.name, ...rows.map((row) => row.name)])
    expect(treeText(), 'PAGE_GIT_SWITCH').not.toContain('.gitignore')
    expect(treeText(), 'PAGE_GIT_SWITCH').not.toContain('.dev-workflow')
    expect(treeText(), 'PAGE_GIT_SWITCH').not.toContain('代码仓')
  })

  it('TC-017 PAGE_LIVE_VALIDATE 停止输入后实时校验，错误落到对应行与动作行', async () => {
    mockApi({
      validateProjectInit: vi.fn(async () => ({ success: true, valid: false, data: { errors: [{ code: 'TARGET_CONFLICT', message: '目标路径存在冲突', field: 'projectName' }] } })),
    })
    await renderPage('PAGE_LIVE_VALIDATE')
    fireEvent.change(nameInput(), { target: { value: 'my-app' } })
    await waitFor(() => expect(api.validateProjectInit, 'PAGE_LIVE_VALIDATE').toHaveBeenCalledWith(
      expect.objectContaining({ projectName: 'my-app', targetPath: '~/Documents/projects/', codeDirName: 'code', gitMode: 'dual' }),
    ))
    await waitFor(() => expect(message(), 'PAGE_LIVE_VALIDATE').toBe('目标路径存在冲突'))
    expect(nameInput(), 'PAGE_LIVE_VALIDATE').toHaveAttribute('aria-invalid', 'true')
    expect(screen.getAllByText('目标路径存在冲突').length, 'PAGE_LIVE_VALIDATE').toBeGreaterThanOrEqual(2)
    expect(createButton(), 'PAGE_LIVE_VALIDATE').toBeDisabled()
  })

  it('TC-018 PAGE_CREATE_OK 创建中不能改，成功 Toast + 建在哪 + 复制路径，名称清空', async () => {
    let finish
    mockApi({ executeProjectInit: vi.fn(() => new Promise((resolve) => { finish = resolve })) })
    await renderPage('PAGE_CREATE_OK')
    await typeName('my-app')
    await waitFor(() => expect(createButton()).not.toBeDisabled())
    fireEvent.click(createButton())
    await waitFor(() => expect(createButton().textContent, 'PAGE_CREATE_OK').toBe('创建中…'))
    expect(nameInput(), 'PAGE_CREATE_OK').toBeDisabled()
    await act(async () => finish({ success: true, data: { projectPath: '/tmp/projects/my-app', commit: 'done' } }))
    await waitFor(() => expect(toastSpy.success, 'PAGE_CREATE_OK').toHaveBeenCalledWith('已创建 my-app'))
    expect(message(), 'PAGE_CREATE_OK').toContain('已创建在 /tmp/projects/my-app')
    expect(nameInput().value, 'PAGE_CREATE_OK').toBe('')
    fireEvent.click(screen.getByRole('button', { name: '复制路径' }))
    await waitFor(() => expect(navigator.clipboard.writeText, 'PAGE_CREATE_OK').toHaveBeenCalledWith('/tmp/projects/my-app'))
    await waitFor(() => expect(toastSpy.success, 'PAGE_CREATE_OK').toHaveBeenCalledWith('已复制路径'))
  })

  it('TC-019 PAGE_NO_COMMIT 成功但没做初始提交：动作行第二行说怎么补', async () => {
    mockApi({ executeProjectInit: vi.fn(async () => ({ success: true, data: { projectPath: '/tmp/projects/my-app', commit: 'skipped-no-identity' } })) })
    const { container } = await renderPage('PAGE_NO_COMMIT')
    await typeName('my-app')
    await waitFor(() => expect(createButton()).not.toBeDisabled())
    fireEvent.click(createButton())
    await waitFor(() => expect(message(), 'PAGE_NO_COMMIT').toContain('Git 没配名字和邮箱，没做初始提交；配好后到项目里补一次'))
    expect(container.querySelector('.np-actionbar-msg--warn'), 'PAGE_NO_COMMIT').toBeTruthy()
  })

  it('TC-020 PAGE_CREATE_FAIL 失败：红 Toast，动作行写哪一步与原因，输入保留', async () => {
    mockApi({ executeProjectInit: vi.fn(async () => ({ success: false, error: 'EXECUTION_FAILED', data: { failedStep: '写入 docs/README.md', reason: '目标路径不可写', rollback: { success: true, path: '/tmp/projects/my-app' } } })) })
    await renderPage('PAGE_CREATE_FAIL')
    await typeName('my-app')
    await waitFor(() => expect(createButton()).not.toBeDisabled())
    fireEvent.click(createButton())
    await waitFor(() => expect(toastSpy.error, 'PAGE_CREATE_FAIL').toHaveBeenCalledWith('创建失败'))
    expect(message(), 'PAGE_CREATE_FAIL').toBe('写入 docs/README.md 时失败：目标路径不可写。已撤回，没留下文件')
    expect(nameInput().value, 'PAGE_CREATE_FAIL').toBe('my-app')
    expect(createButton(), 'PAGE_CREATE_FAIL').not.toBeDisabled()
  })

  it('TC-021 PAGE_NO_GIT 没装 Git：只能跳过，Git 一行橙字', async () => {
    mockApi({ checkGitAvailable: vi.fn(async () => ({ success: true, data: { available: false } })) })
    await renderPage('PAGE_NO_GIT')
    await waitFor(() => expect(screen.getByText('本机没装 Git，只能先跳过'), 'PAGE_NO_GIT').toBeTruthy())
    expect(screen.getByRole('radio', { name: '跳过' }), 'PAGE_NO_GIT').toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: '双层' }), 'PAGE_NO_GIT').toBeDisabled()
    expect(screen.getByRole('radio', { name: '只给代码建仓' }), 'PAGE_NO_GIT').toBeDisabled()
  })

  it('TC-022 PAGE_KEYS Enter 等于创建、Esc 不创建；结果出来后改输入就清掉', async () => {
    await renderPage('PAGE_KEYS')
    await typeName('my-app')
    await waitFor(() => expect(createButton()).not.toBeDisabled())
    fireEvent.keyDown(nameInput(), { key: 'Escape' })
    expect(api.executeProjectInit, 'PAGE_KEYS').not.toHaveBeenCalled()
    fireEvent.keyDown(nameInput(), { key: 'Enter' })
    await waitFor(() => expect(api.executeProjectInit, 'PAGE_KEYS').toHaveBeenCalledTimes(1))
    await waitFor(() => expect(message(), 'PAGE_KEYS').toContain('已创建在'))
    fireEvent.change(screen.getByTestId('pi-code'), { target: { value: 'app' } })
    expect(message(), 'PAGE_KEYS').not.toContain('已创建在')
  })

  it('TC-027 PAGE_BROWSE 浏览：选中填回并重新校验，取消不变', async () => {
    await renderPage('PAGE_BROWSE')
    fireEvent.click(screen.getByRole('button', { name: '浏览' }))
    await waitFor(() => expect(screen.getByTestId('pi-path').value, 'PAGE_BROWSE').toBe('/tmp/picked'))
    await waitFor(() => expect(api.validateProjectInit, 'PAGE_BROWSE').toHaveBeenCalledWith(expect.objectContaining({ targetPath: '/tmp/picked' })))
    api.selectFolder.mockResolvedValueOnce({ success: true, canceled: true })
    fireEvent.click(screen.getByRole('button', { name: '浏览' }))
    await waitFor(() => expect(api.selectFolder, 'PAGE_BROWSE').toHaveBeenCalledTimes(2))
    expect(screen.getByTestId('pi-path').value, 'PAGE_BROWSE').toBe('/tmp/picked')
  })

  it('TC-028 PAGE_PRIORITY 创建中文案、失败优先于输入问题、复制失败红 Toast', async () => {
    let finish
    mockApi({
      // 名称刚输完就点创建：实时校验在创建途中才回来，并报了输入问题
      validateProjectInit: vi.fn(async () => ({ success: true, valid: false, data: { errors: [{ field: 'projectName', message: '目标路径存在冲突' }] } })),
      executeProjectInit: vi.fn(() => new Promise((resolve) => { finish = resolve })),
    })
    await renderPage('PAGE_PRIORITY')
    fireEvent.change(nameInput(), { target: { value: 'my-app' } })
    fireEvent.click(createButton())
    await waitFor(() => expect(message(), 'PAGE_PRIORITY').toBe('正在创建…'))
    await waitFor(() => expect(api.validateProjectInit).toHaveBeenCalled())
    await act(async () => finish({ success: false, data: { failedStep: '写入 docs/README.md', reason: '目标路径不可写', rollback: { success: true } } }))
    await waitFor(() => expect(message(), 'PAGE_PRIORITY').toContain('时失败'))
    expect(message(), 'PAGE_PRIORITY').not.toContain('目标路径存在冲突')

    // 复制失败
    navigator.clipboard.writeText = vi.fn(async () => { throw new Error('denied') })
    mockApi({ executeProjectInit: vi.fn(async () => ({ success: true, data: { projectPath: '/tmp/p/x', commit: 'done' } })) })
    cleanup()
    await renderPage('PAGE_PRIORITY')
    await typeName('x')
    await waitFor(() => expect(createButton()).not.toBeDisabled())
    fireEvent.click(createButton())
    await waitFor(() => expect(screen.getByRole('button', { name: '复制路径' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '复制路径' }))
    await waitFor(() => expect(toastSpy.error, 'PAGE_PRIORITY').toHaveBeenCalledWith('复制失败'))
  })
})
