/**
 * 第三方模型接入 · 找本机 Claude Code 并检查版本
 *
 * 负责：
 * - 先按当前 PATH 找 claude，再查常见安装位置与用户 shell，兼容 Finder 的精简环境
 * - 读 `claude --version`，低于 2.1.251 不启动（Nexus 实测过的最低版本，
 *   Nexus internal/app/claudelaunch/service.go:133-174）
 *
 * 测试用覆盖口 CODEPAL_CLAUDE_BIN。
 *
 * @module electron/modules/models/claudeCli
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

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
  const home = env.HOME || os.homedir()
  const directories = [
    ...String(env.PATH || '').split(path.delimiter),
    path.join(home, '.local/bin'),
    path.join(home, '.npm-global/bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ]
  for (const dir of directories) {
    if (!dir) continue
    const file = path.join(dir, 'claude')
    if (isExecutable(file)) return file
  }
  try {
    let accountShell
    try {
      accountShell = os.userInfo().shell
    } catch {
      accountShell = null
    }
    const shell = accountShell || env.SHELL || '/bin/bash'
    // 保持现有同步定位契约；shellProfile 的异步探针查询的是 codepal，不能直接用于本入口。
    // 交互登录模式加载终端 PATH，标记隔开启动提示；仅在常见位置都不存在时才等待 shell。
    const query = `printf '${QUERY_BEGIN}'; command -v claude; printf '${QUERY_END}'`
    const r = spawnSync(shell, ['-ilc', query], {
      env,
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const out = r.status === 0 ? String(r.stdout || '') : ''
    const start = out.lastIndexOf(QUERY_BEGIN)
    const end = out.indexOf(QUERY_END, start + QUERY_BEGIN.length)
    const found = start >= 0 && end >= 0 ? out.slice(start + QUERY_BEGIN.length, end).trim() : ''
    if (found && isExecutable(found)) return found
  } catch {}
  return null
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
  const m = r.status === 0 ? String(r.stdout).match(/(\d+\.\d+\.\d+)/) : null
  if (!m) return { ok: false, current: null, required: MIN_CLAUDE_VERSION }
  return { ok: compareVersions(m[1], MIN_CLAUDE_VERSION) >= 0, current: m[1], required: MIN_CLAUDE_VERSION }
}

module.exports = { MIN_CLAUDE_VERSION, locateClaude, checkClaudeVersion, compareVersions }
