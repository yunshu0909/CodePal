#!/usr/bin/env node
/**
 * Provider Registry MCP Server
 *
 * 负责：
 * - 通过 MCP 暴露渠道注册与查询能力（register_provider / list_providers）
 * - 复用 Skill Manager 的渠道校验与注册表持久化逻辑
 * - 统一返回可被 Agent 消费的结构化结果和错误码
 *
 * @module mcp/provider_registry_mcp
 */

const fs = require('fs/promises')
const {
  BUILTIN_PROVIDER_DEFINITIONS,
  buildProviderCards,
  validateProviderManifest,
  createProviderDefinitionFromManifest,
  loadCustomProviderDefinitions,
  saveCustomProviderDefinitions,
} = require('../electron/services/providerRegistryService')
const { resolveProviderRegistryFilePath } = require('../electron/services/providerRegistryPathService')

const SERVER_NAME = 'skill-manager-provider-registry'
const SERVER_VERSION = '0.10.0'
const PROTOCOL_VERSION = '2024-11-05'
const TOOL_REGISTER_PROVIDER = 'register_provider'
const TOOL_LIST_PROVIDERS = 'list_providers'
const REGISTRY_PATH = resolveProviderRegistryFilePath()

let receiveBuffer = Buffer.alloc(0)
let processingQueue = Promise.resolve()
let detectedTransportMode = null

/**
 * 检查路径是否存在
 * @param {string} filePath - 目标路径
 * @returns {Promise<boolean>}
 */
async function pathExists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

/**
 * 读取完整渠道定义（内置 + 自定义）
 * @returns {Promise<{success: boolean, definitions: Record<string, any>, error: string|null, errorCode: string|null}>}
 */
async function loadProviderDefinitions() {
  const definitions = { ...BUILTIN_PROVIDER_DEFINITIONS }
  const customLoadResult = await loadCustomProviderDefinitions({
    registryFilePath: REGISTRY_PATH,
    pathExists,
  })
  if (!customLoadResult.success) {
    return {
      success: false,
      definitions,
      error: customLoadResult.error || '读取渠道注册表失败',
      errorCode: customLoadResult.errorCode || 'REGISTRY_READ_FAILED',
    }
  }

  for (const [providerId, definition] of Object.entries(customLoadResult.definitions)) {
    definitions[providerId] = definition
  }

  return { success: true, definitions, error: null, errorCode: null }
}

/**
 * 执行 register_provider（upsert 语义）
 * @param {Object} argumentsPayload - 工具参数
 * @returns {Promise<Object>}
 */
async function toolRegisterProvider(argumentsPayload) {
  const loadResult = await loadProviderDefinitions()
  if (!loadResult.success) {
    return {
      success: false,
      provider: null,
      mode: null,
      registryPath: REGISTRY_PATH,
      error: loadResult.error,
      errorCode: loadResult.errorCode,
    }
  }

  const currentDefinitions = { ...loadResult.definitions }
  const incomingId = typeof argumentsPayload?.id === 'string' ? argumentsPayload.id.trim() : ''
  const existingDefinition = incomingId ? currentDefinitions[incomingId] : null
  const isUpdate = Boolean(existingDefinition && existingDefinition.source === 'custom')

  const validationDefinitions = { ...currentDefinitions }
  if (isUpdate) {
    // upsert 需要允许同 id 更新，因此先临时移除旧 custom 定义再做冲突校验。
    delete validationDefinitions[incomingId]
  }

  const validationResult = validateProviderManifest(argumentsPayload, validationDefinitions)
  if (!validationResult.success || !validationResult.normalized) {
    return {
      success: false,
      provider: null,
      mode: null,
      registryPath: REGISTRY_PATH,
      error: validationResult.error || '渠道定义校验失败',
      errorCode: validationResult.errorCode || 'INVALID_MANIFEST',
    }
  }

  const { id, definition } = createProviderDefinitionFromManifest(validationResult.normalized)
  currentDefinitions[id] = definition

  const saveResult = await saveCustomProviderDefinitions({
    registryFilePath: REGISTRY_PATH,
    providerDefinitions: currentDefinitions,
  })
  if (!saveResult.success) {
    return {
      success: false,
      provider: null,
      mode: null,
      registryPath: REGISTRY_PATH,
      error: saveResult.error || '写入渠道注册表失败',
      errorCode: saveResult.errorCode || 'REGISTRY_WRITE_FAILED',
    }
  }

  return {
    success: true,
    provider: buildProviderCards({ [id]: definition })[0] || null,
    mode: isUpdate ? 'updated' : 'created',
    registryPath: REGISTRY_PATH,
    error: null,
    errorCode: null,
  }
}

/**
 * 执行 list_providers
 * @returns {Promise<Object>}
 */
async function toolListProviders() {
  const loadResult = await loadProviderDefinitions()
  return {
    success: loadResult.success,
    providers: buildProviderCards(loadResult.definitions),
    registryPath: REGISTRY_PATH,
    error: loadResult.error,
    errorCode: loadResult.errorCode,
  }
}

/**
 * MCP 工具定义列表
 * @returns {Array<Object>}
 */
function mcpToolsDefinition() {
  return [
    {
      name: TOOL_REGISTER_PROVIDER,
      description: 'Register or update a provider definition for Skill Manager API config.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Provider id, e.g. neo-proxy' },
          name: { type: 'string', description: 'Display name' },
          baseUrl: { type: 'string', description: 'Anthropic-compatible endpoint URL' },
          tokenEnvKey: { type: 'string', description: 'Environment variable name for API key' },
          baseUrlEnvKey: { type: 'string', description: 'Optional env key for endpoint override' },
          model: { type: 'string', description: 'Default model name, default opus' },
          settingsEnv: { type: 'object', description: 'Optional env map, only ANTHROPIC_* keys allowed' },
          icon: { type: 'string', description: 'Card icon, length <= 2' },
          color: { type: 'string', description: 'Card color, #RRGGBB' },
          uiUrl: { type: 'string', description: 'Optional display URL in card' },
        },
        required: ['id', 'name', 'baseUrl', 'tokenEnvKey'],
      },
    },
    {
      name: TOOL_LIST_PROVIDERS,
      description: 'List available providers (builtin + custom).',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
  ]
}

/**
 * 工具路由
 * @param {string} toolName - 工具名
 * @param {Object} argumentsPayload - 工具参数
 * @returns {Promise<Object>}
 */
async function toolDispatch(toolName, argumentsPayload) {
  if (toolName === TOOL_REGISTER_PROVIDER) {
    return toolRegisterProvider(argumentsPayload || {})
  }
  if (toolName === TOOL_LIST_PROVIDERS) {
    return toolListProviders()
  }

  throw new Error(`Unknown tool: ${toolName}`)
}

/**
 * 发送一条 MCP framed JSON-RPC 消息
 * @param {Object} message - JSON-RPC payload
 */
function sendMessage(message) {
  const rawJson = JSON.stringify(message, null, 0)

  if (detectedTransportMode === 'ndjson') {
    process.stdout.write(`${rawJson}\n`)
    return
  }

  const raw = Buffer.from(rawJson, 'utf-8')
  const header = Buffer.from(`Content-Length: ${raw.length}\r\n\r\n`, 'ascii')
  process.stdout.write(header)
  process.stdout.write(raw)
}

/**
 * 构造 JSON-RPC 错误响应
 * @param {number|string|null} id - 请求 id
 * @param {number} code - 错误码
 * @param {string} message - 错误消息
 * @param {Object} [data] - 扩展错误数据
 * @returns {Object}
 */
function buildErrorResponse(id, code, message, data = undefined) {
  const payload = {
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code, message },
  }
  if (data !== undefined) {
    payload.error.data = data
  }
  return payload
}

/**
 * 处理一条 JSON-RPC 请求
 * @param {Object} request - 请求 payload
 * @returns {Promise<Object|null>}
 */
async function handleRequest(request) {
  const hasRequestId = Boolean(
    request && typeof request === 'object' && Object.prototype.hasOwnProperty.call(request, 'id')
  )
  const requestId = hasRequestId ? request.id : null
  const isNotification = !hasRequestId
  const method = request?.method
  const params = request?.params || {}

  if (!method || typeof method !== 'string') {
    // 通知消息无 id，不需要响应；请求消息则返回标准错误。
    if (isNotification) return null
    return buildErrorResponse(requestId, -32600, 'Invalid Request')
  }

  if (method === 'initialize') {
    const negotiatedProtocolVersion =
      typeof params.protocolVersion === 'string' && params.protocolVersion.trim().length > 0
        ? params.protocolVersion
        : PROTOCOL_VERSION

    return {
      jsonrpc: '2.0',
      id: requestId,
      result: {
        protocolVersion: negotiatedProtocolVersion,
        serverInfo: {
          name: SERVER_NAME,
          version: SERVER_VERSION,
        },
        capabilities: {
          tools: {
            listChanged: false,
          },
        },
      },
    }
  }

  if (method === 'notifications/initialized') {
    return null
  }

  if (method === 'notifications/cancelled' || method === 'notifications/progress') {
    return null
  }

  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id: requestId,
      result: {
        tools: mcpToolsDefinition(),
      },
    }
  }

  if (method === 'tools/call') {
    const toolName = params?.name
    const toolArgs = params?.arguments || {}
    const toolResult = await toolDispatch(toolName, toolArgs)
    return {
      jsonrpc: '2.0',
      id: requestId,
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify(toolResult, null, 2),
          },
        ],
      },
    }
  }

  if (method === 'ping') {
    return {
      jsonrpc: '2.0',
      id: requestId,
      result: {
        ok: true,
        server: SERVER_NAME,
        version: SERVER_VERSION,
      },
    }
  }

  // 通知消息不要求响应，避免无意义错误帧影响客户端状态机。
  if (isNotification) return null
  return buildErrorResponse(requestId, -32601, `Method not found: ${method}`)
}

/**
 * 解析请求头并提取 Content-Length
 * @param {string} headerText - header 文本
 * @returns {number|null}
 */
function parseContentLength(headerText) {
  const lines = headerText.split(/\r?\n/)
  for (const line of lines) {
    const separatorIndex = line.indexOf(':')
    if (separatorIndex === -1) continue
    const key = line.slice(0, separatorIndex).trim().toLowerCase()
    if (key !== 'content-length') continue
    const rawValue = line.slice(separatorIndex + 1).trim()
    const length = Number.parseInt(rawValue, 10)
    return Number.isFinite(length) && length >= 0 ? length : null
  }
  return null
}

/**
 * 从缓冲区消费完整消息
 * @returns {Promise<void>}
 */
async function drainBufferMessages() {
  while (true) {
    const headerEndRrNn = receiveBuffer.indexOf('\r\n\r\n')
    const headerEndNn = receiveBuffer.indexOf('\n\n')
    const headerEnd = headerEndRrNn >= 0 ? headerEndRrNn : headerEndNn
    let bodyText = null

    if (headerEnd >= 0) {
      if (!detectedTransportMode) {
        detectedTransportMode = 'framed'
      }
      const delimiterLength = headerEndRrNn >= 0 ? 4 : 2
      const headerText = receiveBuffer.slice(0, headerEnd).toString('utf-8')
      const contentLength = parseContentLength(headerText)
      if (contentLength == null) {
        // header 无效时丢弃本段，避免阻塞后续请求。
        receiveBuffer = receiveBuffer.slice(headerEnd + delimiterLength)
        sendMessage(buildErrorResponse(null, -32700, 'Invalid MCP frame: missing content-length'))
        continue
      }

      const bodyStart = headerEnd + delimiterLength
      const bodyEnd = bodyStart + contentLength
      if (receiveBuffer.length < bodyEnd) return

      bodyText = receiveBuffer.slice(bodyStart, bodyEnd).toString('utf-8')
      receiveBuffer = receiveBuffer.slice(bodyEnd)
    } else {
      if (!detectedTransportMode) {
        detectedTransportMode = 'ndjson'
      }
      // 兼容部分客户端使用的 ndjson stdio 传输模式（每行一条 JSON-RPC）。
      const prefix = receiveBuffer.slice(0, Math.min(receiveBuffer.length, 64)).toString('utf-8')
      if (/^\s*content-length\s*:/i.test(prefix)) return

      const lineBreakIndex = receiveBuffer.indexOf('\n')
      if (lineBreakIndex < 0) {
        // 单条 JSON 且没有换行的场景：当整体可解析时直接消费。
        const wholeText = receiveBuffer.toString('utf-8').trim()
        if (!wholeText) {
          receiveBuffer = Buffer.alloc(0)
          return
        }
        try {
          JSON.parse(wholeText)
          bodyText = wholeText
          receiveBuffer = Buffer.alloc(0)
        } catch {
          return
        }
      } else {
        const lineText = receiveBuffer.slice(0, lineBreakIndex).toString('utf-8').trim()
        receiveBuffer = receiveBuffer.slice(lineBreakIndex + 1)
        if (!lineText) continue
        bodyText = lineText
      }
    }

    let requestPayload
    try {
      requestPayload = JSON.parse(bodyText)
    } catch (error) {
      sendMessage(buildErrorResponse(null, -32700, `Parse error: ${error.message}`))
      continue
    }

    const requestList = Array.isArray(requestPayload) ? requestPayload : [requestPayload]
    if (requestList.length === 0) {
      sendMessage(buildErrorResponse(null, -32600, 'Invalid Request'))
      continue
    }

    for (const requestItem of requestList) {
      if (!requestItem || typeof requestItem !== 'object' || Array.isArray(requestItem)) {
        sendMessage(buildErrorResponse(null, -32600, 'Invalid Request'))
        continue
      }

      try {
        const responsePayload = await handleRequest(requestItem)
        if (responsePayload) {
          sendMessage(responsePayload)
        }
      } catch (error) {
        const requestId =
          requestItem && typeof requestItem === 'object' && Object.prototype.hasOwnProperty.call(requestItem, 'id')
            ? requestItem.id
            : null
        sendMessage(
          buildErrorResponse(requestId ?? null, -32000, String(error.message || error))
        )
      }
    }
  }
}

/**
 * 启动 MCP 服务
 */
function startServer() {
  // 显式恢复 stdin 读取，避免在部分宿主环境里 data 事件不触发。
  process.stdin.resume()

  process.stdin.on('data', (chunk) => {
    receiveBuffer = Buffer.concat([receiveBuffer, chunk])
    // 通过串行队列保证请求按到达顺序处理，避免并发写注册表时竞态。
    processingQueue = processingQueue
      .then(() => drainBufferMessages())
      .catch((error) => {
        sendMessage(buildErrorResponse(null, -32000, `Internal server error: ${error.message}`))
      })
  })

  process.stdin.on('error', (error) => {
    process.stderr.write(`[provider_registry_mcp] stdin error: ${error.message}\n`)
  })
}

startServer()
