/**
 * K28 音频保护服务
 *
 * 负责：
 * - 检测 macOS 当前 output / system / input 音频路由
 * - 记录最近一次非 K28 的安全输出和输入设备
 * - 在 K28 抢占默认音频设备时切回安全设备
 *
 * @module electron/services/k28AudioGuardService
 */

const fs = require('fs/promises')
const path = require('path')
const os = require('os')
const { execFile } = require('child_process')

const DEFAULT_OUTPUT_DEVICE = 'MacBook Air扬声器'
const K28_DEVICE_PATTERN = /K28/i

const DEFAULT_AUDIO_CONFIG = Object.freeze({
  AUDIO_GUARD_ENABLED: '1',
  OUTPUT_DEVICE: DEFAULT_OUTPUT_DEVICE,
  LAST_SAFE_OUTPUT_DEVICE: '',
  LAST_SAFE_INPUT_DEVICE: '',
})

/**
 * 判断设备名是否是 K28 音频设备
 * @param {string|null|undefined} deviceName - 音频设备名
 * @returns {boolean}
 */
function isK28AudioDevice(deviceName) {
  return K28_DEVICE_PATTERN.test(String(deviceName || ''))
}

/**
 * 解析 KEY=VALUE 配置文本
 * @param {string} content - 配置内容
 * @returns {Record<string, string>}
 */
function parseKeyValueConfig(content) {
  const config = {}
  for (const rawLine of String(content || '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || !line.includes('=')) continue
    const index = line.indexOf('=')
    const key = line.slice(0, index).trim()
    const value = line.slice(index + 1).trim()
    if (key) config[key] = value
  }
  return config
}

/**
 * 合并 KEY=VALUE 更新，尽量保留原文件注释和顺序
 * @param {string} rawContent - 原始配置内容
 * @param {Record<string, string>} updates - 待写入字段
 * @returns {string}
 */
function mergeKeyValueUpdates(rawContent, updates) {
  const lines = String(rawContent || '').split(/\r?\n/)
  const seen = new Set()
  const nextLines = lines.map((rawLine) => {
    const trimmed = rawLine.trim()
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) return rawLine
    const index = trimmed.indexOf('=')
    const key = trimmed.slice(0, index).trim()
    if (!Object.prototype.hasOwnProperty.call(updates, key)) return rawLine
    seen.add(key)
    return `${key}=${updates[key] || ''}`
  })

  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) nextLines.push(`${key}=${value || ''}`)
  }

  return `${nextLines.join('\n').replace(/\n*$/, '')}\n`
}

/**
 * 规范化 0/1 开关值
 * @param {unknown} value - 原始值
 * @param {'0'|'1'} fallback - 默认值
 * @returns {'0'|'1'}
 */
function normalizeBooleanFlag(value, fallback = '1') {
  if (value === true || value === '1' || value === 1 || value === 'true') return '1'
  if (value === false || value === '0' || value === 0 || value === 'false') return '0'
  return fallback === '0' ? '0' : '1'
}

/**
 * 创建 K28 音频保护服务实例
 * @param {object} [deps] - 依赖注入，测试使用
 * @param {typeof execFile} [deps.execFileImpl] - child_process.execFile
 * @param {string} [deps.homeDir] - 用户主目录
 * @param {Console} [deps.logger] - 日志对象
 * @returns {object}
 */
function createK28AudioGuardService(deps = {}) {
  const execFileImpl = deps.execFileImpl || execFile
  const homeDir = deps.homeDir || os.homedir()
  const logger = deps.logger || console
  const k28Dir = path.join(homeDir, '.claude', 'k28-status-light')
  const confPath = path.join(k28Dir, 'tts.conf')
  let guardTimer = null
  let lastFixResult = null

  /**
   * 执行 SwitchAudioSource
   * @param {string[]} args - 参数
   * @returns {Promise<{success: boolean, stdout: string, error: string|null}>}
   */
  function runSwitchAudioSource(args) {
    return new Promise((resolve) => {
      execFileImpl('SwitchAudioSource', args, { timeout: 2000 }, (error, stdout, stderr) => {
        if (error) {
          resolve({
            success: false,
            stdout: '',
            error: String(stderr || error.message || 'SwitchAudioSource 执行失败').trim(),
          })
          return
        }
        resolve({ success: true, stdout: String(stdout || '').trim(), error: null })
      })
    })
  }

  /**
   * 读取音频保护相关配置
   * @returns {Promise<Record<string, string>>}
   */
  async function readAudioConfig() {
    try {
      const rawContent = await fs.readFile(confPath, 'utf-8')
      return { ...DEFAULT_AUDIO_CONFIG, ...parseKeyValueConfig(rawContent) }
    } catch (error) {
      if (error.code === 'ENOENT') return { ...DEFAULT_AUDIO_CONFIG }
      throw error
    }
  }

  /**
   * 写入音频保护相关配置
   * @param {Record<string, string>} updates - 配置更新
   * @returns {Promise<void>}
   */
  async function writeAudioConfigUpdates(updates) {
    let rawContent = ''
    try {
      rawContent = await fs.readFile(confPath, 'utf-8')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      return
    }
    await fs.writeFile(confPath, mergeKeyValueUpdates(rawContent, updates), 'utf-8')
  }

  /**
   * 获取指定类型的当前音频设备
   * @param {'output'|'system'|'input'} type - 设备类型
   * @returns {Promise<{success: boolean, device: string|null, error: string|null}>}
   */
  async function getCurrentDevice(type) {
    const result = await runSwitchAudioSource(['-t', type, '-c'])
    return {
      success: result.success,
      device: result.success ? result.stdout || null : null,
      error: result.error,
    }
  }

  /**
   * 设置指定类型的音频设备
   * @param {'output'|'system'|'input'} type - 设备类型
   * @param {string} deviceName - 目标设备
   * @returns {Promise<{success: boolean, error: string|null}>}
   */
  async function setCurrentDevice(type, deviceName) {
    const result = await runSwitchAudioSource(['-t', type, '-s', deviceName])
    return { success: result.success, error: result.error }
  }

  /**
   * 读取三类音频设备快照
   * @returns {Promise<object>}
   */
  async function readAudioSnapshot() {
    const [output, system, input] = await Promise.all([
      getCurrentDevice('output'),
      getCurrentDevice('system'),
      getCurrentDevice('input'),
    ])
    return {
      output,
      system,
      input,
      available: output.success || system.success || input.success,
    }
  }

  /**
   * 选择可用于回切的安全输出设备
   * @param {Record<string, string>} config - 音频配置
   * @returns {string}
   */
  function resolveSafeOutputDevice(config) {
    const candidates = [
      config.LAST_SAFE_OUTPUT_DEVICE,
      config.OUTPUT_DEVICE,
      DEFAULT_OUTPUT_DEVICE,
    ]
    return candidates.find((device) => device && !isK28AudioDevice(device)) || DEFAULT_OUTPUT_DEVICE
  }

  /**
   * 记录当前非 K28 的安全设备
   * @param {Record<string, string>} config - 当前配置
   * @param {object} snapshot - 音频设备快照
   * @returns {Promise<void>}
   */
  async function rememberSafeDevices(config, snapshot) {
    const updates = {}
    const outputDevice = [snapshot.output.device, snapshot.system.device]
      .find((device) => device && !isK28AudioDevice(device))
    const inputDevice = snapshot.input.device
    if (outputDevice && outputDevice !== config.LAST_SAFE_OUTPUT_DEVICE) {
      updates.LAST_SAFE_OUTPUT_DEVICE = outputDevice
    }
    if (inputDevice && !isK28AudioDevice(inputDevice) && inputDevice !== config.LAST_SAFE_INPUT_DEVICE) {
      updates.LAST_SAFE_INPUT_DEVICE = inputDevice
    }
    if (Object.keys(updates).length > 0) {
      await writeAudioConfigUpdates(updates)
      Object.assign(config, updates)
    }
  }

  /**
   * 检查并按需修复 K28 音频抢占
   * @param {{fix?: boolean, force?: boolean}} [options] - fix 表示允许自动修复；force 忽略开关用于手动修复
   * @returns {Promise<object>}
   */
  async function checkK28AudioGuard({ fix = false, force = false } = {}) {
    const config = await readAudioConfig()
    const guardEnabled = normalizeBooleanFlag(config.AUDIO_GUARD_ENABLED, '1') === '1'
    let snapshot = await readAudioSnapshot()
    const errors = [snapshot.output.error, snapshot.system.error, snapshot.input.error].filter(Boolean)

    if (snapshot.available) {
      await rememberSafeDevices(config, snapshot)
    }

    const outputHijacked = isK28AudioDevice(snapshot.output.device)
    const systemHijacked = isK28AudioDevice(snapshot.system.device)
    const inputHijacked = isK28AudioDevice(snapshot.input.device)
    const shouldFix = snapshot.available && fix && (guardEnabled || force)
    const fixed = { output: false, system: false, input: false }
    const fixErrors = []
    const targetOutput = resolveSafeOutputDevice(config)
    const targetInput = config.LAST_SAFE_INPUT_DEVICE && !isK28AudioDevice(config.LAST_SAFE_INPUT_DEVICE)
      ? config.LAST_SAFE_INPUT_DEVICE
      : ''

    if (shouldFix && (outputHijacked || systemHijacked || inputHijacked)) {
      if (outputHijacked) {
        const result = await setCurrentDevice('output', targetOutput)
        fixed.output = result.success
        if (!result.success) fixErrors.push(result.error)
      }
      if (systemHijacked) {
        const result = await setCurrentDevice('system', targetOutput)
        fixed.system = result.success
        if (!result.success) fixErrors.push(result.error)
      }
      if (inputHijacked && targetInput) {
        const result = await setCurrentDevice('input', targetInput)
        fixed.input = result.success
        if (!result.success) fixErrors.push(result.error)
      }

      lastFixResult = {
        at: new Date().toISOString(),
        success: fixErrors.length === 0,
        targetOutput,
        targetInput,
        fixed,
        error: fixErrors.filter(Boolean).join('；') || null,
      }

      snapshot = await readAudioSnapshot()
    }

    return {
      available: snapshot.available,
      guardEnabled,
      currentOutputDevice: snapshot.output.device,
      currentSystemOutputDevice: snapshot.system.device,
      currentInputDevice: snapshot.input.device,
      outputHijacked: isK28AudioDevice(snapshot.output.device),
      systemHijacked: isK28AudioDevice(snapshot.system.device),
      inputHijacked: isK28AudioDevice(snapshot.input.device),
      outputRouteHijacked: isK28AudioDevice(snapshot.output.device)
        || isK28AudioDevice(snapshot.system.device),
      isHijacked: isK28AudioDevice(snapshot.output.device)
        || isK28AudioDevice(snapshot.system.device)
        || isK28AudioDevice(snapshot.input.device),
      lastSafeOutputDevice: config.LAST_SAFE_OUTPUT_DEVICE || '',
      lastSafeInputDevice: config.LAST_SAFE_INPUT_DEVICE || '',
      fallbackOutputDevice: config.OUTPUT_DEVICE || DEFAULT_OUTPUT_DEVICE,
      lastFixResult,
      error: snapshot.available ? null : errors[0] || '未检测到 SwitchAudioSource',
    }
  }

  /**
   * 获取当前音频状态，不主动修复
   * @returns {Promise<object>}
   */
  function getK28AudioState() {
    return checkK28AudioGuard({ fix: false })
  }

  /**
   * 手动修复 K28 音频抢占
   * @returns {Promise<{success: boolean, data: object|null, error: string|null}>}
   */
  async function fixK28AudioOutput() {
    try {
      const state = await checkK28AudioGuard({ fix: true, force: true })
      return {
        success: state.available && !state.outputRouteHijacked,
        data: state,
        error: state.available ? null : state.error,
      }
    } catch (error) {
      return { success: false, data: null, error: error.message }
    }
  }

  /**
   * 启动 CodePal 运行期音频保护轮询
   * @param {{intervalMs?: number}} [options] - 轮询间隔
   * @returns {() => void} 停止函数
   */
  function startK28AudioGuard({ intervalMs = 5000 } = {}) {
    if (guardTimer) return () => stopK28AudioGuard()

    const tick = () => {
      checkK28AudioGuard({ fix: true }).catch((error) => {
        logger.warn?.('[k28-audio-guard] check failed:', error?.message || error)
      })
    }

    tick()
    guardTimer = setInterval(tick, intervalMs)
    guardTimer.unref?.()
    return () => stopK28AudioGuard()
  }

  /**
   * 停止 CodePal 运行期音频保护轮询
   */
  function stopK28AudioGuard() {
    if (guardTimer) {
      clearInterval(guardTimer)
      guardTimer = null
    }
  }

  return {
    checkK28AudioGuard,
    fixK28AudioOutput,
    getK28AudioState,
    startK28AudioGuard,
    stopK28AudioGuard,
    _private: {
      readAudioConfig,
      writeAudioConfigUpdates,
      parseKeyValueConfig,
      mergeKeyValueUpdates,
    },
  }
}

const defaultService = createK28AudioGuardService()

module.exports = {
  ...defaultService,
  createK28AudioGuardService,
  isK28AudioDevice,
}
