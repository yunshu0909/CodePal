/**
 * @vitest-environment node
 *
 * 模型接入 · 在终端里用 · shell 判断与加入 PATH（specs/v2.1.22-在终端里用/4-test-cases.md）
 *
 * 负责：
 * - 登录 shell 的 PATH 怎么读（后-12）：交互登录方式、前后标记、5 秒超时算「判断不了」
 * - 加入 PATH 写哪个文件（后-13、A-102）与怎么写（后-14：完整新文件一步替换、查重、链接、并发）
 * - 用临时 HOME 里的真实 zsh / bash 启动文件；假 shell 用测试脚本模拟超时、打印欢迎语
 *
 * @module tests/models/shellProfile.test
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const shell = require('../../electron/modules/models/shellProfile.js')

const LINE = 'export PATH="$HOME/.local/bin:$PATH"'
let home

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codepal-shell-')))
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true })
})
afterEach(() => {
  try { fs.chmodSync(home, 0o755) } catch {}
  fs.rmSync(home, { recursive: true, force: true })
})

const write = (name, text) => {
  const file = path.join(home, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
  return file
}
/** 假 shell：把参数里的脚本交给真正的 sh 跑，前面先做点别的 */
const fakeShell = (name, prelude) => {
  const file = path.join(home, name)
  fs.writeFileSync(file, `#!/bin/sh\n${prelude}\nshift\nexec /bin/sh -c "$1"\n`, { mode: 0o755 })
  return file
}
const env = (extra = {}) => ({ HOME: home, PATH: '/usr/bin:/bin', ...extra })

describe('判断终端找不找得到 codepal（后-12）', () => {
  it('TC-014 后-12-例1 zsh 用户把 ~/.local/bin 写在 ~/.zprofile → 找得到（不再用 bash 判断）', async () => {
    write('.zprofile', `export PATH="${home}/.local/bin:$PATH"\n`)
    const r = await shell.readLoginEnv({ shell: '/bin/zsh', env: env(), home, timeoutMs: 5000 })
    expect(r.status).toBe('ok')
    expect(shell.hasBinDir(r.path, path.join(home, '.local', 'bin'))).toBe(true)
  })

  it('TC-014 后-12-例2 bash 用户写在 ~/.bash_profile → 找得到', async () => {
    write('.bash_profile', `export PATH="${home}/.local/bin:$PATH"\n`)
    const r = await shell.readLoginEnv({ shell: '/bin/bash', env: env(), home, timeoutMs: 5000 })
    expect(r.status).toBe('ok')
    expect(shell.hasBinDir(r.path, path.join(home, '.local', 'bin'))).toBe(true)
  })

  it('TC-014 后-12-例3 shell 5 秒没响应 → 判断不了（unknown），不是「找不到」', async () => {
    const slow = fakeShell('slow-sh', 'sleep 30')
    const t0 = Date.now()
    const r = await shell.readLoginEnv({ shell: slow, env: env(), home, timeoutMs: 800 })
    expect(r.status).toBe('unknown')
    expect(Date.now() - t0).toBeLessThan(5000)
  })

  it('TC-014 后-12-例4 ~/.zshrc 把 PATH 整个改写 → 判断为找不到（交互方式会读 ~/.zshrc）', async () => {
    write('.zprofile', `export PATH="${home}/.local/bin:$PATH"\n`)
    write('.zshrc', 'export PATH=/usr/bin:/bin\n')
    const r = await shell.readLoginEnv({ shell: '/bin/zsh', env: env(), home, timeoutMs: 5000 })
    expect(r.status).toBe('ok')
    expect(shell.hasBinDir(r.path, path.join(home, '.local', 'bin'))).toBe(false)
  })

  it('TC-014 后-12-例6 启动文件打印欢迎语 → 不影响读出的 PATH', async () => {
    write('.zprofile', `echo "欢迎回来 PATH=/假的"\nexport PATH="${home}/.local/bin:$PATH"\necho 再见\n`)
    const r = await shell.readLoginEnv({ shell: '/bin/zsh', env: env(), home, timeoutMs: 5000 })
    expect(r.status).toBe('ok')
    expect(r.path).not.toContain('/假的')
    expect(shell.hasBinDir(r.path, path.join(home, '.local', 'bin'))).toBe(true)
  })

  it('TC-014 真-02 出现：PATH 里没有 ~/.local/bin → 判为 missing；真-09 出现：fish 等其他 shell 没有按钮', async () => {
    const r = await shell.readLoginEnv({ shell: '/bin/zsh', env: env(), home, timeoutMs: 5000 })
    expect(shell.pathStatus(r, path.join(home, '.local', 'bin'))).toBe('missing')
    expect(shell.pathStatus({ status: 'unknown' }, path.join(home, '.local', 'bin'))).toBe('unknown')
    expect(shell.shellKind('/opt/homebrew/bin/fish')).toBe('other')
    expect(shell.profileTarget({ kind: 'other', home, zdotdir: null })).toBeNull()
  })

  it('TC-014 登录 shell 的取法：账户记录优先，其次 SHELL，都没有用 /bin/zsh', () => {
    expect(shell.loginShell({ userInfoShell: '/bin/bash', env: { SHELL: '/bin/zsh' } })).toBe('/bin/bash')
    expect(shell.loginShell({ userInfoShell: null, env: { SHELL: '/bin/bash' } })).toBe('/bin/bash')
    expect(shell.loginShell({ userInfoShell: null, env: {} })).toBe('/bin/zsh')
  })
})

describe('加入 PATH 写哪个文件（后-13、A-102）', () => {
  it('TC-015 后-13-例1 zsh、没设 ZDOTDIR → ~/.zprofile', () => {
    const t = shell.profileTarget({ kind: 'zsh', home, zdotdir: null })
    expect(t.display).toBe('~/.zprofile')
    expect(t.file).toBe(path.join(home, '.zprofile'))
  })

  it('TC-015 后-13-例2 bash、只有 ~/.profile → 写 ~/.profile，不新建 ~/.bash_profile', () => {
    write('.profile', '# mine\n')
    const t = shell.profileTarget({ kind: 'bash', home, zdotdir: null })
    expect(t.display).toBe('~/.profile')
    shell.addToPath({ target: t })
    expect(fs.existsSync(path.join(home, '.bash_profile'))).toBe(false)
    expect(fs.readFileSync(path.join(home, '.profile'), 'utf8')).toContain(LINE)
  })

  it('TC-015 后-13-例3 bash、三个文件都没有 → 新建 ~/.bash_profile', () => {
    const t = shell.profileTarget({ kind: 'bash', home, zdotdir: null })
    expect(t.display).toBe('~/.bash_profile')
    shell.addToPath({ target: t })
    expect(fs.readFileSync(path.join(home, '.bash_profile'), 'utf8')).toContain(LINE)
  })

  it('TC-015 后-13 bash 依次找：~/.bash_profile 在就写它，~/.bash_login 次之', () => {
    write('.bash_login', '')
    write('.profile', '')
    expect(shell.profileTarget({ kind: 'bash', home, zdotdir: null }).display).toBe('~/.bash_login')
    write('.bash_profile', '')
    expect(shell.profileTarget({ kind: 'bash', home, zdotdir: null }).display).toBe('~/.bash_profile')
  })

  it('TC-015 后-13-例4 fish → 没有目标（不给按钮）', () => {
    expect(shell.profileTarget({ kind: shell.shellKind('/usr/local/bin/fish'), home, zdotdir: null })).toBeNull()
  })

  it('TC-015 后-13-例5 zsh、ZDOTDIR=~/.config/zsh → 写 ~/.config/zsh/.zprofile', () => {
    const t = shell.profileTarget({ kind: 'zsh', home, zdotdir: path.join(home, '.config', 'zsh') })
    expect(t.display).toBe('~/.config/zsh/.zprofile')
  })

  it('TC-015 后-13-例6 打开确认框后目标变了（换成指向别处的链接）→ 不写，报 target_changed', () => {
    const t = shell.profileTarget({ kind: 'zsh', home, zdotdir: null })
    write('elsewhere/zprofile', '')
    fs.symlinkSync(path.join(home, 'elsewhere/zprofile'), path.join(home, '.zprofile'))
    let err
    try { shell.addToPath({ target: t, expectedIdentity: t.identity }) } catch (e) { err = e }
    expect(err?.code).toBe('target_changed')
    expect(fs.readFileSync(path.join(home, 'elsewhere/zprofile'), 'utf8')).toBe('')
  })
})

describe('加入 PATH 怎么写（后-14）', () => {
  const zprofile = () => path.join(home, '.zprofile')
  const target = () => shell.profileTarget({ kind: 'zsh', home, zdotdir: null })

  it('TC-013 后-14-例1 末尾多出三行，原内容一字不变，权限不变', () => {
    write('.zprofile', 'eval "$(/opt/homebrew/bin/brew shellenv)"')
    fs.chmodSync(zprofile(), 0o640)
    const r = shell.addToPath({ target: target() })
    expect(r.added).toBe(true)
    expect(fs.readFileSync(zprofile(), 'utf8')).toBe(
      'eval "$(/opt/homebrew/bin/brew shellenv)"\n\n# 由 CodePal 加入：让终端找得到 codepal 命令\n' + LINE + '\n')
    expect(fs.statSync(zprofile()).mode & 0o777).toBe(0o640)
  })

  it('TC-013 后-14-例2 连加两次，文件里只有一份这一行', () => {
    shell.addToPath({ target: target() })
    const r = shell.addToPath({ target: target() })
    expect(r.added).toBe(false)
    expect(fs.readFileSync(zprofile(), 'utf8').split(LINE).length - 1).toBe(1)
  })

  it('TC-013 后-14-例3 ~/.zprofile 是符号链接 → 写到真文件，链接不被换掉', () => {
    const real = write('dotfiles/zprofile', '# dotfiles\n')
    fs.symlinkSync(real, zprofile())
    shell.addToPath({ target: target() })
    expect(fs.lstatSync(zprofile()).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(real, 'utf8')).toContain(LINE)
  })

  it('TC-013 后-14-例4 ~/.zprofile 只读 → 文件不变，报 write_denied', () => {
    write('.zprofile', '# ro\n')
    fs.chmodSync(home, 0o555)
    fs.chmodSync(zprofile(), 0o444)
    let err
    try { shell.addToPath({ target: target() }) } catch (e) { err = e }
    fs.chmodSync(home, 0o755)
    expect(err?.code).toBe('write_denied')
    expect(fs.readFileSync(zprofile(), 'utf8')).toBe('# ro\n')
  })

  it('TC-013 后-14-例5 链接指向已删除的文件 → 不新建，按写入失败报', () => {
    fs.symlinkSync(path.join(home, 'gone/zprofile'), zprofile())
    let err
    try { shell.addToPath({ target: target() }) } catch (e) { err = e }
    expect(err?.code).toBe('write_denied')
    expect(fs.existsSync(path.join(home, 'gone/zprofile'))).toBe(false)
  })

  it('TC-013 后-14-例6 写新文件失败（目录不可写）→ 原文件一字不变，没有半行', () => {
    write('.zprofile', '# keep\n')
    fs.chmodSync(home, 0o555)
    let err
    try { shell.addToPath({ target: target() }) } catch (e) { err = e }
    fs.chmodSync(home, 0o755)
    expect(err?.code).toBe('write_denied')
    expect(fs.readFileSync(zprofile(), 'utf8')).toBe('# keep\n')
    expect(fs.readdirSync(home).filter((n) => n.includes('.codepal-tmp'))).toEqual([])
  })

  it('TC-013 后-14-例7 替换前文件被别人改了 → 放弃写入，保留别人的修改', () => {
    write('.zprofile', '# v1\n')
    let err
    try {
      shell.addToPath({ target: target(), beforeReplace: () => fs.writeFileSync(zprofile(), '# v2 by editor\n') })
    } catch (e) { err = e }
    expect(err?.code).toBe('changed_meanwhile')
    expect(fs.readFileSync(zprofile(), 'utf8')).toBe('# v2 by editor\n')
  })

  it('TC-013 后-14-例8 新建时目标被别人先建了 → 放弃，不覆盖', () => {
    const t = shell.profileTarget({ kind: 'bash', home, zdotdir: null })
    let err
    try {
      shell.addToPath({ target: t, beforeReplace: () => fs.writeFileSync(path.join(home, '.bash_profile'), '# other installer\n') })
    } catch (e) { err = e }
    expect(err?.code).toBe('changed_meanwhile')
    expect(fs.readFileSync(path.join(home, '.bash_profile'), 'utf8')).toBe('# other installer\n')
  })
})

describe('名字被占的第二种：PATH 里别处的 codepal 排在前面（后-09）', () => {
  it('TC-010 后-09-例2 command -v codepal 指向别处 → 名字被占', async () => {
    const other = path.join(home, 'other-bin')
    fs.mkdirSync(other)
    fs.writeFileSync(path.join(other, 'codepal'), '#!/bin/sh\n', { mode: 0o755 })
    write('.zprofile', `export PATH="${other}:${home}/.local/bin:$PATH"\n`)
    const r = await shell.readLoginEnv({ shell: '/bin/zsh', env: env(), home, timeoutMs: 5000 })
    expect(r.codepal).toBe(path.join(other, 'codepal'))
    expect(shell.entryShadowed(r, path.join(home, '.local', 'bin'))).toBe(true)
  })
})
