#!/usr/bin/env node
/**
 * Provider Registry MCP Smoke Test
 *
 * 负责：
 * - 启动本地 provider_registry_mcp 服务进程
 * - 验证 initialize / tools/list / tools/call 关键链路
 * - 输出稳定的 PASS / FAIL 结果，便于排查
 *
 * @module mcp/provider_registry_mcp_smoke
 */

const fs = require('fs/promises')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const SERVER_SCRIPT_PATH = path.resolve(__dirname, 'provider_registry_mcp.js')

/**
 * 构造 MCP framed 消息
 * @param {Object} payload - JSON-RPC payload
 * @returns {Buffer}
 */
function encodeMessage(payload) {
  const raw = Buffer.from(JSON.stringify(payload), 'utf-8')
  const header = Buffer.from(`Content-Length: ${raw.length}\r\n\r\n`, 'ascii')
  return Buffer.concat([header, raw])
}

/**
 * 解析一条 framed 消息
 * @param {Buffer} buffer - 待解析缓冲区
 * @returns {{message: Object, rest: Buffer}|null}
 */
function tryDecodeMessage(buffer) {
  const headerEndRrNn = buffer.indexOf('\r\n\r\n')
  const headerEndNn = buffer.indexOf('\n\n')
  const headerEnd = headerEndRrNn >= 0 ? headerEndRrNn : headerEndNn
  if (headerEnd < 0) return null

  const delimiterLength = headerEndRrNn >= 0 ? 4 : 2
  const headerText = buffer.slice(0, headerEnd).toString('utf-8')
  const lines = headerText.split(/\r?\n/)
  let contentLength = null
  for (const line of lines) {
    const separatorIndex = line.indexOf(':')
    if (separatorIndex === -1) continue
    const key = line.slice(0, separatorIndex).trim().toLowerCase()
    if (key !== 'content-length') continue
    contentLength = Number.parseInt(line.slice(separatorIndex + 1).trim(), 10)
    break
  }
  if (!Number.isInteger(contentLength) || contentLength < 0) {
    throw new Error('Invalid content-length header')
  }

  const bodyStart = headerEnd + delimiterLength
  const bodyEnd = bodyStart + contentLength
  if (buffer.length < bodyEnd) return null

  const bodyText = buffer.slice(bodyStart, bodyEnd).toString('utf-8')
  const message = JSON.parse(bodyText)
  return {
    message,
    rest: buffer.slice(bodyEnd),
  }
}

/**
 * 启动服务并返回进程句柄
 * @param {string} tempRoot - 测试专用根目录
 * @returns {import('child_process').ChildProcessWithoutNullStreams}
 */
function spawnServer(tempRoot) {
  const registryFilePath = path.join(tempRoot, '.provider-manifests.json')
  return spawn(process.execPath, [SERVER_SCRIPT_PATH], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      SKILL_MANAGER_PROVIDER_REGISTRY_PATH: registryFilePath,
    },
  })
}

/**
 * 发送一条 JSON-RPC 请求并等待响应
 * @param {import('child_process').ChildProcessWithoutNullStreams} proc - 服务进程
 * @param {Object} payload - 请求载荷
 * @returns {Promise<Object>}
 */
function sendAndRecv(proc, payload) {
  return new Promise((resolve, reject) => {
    let stdoutBuffer = Buffer.alloc(0)

    const onData = (chunk) => {
      stdoutBuffer = Buffer.concat([stdoutBuffer, chunk])
      try {
        const decoded = tryDecodeMessage(stdoutBuffer)
        if (!decoded) return
        proc.stdout.off('data', onData)
        resolve(decoded.message)
      } catch (error) {
        proc.stdout.off('data', onData)
        reject(error)
      }
    }

    proc.stdout.on('data', onData)
    proc.stdin.write(encodeMessage(payload))
  })
}

/**
 * 执行 smoke 检查
 * @returns {Promise<number>}
 */
async function runSmoke() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-registry-mcp-smoke-'))
  const proc = spawnServer(tempRoot)

  try {
    const initResponse = await sendAndRecv(proc, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    })
    const serverName = initResponse?.result?.serverInfo?.name
    if (serverName !== 'skill-manager-provider-registry') {
      throw new Error(`Unexpected server name: ${serverName}`)
    }

    const toolListResponse = await sendAndRecv(proc, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    })
    const toolNames = (toolListResponse?.result?.tools || []).map((tool) => tool.name)
    const requiredTools = ['register_provider', 'list_providers']
    for (const requiredTool of requiredTools) {
      if (!toolNames.includes(requiredTool)) {
        throw new Error(`Missing tool: ${requiredTool}`)
      }
    }

    const registerResponse = await sendAndRecv(proc, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'register_provider',
        arguments: {
          id: 'neo-proxy',
          name: 'NeoProxy Gateway',
          baseUrl: 'https://api.neoproxy.dev/anthropic',
          tokenEnvKey: 'NEO_PROXY_API_KEY',
          settingsEnv: {
            ANTHROPIC_MODEL: 'neoproxy-opus',
          },
          icon: 'N',
          color: '#2563eb',
        },
      },
    })
    const registerText = registerResponse?.result?.content?.[0]?.text || ''
    const registerResult = JSON.parse(registerText)
    if (!registerResult.success || registerResult.provider?.id !== 'neo-proxy') {
      throw new Error(`register_provider failed: ${registerText}`)
    }

    const listResponse = await sendAndRecv(proc, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'list_providers',
        arguments: {},
      },
    })
    const listText = listResponse?.result?.content?.[0]?.text || ''
    const listResult = JSON.parse(listText)
    if (!listResult.success || !Array.isArray(listResult.providers)) {
      throw new Error(`list_providers failed: ${listText}`)
    }
    if (!listResult.providers.some((provider) => provider.id === 'neo-proxy')) {
      throw new Error(`list_providers missing neo-proxy: ${listText}`)
    }

    const updateResponse = await sendAndRecv(proc, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'register_provider',
        arguments: {
          id: 'neo-proxy',
          name: 'NeoProxy Gateway v2',
          baseUrl: 'https://api.neoproxy.dev/v2/anthropic',
          tokenEnvKey: 'NEO_PROXY_API_KEY',
          settingsEnv: {
            ANTHROPIC_MODEL: 'neoproxy-opus-v2',
          },
          icon: 'N2',
          color: '#1d4ed8',
        },
      },
    })
    const updateText = updateResponse?.result?.content?.[0]?.text || ''
    const updateResult = JSON.parse(updateText)
    if (!updateResult.success || updateResult.mode !== 'updated') {
      throw new Error(`register_provider update failed: ${updateText}`)
    }

    console.log('PASS: provider_registry_mcp is callable (initialize/list/register/list/update).')
    return 0
  } catch (error) {
    console.error(`FAIL: ${error.message}`)
    return 1
  } finally {
    proc.kill('SIGTERM')
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
}

runSmoke().then((code) => {
  process.exitCode = code
})
