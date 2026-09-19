/**
 * 自动信任 CodePal 自己的 Codex 钩子（#41）
 *
 * 负责：
 * - Codex 按钩子内容算 trusted_hash，新装或改过的钩子默认「未信任」、不会运行，要用户在 Codex 里 /hooks 确认
 * - 这里走 Codex 官方接口（codex app-server 的 hooks/list + config/batchWrite），和 /hooks 里点「信任」写入的是同一样东西；
 *   指纹由 Codex 自己算，不伪造
 * - 只信任命令指向 CodePal 脚本（k28-status-light/codex-hook.sh）且来自 ~/.codex/config.toml 的钩子；别的钩子一概不碰
 * - 找不到 Codex 程序或接口失败时抛错，由调用方提示用户手动 /hooks
 *
 * @module electron/services/codexHookTrust
 */

const fs = require('fs')
const path = require('path')
const { spawn, spawnSync } = require('child_process')

const CODEX_HOOK_MARK = 'k28-status-light/codex-hook.sh'
const RPC_TIMEOUT_MS = 20000

// 常见安装位置：命令行版在 PATH 里；桌面版把 CLI 放在 app 包里
const APP_CANDIDATES = [
  '/Applications/ChatGPT.app/Contents/Resources/codex',
  '/Applications/Codex.app/Contents/Resources/codex',
]

/**
 * 找本机的 Codex 程序
 * @returns {string|null}
 */
function findCodexBinary() {
  const candidates = []
  if (process.env.CODEX_BIN) candidates.push(process.env.CODEX_BIN)
  try {
    const which = spawnSync('/usr/bin/which', ['codex'], { encoding: 'utf8', timeout: 3000 })
    if (which.status === 0 && which.stdout.trim()) candidates.push(which.stdout.trim())
  } catch {}
  candidates.push(...APP_CANDIDATES)
  return candidates.find((file) => {
    try {
      fs.accessSync(file, fs.constants.X_OK)
      return true
    } catch {
      return false
    }
  }) || null
}

/**
 * 起一个 codex app-server，按行收发 JSON-RPC
 * @param {string} codexBin
 * @param {object} env
 * @returns {{call: (method: string, params: object) => Promise<object>, notify: (method: string) => void, close: () => void}}
 */
function openAppServer(codexBin, env) {
  const child = spawn(codexBin, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'], env })
  const pending = new Map()
  let buffer = ''
  let seq = 0
  let exitError = null

  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      const waiter = message.id != null && pending.get(message.id)
      if (!waiter) continue
      pending.delete(message.id)
      if (message.error) waiter.reject(new Error(message.error.message || 'Codex 接口返回错误'))
      else waiter.resolve(message.result)
    }
  })
  const failAll = (error) => {
    exitError = error
    for (const waiter of pending.values()) waiter.reject(error)
    pending.clear()
  }
  child.on('error', (error) => failAll(error))
  child.on('exit', () => failAll(new Error('Codex 接口提前退出')))

  return {
    call(method, params) {
      if (exitError) return Promise.reject(exitError)
      const id = ++seq
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      })
    },
    notify(method) {
      if (!exitError) child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`)
    },
    close() {
      child.kill()
    },
  }
}

/**
 * 信任 CodePal 自己的 Codex 钩子
 * @param {object} options
 * @param {string} options.configPath - ~/.codex/config.toml（只认这个来源的钩子）
 * @param {string|null} [options.codexBin] - 不传就自动找
 * @param {object} [options.env]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{trusted: number, alreadyTrusted: number}>}
 */
async function trustCodePalCodexHooks({ configPath, codexBin = findCodexBinary(), env = process.env, timeoutMs = RPC_TIMEOUT_MS }) {
  if (!codexBin) throw new Error('没找到 Codex 程序')
  const server = openAppServer(codexBin, env)
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Codex 接口超时')), timeoutMs)
  })
  const realConfig = (() => {
    try {
      return fs.realpathSync(configPath)
    } catch {
      return configPath
    }
  })()
  const isOurs = (hook) => {
    if (!String(hook?.command || '').includes(CODEX_HOOK_MARK)) return false
    const source = String(hook.sourcePath || '')
    let realSource = source
    try {
      realSource = fs.realpathSync(source)
    } catch {}
    return source === configPath || realSource === realConfig
  }

  try {
    return await Promise.race([timeout, (async () => {
      await server.call('initialize', { clientInfo: { name: 'codepal', title: 'CodePal', version: '1' } })
      server.notify('initialized')
      const listed = await server.call('hooks/list', { cwds: [path.dirname(configPath)] })
      const hooks = (listed?.data || []).flatMap((entry) => entry.hooks || []).filter(isOurs)
      // 同一个钩子可能在多个 cwd 里重复列出，按 key 去重
      const byKey = new Map(hooks.map((hook) => [hook.key, hook]))
      const todo = [...byKey.values()].filter((hook) => hook.trustStatus !== 'trusted')
      if (todo.length) {
        await server.call('config/batchWrite', {
          edits: todo.map((hook) => ({
            keyPath: `hooks.state.${JSON.stringify(hook.key)}`,
            value: { enabled: true, trusted_hash: hook.currentHash },
            mergeStrategy: 'upsert',
          })),
        })
      }
      return { trusted: todo.length, alreadyTrusted: byKey.size - todo.length }
    })()])
  } finally {
    clearTimeout(timer)
    server.close()
  }
}

module.exports = { trustCodePalCodexHooks, findCodexBinary }
