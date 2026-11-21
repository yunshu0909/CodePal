/**
 * 第三方模型接入 · 找本机 Claude Code 并检查版本
 *
 * 负责：
 * - 先按当前 PATH 找 claude，再查常见安装位置与用户 shell，兼容 Finder 的精简环境
 * - 读 `claude --version`，低于 2.1.251 不启动（Nexus 实测过的最低版本，
 *   Nexus internal/app/claudelaunch/service.go:133-174）
 * - 同步版给命令行用；模型接入页用后台版（locateClaudeAsync / checkClaudeVersionAsync），
 *   不让主进程停下来等（#99：本机 `claude --version` 要 3 秒）
 * - claudeFingerprint：这份 claude 的指纹，升级、卸载、换安装方式都会变，用来判断上次的版本结果还能不能用
 *
 * 测试用覆盖口 CODEPAL_CLAUDE_BIN。
 *
 * @module electron/modules/models/claudeCli
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync, execFile } = require('child_process')

const MIN_CLAUDE_VERSION = '2.1.251'
const QUERY_BEGIN = '__CODEPAL_CLAUDE_BEGIN__'
const QUERY_END = '__CODEPAL_CLAUDE_END__'

/** 是可执行的普通文件 */
function isExecutable(file) {
  try {
    const st = fs.statSync(file)
    if (!st.isFile()) return false
    fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 找 claude 可执行文件
 * @param {object} [env=process.env]
 * 只读取文件状态与 shell 查询结果，不运行 Claude、不修改环境配置。
 * @returns {string|null} 可执行路径，找不到返回 null
 */
function locateClaude(env = process.env) {
  if (env.CODEPAL_CLAUDE_BIN) return isExecutable(env.CODEPAL_CLAUDE_BIN) ? env.CODEPAL_CLAUDE_BIN : null
  const quick = locateClaudeQuick(env)
  if (quick) return quick
  try {
    // 保持现有同步定位契约；shellProfile 的异步探针查询的是 codepal，不能直接用于本入口。
    // 交互登录模式加载终端 PATH，标记隔开启动提示；仅在常见位置都不存在时才等待 shell。
    const r = spawnSync(accountShell(env), ['-ilc', SHELL_QUERY], {
      env,
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return parseShellAnswer(r.status === 0 ? r.stdout : '')
  } catch {}
  return null
}

/**
 * 只查常见安装位置（和 PATH），不问 shell：只读文件状态，几毫秒，不会卡住主进程
 * @param {object} [env=process.env]
 * @returns {string|null}
 */
function locateClaudeQuick(env = process.env) {
  if (env.CODEPAL_CLAUDE_BIN) return isExecutable(env.CODEPAL_CLAUDE_BIN) ? env.CODEPAL_CLAUDE_BIN : null
  const home = env.HOME || os.homedir()
  const directories = [
    ...String(env.PATH || '').split(path.delimiter),
    path.join(home, '.local/bin'),
    // 旧版「本地安装」（claude migrate-installer）装在这里；新旧都在时上一行的新版优先（#86）
    path.join(home, '.claude/local'),
    path.join(home, '.npm-global/bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ]
  for (const dir of directories) {
    if (!dir) continue
    const file = path.join(dir, 'claude')
    if (isExecutable(file)) return file
  }
  return null
}

const SHELL_QUERY = `printf '${QUERY_BEGIN}'; command -v claude; printf '${QUERY_END}'`

/** 用户账号的登录 shell */
function accountShell(env) {
  let shell
  try {
    shell = os.userInfo().shell
  } catch {
    shell = null
  }
  return shell || env.SHELL || '/bin/bash'
}

/** 从 shell 输出里取标记之间的路径，可执行才算 */
function parseShellAnswer(stdout) {
  const out = String(stdout || '')
  const start = out.lastIndexOf(QUERY_BEGIN)
  const end = out.indexOf(QUERY_END, start + QUERY_BEGIN.length)
  const found = start >= 0 && end >= 0 ? out.slice(start + QUERY_BEGIN.length, end).trim() : ''
  return found && isExecutable(found) ? found : null
}

/**
 * 找 claude，后台版：常见位置照旧查文件；都没有时在子进程里问登录 shell，主进程不停下等
 * @param {object} [env=process.env]
 * @returns {Promise<string|null>}
 */
function locateClaudeAsync(env = process.env) {
  if (env.CODEPAL_CLAUDE_BIN) return Promise.resolve(isExecutable(env.CODEPAL_CLAUDE_BIN) ? env.CODEPAL_CLAUDE_BIN : null)
  const quick = locateClaudeQuick(env)
  if (quick) return Promise.resolve(quick)
  return new Promise((resolve) => {
    try {
      execFile(accountShell(env), ['-ilc', SHELL_QUERY], { env, encoding: 'utf8', timeout: 5000 }, (err, stdout) => {
        resolve(err ? null : parseShellAnswer(stdout))
      })
    } catch {
      resolve(null)
    }
  })
}

/** 比较 x.y.z，a < b 返回负数 */
function compareVersions(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0)
  }
  return 0
}

/**
 * 检查 Claude Code 版本
 * @param {string} claudePath
 * @param {object} [env=process.env]
 * @returns {{ok: boolean, current: string|null, required: string}}
 */
function checkClaudeVersion(claudePath, env = process.env) {
  const r = spawnSync(claudePath, ['--version'], { encoding: 'utf8', timeout: 20000, env })
  return judgeVersion(r.status === 0 ? r.stdout : '')
}

/**
 * 按版本号判断够不够新
 * @param {string|null} output - `claude --version` 的输出，或已经取出的版本号
 * @returns {{ok: boolean, current: string|null, required: string}}
 */
function judgeVersion(output) {
  const m = output ? String(output).match(/(\d+\.\d+\.\d+)/) : null
  if (!m) return { ok: false, current: null, required: MIN_CLAUDE_VERSION }
  return { ok: compareVersions(m[1], MIN_CLAUDE_VERSION) >= 0, current: m[1], required: MIN_CLAUDE_VERSION }
}

/**
 * 检查 Claude Code 版本，后台版：子进程跑 `claude --version`，主进程照常响应
 * @param {string} claudePath
 * @param {object} [env=process.env]
 * @returns {Promise<{ok: boolean, current: string|null, required: string}>}
 */
function checkClaudeVersionAsync(claudePath, env = process.env) {
  return new Promise((resolve) => {
    try {
      execFile(claudePath, ['--version'], { encoding: 'utf8', timeout: 20000, env }, (err, stdout) => {
        resolve(judgeVersion(err ? '' : stdout))
      })
    } catch {
      resolve(judgeVersion(''))
    }
  })
}

/**
 * 这份 claude 的指纹：入口路径、链接最终指向的文件和它的大小、修改时间、文件号。
 * 原生安装升级换链接目标，npm / 自带更新换文件内容或文件号，卸载后读不到——都会变。只读文件状态。
 * @param {string|null} bin
 * @returns {string|null} 读不到（不存在、不可执行）返回 null
 */
function claudeFingerprint(bin) {
  if (!bin || !isExecutable(bin)) return null
  try {
    const real = fs.realpathSync(bin)
    const st = fs.statSync(real)
    return JSON.stringify([bin, real, st.size, Math.round(st.mtimeMs), st.ino])
  } catch {
    return null
  }
}

module.exports = { MIN_CLAUDE_VERSION, locateClaude, locateClaudeQuick, locateClaudeAsync, checkClaudeVersion,
  checkClaudeVersionAsync, judgeVersion, claudeFingerprint, compareVersions }
