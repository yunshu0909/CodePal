/**
 * 第三方模型接入 · 运行 claude 子进程
 *
 * 负责：
 * - 交互模式：标准输入 / 输出 / 错误直接交给 claude
 * - 后台模式：标准输出逐字透传并留一份给结果判定；标准错误同样透传并留尾巴，
 *   给了 configuredModel 时先去掉 Claude Code 对这个模型名打的「模型名认不出」诊断行（见 stderrFilter，#90）
 * - 后台模式把 SIGINT / SIGTERM / SIGHUP 转发给 claude；交互模式只转发 TERM / HUP——终端的 Ctrl-C 会同时发给
 *   同一进程组里的 claude，再转发一次会让 claude 把「按一次」当成「按两次」直接退出
 * - claude 被信号结束时返回 128 + 信号号
 * - 可选超时（只给「测一下」用）：先 SIGTERM，2 秒后还在就 SIGKILL
 *
 * 已知限制：调用方用 SIGKILL 杀本进程时信号无法转发，claude 可能跑完这一次（与 Nexus 相同）。
 *
 * @module electron/modules/models/runner
 */

const os = require('os')
const { spawn } = require('child_process')
const { createStderrFilter } = require('./stderrFilter')

const KEEP_BYTES = 5 * 1024 * 1024
const FORWARD_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP']

/** 只保留最后 KEEP_BYTES 字节，防止超长输出占满内存 */
function appendCapped(buf, chunk) {
  const next = Buffer.concat([buf, chunk])
  return next.length > KEEP_BYTES ? next.subarray(next.length - KEEP_BYTES) : next
}

/**
 * 运行 claude
 * @param {object} p
 * @param {string} p.claudePath
 * @param {object} p.env
 * @param {string[]} p.args
 * @param {'interactive'|'print'} p.mode
 * @param {string} [p.stdinText] - 给定时把它写进 claude 的标准输入（「测一下」），否则继承
 * @param {number} [p.timeoutMs]
 * @param {string} [p.configuredModel] - 这次启动 CodePal 配的模型名；后台模式下不透传、不记录 Claude Code 对它打的诊断行
 * @param {NodeJS.WritableStream} [p.out=process.stdout]
 * @param {NodeJS.WritableStream} [p.err=process.stderr]
 * @returns {Promise<{exitCode: number, stdout: string, stderr: string, timedOut: boolean}>}
 */
function runClaude({ claudePath, env, args, mode, stdinText, timeoutMs, configuredModel, out = process.stdout, err = process.stderr }) {
  return new Promise((resolve) => {
    const interactive = mode === 'interactive'
    const stdio = interactive ? 'inherit' : [stdinText === undefined ? 'inherit' : 'pipe', 'pipe', 'pipe']
    const child = spawn(claudePath, args, { env, stdio })
    let stdout = Buffer.alloc(0)
    let stderr = Buffer.alloc(0)
    let timedOut = false
    let killTimer = null
    let stderrFilter = null

    if (!interactive) {
      child.stdout.on('data', (c) => { out.write(c); stdout = appendCapped(stdout, c) })
      if (configuredModel) {
        stderrFilter = createStderrFilter({
          modelName: configuredModel,
          write: (text) => { err.write(text); stderr = appendCapped(stderr, Buffer.from(text, 'utf8')) },
        })
        child.stderr.setEncoding('utf8')
        child.stderr.on('data', (c) => stderrFilter.push(c))
      } else {
        child.stderr.on('data', (c) => { err.write(c); stderr = appendCapped(stderr, c) })
      }
      if (stdinText !== undefined) {
        child.stdin.on('error', () => {})
        child.stdin.end(stdinText)
      }
    }

    const forward = (sig) => { try { child.kill(sig) } catch {} }
    const handlers = FORWARD_SIGNALS.map((sig) => [sig, interactive && sig === 'SIGINT' ? () => {} : forward])
    for (const [sig, fn] of handlers) process.on(sig, fn)

    const timer = timeoutMs ? setTimeout(() => {
      timedOut = true
      forward('SIGTERM')
      killTimer = setTimeout(() => forward('SIGKILL'), 2000)
    }, timeoutMs) : null

    const finish = (code, signal) => {
      if (timer) clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      for (const [sig, fn] of handlers) process.removeListener(sig, fn)
      if (stderrFilter) stderrFilter.end()
      const exitCode = code !== null && code !== undefined ? code : 128 + (os.constants.signals[signal] || 0)
      resolve({ exitCode, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), timedOut })
    }
    child.on('error', (e) => {
      err.write(`CodePal：启动 Claude Code 失败（${e.code || e.message}）\n`)
      finish(127, null)
    })
    child.on('close', finish)
  })
}

module.exports = { runClaude }
