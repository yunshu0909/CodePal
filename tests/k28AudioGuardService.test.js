/**
 * K28 音频保护服务回归测试
 *
 * 负责：
 * - 验证非 K28 设备会被记录为 last safe
 * - 验证 K28 抢占 output/system 时会切回安全输出
 * - 验证保护关闭和 SwitchAudioSource 缺失的兜底行为
 *
 * @module tests/k28AudioGuardService
 */

import { mkdir, mkdtemp, readFile, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { createRequire } from 'module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { createK28AudioGuardService } = require('../electron/services/k28AudioGuardService')

/**
 * 创建假的 SwitchAudioSource execFile
 * @param {object} state - 可变设备状态
 * @returns {Function}
 */
function createSwitchAudioSourceMock(state) {
  return (_command, args, _options, callback) => {
    if (state.missing) {
      const error = new Error('command not found')
      callback(error, '', 'SwitchAudioSource not found')
      return
    }

    const type = args[1]
    const action = args[2]
    if (action === '-c') {
      callback(null, `${state.devices[type] || ''}\n`, '')
      return
    }
    if (action === '-s') {
      state.devices[type] = args[3]
      callback(null, `${type} audio device set to "${args[3]}"\n`, '')
      return
    }
    callback(new Error(`unexpected args: ${args.join(' ')}`), '', '')
  }
}

/**
 * 创建临时 tts.conf
 * @param {string} content - 配置内容
 * @returns {Promise<{homeDir: string, confPath: string}>}
 */
async function createTempConfig(content) {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'codepal-k28-audio-'))
  const configDir = path.join(homeDir, '.claude', 'k28-status-light')
  await mkdir(configDir, { recursive: true })
  const confPath = path.join(configDir, 'tts.conf')
  await writeFile(confPath, content, 'utf-8')
  return { homeDir, confPath }
}

describe('k28AudioGuardService', () => {
  it('records the current non-K28 output and input as last safe devices', async () => {
    const { homeDir, confPath } = await createTempConfig('AUDIO_GUARD_ENABLED=1\n')
    const fakeSwitch = createSwitchAudioSourceMock({
      devices: {
        output: 'Studio Display',
        system: 'Studio Display',
        input: 'MacBook Air麦克风',
      },
    })
    const service = createK28AudioGuardService({ homeDir, execFileImpl: fakeSwitch })

    const state = await service.checkK28AudioGuard({ fix: true })
    const content = await readFile(confPath, 'utf-8')

    expect(state.isHijacked).toBe(false)
    expect(content).toContain('LAST_SAFE_OUTPUT_DEVICE=Studio Display')
    expect(content).toContain('LAST_SAFE_INPUT_DEVICE=MacBook Air麦克风')
  })

  it('switches K28 output and system output back to the last safe output', async () => {
    const { homeDir } = await createTempConfig([
      'AUDIO_GUARD_ENABLED=1',
      'LAST_SAFE_OUTPUT_DEVICE=Studio Display',
      'OUTPUT_DEVICE=MacBook Air扬声器',
    ].join('\n'))
    const switchState = {
      devices: {
        output: 'ERAZER K28',
        system: 'ERAZER K28',
        input: 'MacBook Air麦克风',
      },
    }
    const service = createK28AudioGuardService({
      homeDir,
      execFileImpl: createSwitchAudioSourceMock(switchState),
    })

    const state = await service.checkK28AudioGuard({ fix: true })

    expect(state.isHijacked).toBe(false)
    expect(switchState.devices.output).toBe('Studio Display')
    expect(switchState.devices.system).toBe('Studio Display')
  })

  it('falls back to OUTPUT_DEVICE when no last safe output exists', async () => {
    const { homeDir } = await createTempConfig([
      'AUDIO_GUARD_ENABLED=1',
      'OUTPUT_DEVICE=MacBook Air扬声器',
    ].join('\n'))
    const switchState = {
      devices: {
        output: 'ERAZER K28',
        system: 'ERAZER K28',
        input: 'ERAZER K28',
      },
    }
    const service = createK28AudioGuardService({
      homeDir,
      execFileImpl: createSwitchAudioSourceMock(switchState),
    })

    const state = await service.checkK28AudioGuard({ fix: true })

    expect(state.currentOutputDevice).toBe('MacBook Air扬声器')
    expect(state.currentSystemOutputDevice).toBe('MacBook Air扬声器')
    expect(state.currentInputDevice).toBe('ERAZER K28')
  })

  it('does not auto-fix when audio guard is disabled', async () => {
    const { homeDir } = await createTempConfig([
      'AUDIO_GUARD_ENABLED=0',
      'LAST_SAFE_OUTPUT_DEVICE=Studio Display',
    ].join('\n'))
    const switchState = {
      devices: {
        output: 'ERAZER K28',
        system: 'ERAZER K28',
        input: 'MacBook Air麦克风',
      },
    }
    const service = createK28AudioGuardService({
      homeDir,
      execFileImpl: createSwitchAudioSourceMock(switchState),
    })

    const state = await service.checkK28AudioGuard({ fix: true })

    expect(state.isHijacked).toBe(true)
    expect(switchState.devices.output).toBe('ERAZER K28')
    expect(switchState.devices.system).toBe('ERAZER K28')
  })

  it('returns an unavailable state when SwitchAudioSource is missing', async () => {
    const { homeDir } = await createTempConfig('AUDIO_GUARD_ENABLED=1\n')
    const service = createK28AudioGuardService({
      homeDir,
      execFileImpl: createSwitchAudioSourceMock({ missing: true, devices: {} }),
    })

    const state = await service.getK28AudioState()

    expect(state.available).toBe(false)
    expect(state.error).toContain('SwitchAudioSource')
  })
})
