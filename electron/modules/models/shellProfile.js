/**
 * 第三方模型接入 · 在终端里用：登录 shell 的 PATH 与「加入 PATH」
 *
 * 负责：
 * - 判断用户的登录 shell（账户记录 > SHELL > /bin/zsh）与种类（zsh / bash / 其他）
 * - 以「登录 + 交互」方式启动一次 shell，读出 PATH、command -v codepal 与 ZDOTDIR（后-12、后-13）：输出用前后标记夹住，
 *   启动文件打印的其他内容不影响结果；超时或启动失败算「判断不了」，不拿 CodePal 自己的 PATH 顶替
 * - 加入 PATH 写哪个文件（后-13、A-102）与怎么写（后-14）：先写同目录的完整新文件、核对原文件没被别人改过，
 *   再一步替换；查重；跟随符号链接写到真文件；任何一步失败原文件保持原样
 *
 * 只做文件与子进程，不碰界面；文案里的路径一律写成 ~ 开头。
 *
 * @module electron/modules/models/shellProfile
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { spawn } = require('child_process')

const PATH_LINE = 'export PATH="$HOME/.local/bin:$PATH"'
const COMMENT = '# 由 CodePal 加入：让终端找得到 codepal 命令'
const BEGIN = '__CODEPAL_PATH_BEGIN__'
const END = '__CODEPAL_PATH_END__'
const CMD_BEGIN = '__CODEPAL_CMD_BEGIN__'
const CMD_END = '__CODEPAL_CMD_END__'
const ZD_BEGIN = '__CODEPAL_ZDOTDIR_BEGIN__'
const ZD_END = '__CODEPAL_ZDOTDIR_END__'
const DEFAULT_TIMEOUT_MS = 5000

/** 带 code 的错误 */
function fail(code, message, extra = {}) {
  const err = new Error(message)
  err.code = code
  Object.assign(err, extra)
  return err
}

/**
 * 用户的登录 shell
 * @param {{userInfoShell?: string|null, env?: object}} [opts]
 * @returns {string}
 */
function loginShell({ userInfoShell, env = process.env } = {}) {
  let fromAccount = userInfoShell
  if (fromAccount === undefined) {
    try { fromAccount = os.userInfo().shell } catch { fromAccount = null }
  }
  return fromAccount || env.SHELL || '/bin/zsh'
}

/** @returns {'zsh'|'bash'|'other'} */
function shellKind(shellPath) {
  const name = path.basename(String(shellPath || ''))
  if (name === 'zsh') return 'zsh'
  if (name === 'bash') return 'bash'
  return 'other'
}

/** 家目录下的路径写成 ~ 开头 */
function tilde(file, home) {
  if (file === home) return '~'
  if (file.startsWith(home + path.sep)) return '~' + file.slice(home.length)
  return file
}

/**
 * 给这个 shell 的一次性脚本：读出 PATH、command -v codepal 与 ZDOTDIR，用标记夹住。
 * ZDOTDIR 常在 ~/.zshenv 里设，从 Finder 打开的 CodePal 自己的环境里没有，所以要从登录 shell 里读（后-13）
 */
function probeScript(kind) {
  if (kind === 'other') {
    // fish：$PATH 是列表，命令替换用 (…)；fish 不用 ZDOTDIR
    return `printf '${BEGIN}%s${END}' (string join : $PATH); printf '${CMD_BEGIN}%s${CMD_END}' (command -v codepal 2>/dev/null)`
  }
  return `printf '${BEGIN}%s${END}' "$PATH"; printf '${CMD_BEGIN}%s${CMD_END}' "$(command -v codepal 2>/dev/null)"; printf '${ZD_BEGIN}%s${ZD_END}' "\${ZDOTDIR:-}"`
}

/** 取 out 里 begin、end 之间的内容（从 after 之后找）；没有返回 null */
function between(out, begin, end, after = 0) {
  const s = out.indexOf(begin, after)
  const e = s < 0 ? -1 : out.indexOf(end, s + begin.length)
  return s >= 0 && e >= 0 ? out.slice(s + begin.length, e) : null
}

/**
 * 以「登录 + 交互」方式启动一次用户的 shell，读出 PATH（后-12）
 * @param {{shell: string, env?: object, home?: string, timeoutMs?: number}} opts
 * @returns {Promise<{status: 'ok', path: string, codepal: string|null, zdotdir: string|null} | {status: 'unknown'}>}
 */
function readLoginEnv({ shell, env = process.env, home, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    let out = ''
    let settled = false
    let child
    const done = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (child && child.exitCode === null) {
        try { process.kill(-child.pid, 'SIGKILL') } catch {
          try { child.kill('SIGKILL') } catch {}
        }
      }
      resolve(value)
    }
    try {
      child = spawn(shell, ['-ilc', probeScript(shellKind(shell))], {
        env: { ...env, ...(home ? { HOME: home } : {}) },
        cwd: home || os.homedir(),
        stdio: ['ignore', 'pipe', 'ignore'],
        detached: true,
      })
    } catch {
      resolve({ status: 'unknown' })
      return
    }
    const timer = setTimeout(() => done({ status: 'unknown' }), timeoutMs)
    child.stdout.on('data', (chunk) => { out += chunk })
    child.on('error', () => done({ status: 'unknown' }))
    child.on('close', () => {
      const start = out.lastIndexOf(BEGIN)
      const stop = out.indexOf(END, start + BEGIN.length)
      if (start < 0 || stop < 0) return done({ status: 'unknown' })
      const codepal = (between(out, CMD_BEGIN, CMD_END, stop) || '').trim() || null
      const zdotdir = (between(out, ZD_BEGIN, ZD_END, stop) || '').trim() || null
      done({ status: 'ok', path: out.slice(start + BEGIN.length, stop), codepal, zdotdir })
    })
  })
}

/** PATH 里有没有这个目录 */
function hasBinDir(pathValue, binDir) {
  const target = path.resolve(binDir)
  return String(pathValue || '').split(':').some((dir) => dir && path.resolve(dir) === target)
}

/** @returns {'found'|'missing'|'unknown'} */
function pathStatus(result, binDir) {
  if (!result || result.status !== 'ok') return 'unknown'
  return hasBinDir(result.path, binDir) ? 'found' : 'missing'
}

/** 终端里输入 codepal 会先找到别处的程序（后-09 的第二种被占） */
function entryShadowed(result, binDir) {
  if (!result || result.status !== 'ok' || !result.codepal) return false
  return path.resolve(result.codepal) !== path.resolve(binDir, 'codepal')
}

/** 文件在不在（符号链接看链接本身） */
function exists(file) {
  try { fs.lstatSync(file); return true } catch { return false }
}

/** 目标身份：显示路径 + 真实路径；确认框打开时与点「加入」时各算一次，不一样就不写（后-13-例6） */
function identityOf(file) {
  let real = null
  try { real = fs.realpathSync(file) } catch {}
  let link = null
  try { link = fs.lstatSync(file).isSymbolicLink() ? fs.readlinkSync(file) : null } catch {}
  return JSON.stringify({ file, real, link })
}

/**
 * 加入 PATH 写哪个文件（后-13、A-102）
 * @param {{kind: 'zsh'|'bash'|'other', home: string, zdotdir?: string|null}} opts
 * @returns {{file: string, display: string, identity: string}|null} 其他 shell 返回 null（不给按钮）
 */
function profileTarget({ kind, home, zdotdir = null }) {
  let file = null
  if (kind === 'zsh') file = path.join(zdotdir || home, '.zprofile')
  else if (kind === 'bash') {
    const candidates = ['.bash_profile', '.bash_login', '.profile'].map((name) => path.join(home, name))
    file = candidates.find(exists) || candidates[0]
  }
  if (!file) return null
  return { file, display: tilde(file, home), identity: identityOf(file) }
}

/** 原文件里有没有完全相同的那一行 */
const hasLine = (text) => text.split(/\r?\n/).some((line) => line.trim() === PATH_LINE)

/**
 * 加入 PATH：写完整新文件、核对后一步替换（后-14）
 * @param {{target: {file: string, display: string, identity: string}, expectedIdentity?: string,
 *   beforeReplace?: () => void}} opts - beforeReplace 只给测试模拟「替换前别人改了文件」
 * @returns {{added: boolean, file: string, display: string}}
 * @throws {Error} code: target_changed / write_denied / changed_meanwhile
 */
function addToPath({ target, expectedIdentity, beforeReplace }) {
  const { file, display } = target
  const denied = () => fail('write_denied', `没能写入 ${display}：没有写入权限，检查这个文件的权限后再试`)
  if (expectedIdentity !== undefined && identityOf(file) !== expectedIdentity) {
    throw fail('target_changed', `要写的文件变了：${display}`)
  }
  // 跟随符号链接，写到真文件；链接指向不存在的位置就不写
  let real = file
  let isLink = false
  try { isLink = fs.lstatSync(file).isSymbolicLink() } catch {}
  if (isLink) {
    try { real = fs.realpathSync(file) } catch { throw denied() }
  }
  let original = null
  let mode = 0o644
  try {
    original = fs.readFileSync(real, 'utf8')
    mode = fs.statSync(real).mode & 0o777
  } catch (err) {
    if (err.code !== 'ENOENT') throw denied()
  }
  // 文件本身只读：用户的意思是别动它，不靠「换一个新文件」绕过去
  if (original !== null) {
    try { fs.accessSync(real, fs.constants.W_OK) } catch { throw denied() }
  }
  if (original !== null && hasLine(original)) return { added: false, file: real, display }
  const base = original === null || original === '' ? '' : original.endsWith('\n') ? original : original + '\n'
  const next = `${base}${base ? '\n' : ''}${COMMENT}\n${PATH_LINE}\n`
  const tmp = path.join(path.dirname(real), `.${path.basename(real)}.codepal-tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`)
  try {
    fs.writeFileSync(tmp, next, { mode, flag: 'wx' })
    fs.chmodSync(tmp, mode)
  } catch {
    try { fs.rmSync(tmp, { force: true }) } catch {}
    throw denied()
  }
  try {
    if (beforeReplace) beforeReplace()
    // 替换前再核对：原文件被别人改过 / 原本不存在却被别人建了 → 放弃
    let now = null
    try { now = fs.readFileSync(real, 'utf8') } catch (err) { if (err.code !== 'ENOENT') throw denied() }
    if (now !== original) throw fail('changed_meanwhile', `没能写入 ${display}：它刚被别的程序改过，再点一次「加入 PATH」`)
    if (original === null) {
      // 新建：用硬链接放到位，目标已存在时会失败而不是覆盖
      try { fs.linkSync(tmp, real) } catch (err) {
        if (err.code === 'EEXIST') throw fail('changed_meanwhile', `没能写入 ${display}：它刚被别的程序改过，再点一次「加入 PATH」`)
        throw denied()
      }
    } else {
      try { fs.renameSync(tmp, real) } catch { throw denied() }
    }
  } finally {
    try { fs.rmSync(tmp, { force: true }) } catch {}
  }
  return { added: true, file: real, display }
}

module.exports = {
  PATH_LINE,
  COMMENT,
  DEFAULT_TIMEOUT_MS,
  loginShell,
  shellKind,
  readLoginEnv,
  hasBinDir,
  pathStatus,
  entryShadowed,
  profileTarget,
  addToPath,
  tilde,
}
