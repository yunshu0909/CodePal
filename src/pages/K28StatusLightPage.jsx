/**
 * K28 状态灯控制页
 *
 * 负责：
 * - 顶部状态总览：安装/运行状态、活跃 session、当前输出、Key 配置状态
 * - 配置区：状态灯/语音/任务摘要开关（拨动即生效）+ 两个 API Key（行内编辑保存）
 * - 链路自检：黄/红/绿灯与豆包语音测试
 * - 活跃 session 监控与清理
 * - 未安装时引导一键安装/修复
 *
 * 保存模型：开关拨动即时写入 tts.conf；API Key 各自行内保存；无全局保存栏。
 *
 * @module pages/K28StatusLightPage
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import PageShell from '../components/PageShell'
import Button from '../components/Button/Button'
import Toggle from '../components/Toggle'
import Tag from '../components/Tag/Tag'
import StateView from '../components/StateView/StateView'
import Toast from '../components/Toast'
import ApiKeyField from '../components/ApiKeyField/ApiKeyField'
import '../styles/k28-status-light.css'

const LIGHT_TESTS = [
  { id: 'busy', label: '黄灯', description: 'busy / 开始处理任务', tone: 'warning' },
  { id: 'attention', label: '红灯', description: 'attention / 需要用户处理', tone: 'danger' },
  { id: 'done', label: '绿灯', description: 'done / 任务完成', tone: 'success' },
]

const DEFAULT_SWITCHES = Object.freeze({
  STATUS_LIGHT_ENABLED: '1',
  VOICE_ENABLED: '1',
  AUDIO_GUARD_ENABLED: '1',
  TASK_SUMMARY_ENABLED: '1',
})

/**
 * 格式化 Unix 秒级时间戳
 * @param {number} epoch - Unix 秒级时间戳
 * @returns {string}
 */
function formatEpoch(epoch) {
  if (!epoch) return '未知'
  return new Date(epoch * 1000).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * 将 session 状态映射到圆点色调
 * @param {string} state - 状态值
 * @returns {'success'|'danger'|'warning'|'idle'}
 */
function getStateTone(state) {
  if (state === 'done') return 'success'
  if (state === 'attention') return 'danger'
  if (state === 'busy') return 'warning'
  return 'idle'
}

/**
 * 将 session 状态映射到中文名
 * @param {string} state - 状态值
 * @returns {string}
 */
function getStateLabel(state) {
  const labels = { busy: '处理中', done: '完成', attention: '待处理', idle: '待机' }
  return labels[state] || state || '未知'
}

/**
 * K28 状态灯控制页
 * @returns {JSX.Element}
 */
export default function K28StatusLightPage() {
  // 页面初始加载状态
  const [isLoading, setIsLoading] = useState(true)
  // 后端读取失败信息
  const [error, setError] = useState(null)
  // K28 后端状态快照
  const [state, setState] = useState(null)
  // 三个开关当前值（拨动即时保存，乐观更新）
  const [switches, setSwitches] = useState(DEFAULT_SWITCHES)
  // 一键安装/修复进行中
  const [isInstalling, setIsInstalling] = useState(false)
  // 正在测试的灯色状态 id
  const [testingLight, setTestingLight] = useState(null)
  // 正在执行语音测试
  const [isTestingVoice, setIsTestingVoice] = useState(false)
  // 正在清理状态文件
  const [isClearing, setIsClearing] = useState(false)
  // 正在修复 K28 抢占系统音频输出
  const [isFixingAudio, setIsFixingAudio] = useState(false)
  // 正在保存的 Key 字段名
  const [savingKey, setSavingKey] = useState(null)
  // Toast 提示消息
  const [toast, setToast] = useState(null)

  const config = state?.config || {}
  const audio = state?.audio || null
  const activeStates = state?.activeStates || []
  const isInstalled = Boolean(state?.installed)
  const isStatusEnabled = switches.STATUS_LIGHT_ENABLED === '1'
  const isAudioGuardEnabled = switches.AUDIO_GUARD_ENABLED === '1'

  const statusTag = useMemo(() => {
    if (!state) return { tone: 'idle', label: '读取中' }
    if (!isInstalled) return { tone: 'danger', label: '未安装' }
    if (!isStatusEnabled) return { tone: 'idle', label: '已关闭' }
    return { tone: 'success', label: '运行中' }
  }, [isInstalled, isStatusEnabled, state])

  /**
   * 加载 K28 状态灯状态
   * @param {{silent?: boolean}} [options] - silent 时不切换整页 loading
   */
  const loadState = useCallback(async ({ silent = false, syncSwitches = true } = {}) => {
    try {
      if (!silent) setIsLoading(true)
      setError(null)
      const result = await window.electronAPI.getK28StatusLightState()
      if (!result?.success) {
        throw new Error(result?.error || '读取状态灯失败')
      }
      setState(result.data)
      // 自动刷新（syncSwitches=false）只更新只读数据，不回填开关，
      // 避免把用户刚拨动、尚未确认落盘的开关乐观值冲掉
      if (syncSwitches) {
        const nextConfig = result.data?.config || {}
        setSwitches({
          STATUS_LIGHT_ENABLED: nextConfig.STATUS_LIGHT_ENABLED || '1',
          VOICE_ENABLED: nextConfig.VOICE_ENABLED || '1',
          AUDIO_GUARD_ENABLED: nextConfig.AUDIO_GUARD_ENABLED || '1',
          TASK_SUMMARY_ENABLED: nextConfig.TASK_SUMMARY_ENABLED || '1',
        })
      }
    } catch (err) {
      // 静默刷新（轮询/操作后）失败不打断页面、保留现有数据；仅首屏/手动刷新才进错误态
      if (!silent) setError(err?.message || '读取状态灯失败')
    } finally {
      if (!silent) setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    loadState()
  }, [loadState])

  // 自动刷新：每 5 秒静默拉取只读状态（活跃 session / 输出设备 / Key 状态），
  // 不回填开关；离开页面（组件卸载）时自动停止
  useEffect(() => {
    const timer = setInterval(() => {
      loadState({ silent: true, syncSwitches: false })
    }, 5000)
    return () => clearInterval(timer)
  }, [loadState])

  /**
   * 拨动开关：乐观更新并即时写入 tts.conf，失败回滚
   * @param {string} key - 开关字段名
   * @param {boolean} checked - 是否开启
   */
  const handleToggle = async (key, checked) => {
    const next = checked ? '1' : '0'
    const prev = switches[key]
    setSwitches((current) => ({ ...current, [key]: next }))
    try {
      const result = await window.electronAPI.saveK28StatusLightConfig({ [key]: next })
      if (!result?.success) {
        throw new Error(result?.error || '保存失败')
      }
    } catch (err) {
      // 写入失败时回滚开关视觉状态，避免与本机配置不一致
      setSwitches((current) => ({ ...current, [key]: prev }))
      setToast({ message: err?.message || '保存失败', type: 'error' })
    }
  }

  /**
   * 行内保存单个 API Key
   * @param {string} field - VOLC_API_KEY | DEEPSEEK_API_KEY
   * @param {string} value - 新 Key（已 trim）
   * @returns {Promise<boolean>} 是否保存成功
   */
  const handleSaveKey = async (field, value) => {
    try {
      setSavingKey(field)
      const result = await window.electronAPI.saveK28StatusLightConfig({ [field]: value })
      if (!result?.success) {
        throw new Error(result?.error || 'API Key 更新失败')
      }
      setToast({ message: 'API Key 已更新', type: 'success' })
      // 只局部更新 config（含 hasVolcApiKey 等），不走整页 loadState，
      // 避免 setSwitches 覆盖同期拨动开关的乐观值
      setState((prev) => (prev ? { ...prev, config: result.data } : prev))
      return true
    } catch (err) {
      setToast({ message: err?.message || 'API Key 更新失败', type: 'error' })
      return false
    } finally {
      setSavingKey(null)
    }
  }

  /**
   * 一键安装/修复底层 K28 状态灯
   */
  const handleInstall = async () => {
    try {
      setIsInstalling(true)
      if (typeof window.electronAPI?.installK28StatusLight !== 'function') {
        throw new Error('当前窗口还没加载安装接口，请完全退出并重启 CodePal 后再试')
      }
      const result = await window.electronAPI.installK28StatusLight()
      if (!result?.success) {
        throw new Error(result?.error || '安装失败')
      }
      setToast({ message: '安装 / 修复完成', type: 'success' })
      await loadState({ silent: true })
    } catch (err) {
      setToast({ message: err?.message || '安装失败', type: 'error' })
    } finally {
      setIsInstalling(false)
    }
  }

  /**
   * 执行灯色测试
   * @param {string} lightState - K28 状态
   */
  const handleTestLight = async (lightState) => {
    try {
      setTestingLight(lightState)
      const result = await window.electronAPI.testK28Light(lightState)
      if (!result?.success) {
        throw new Error(result?.error || '灯色测试失败')
      }
      setToast({ message: '灯色测试已发送', type: 'success' })
    } catch (err) {
      setToast({ message: err?.message || '灯色测试失败', type: 'error' })
    } finally {
      setTestingLight(null)
    }
  }

  /**
   * 执行语音测试
   */
  const handleTestVoice = async () => {
    try {
      setIsTestingVoice(true)
      const result = await window.electronAPI.testK28Voice('CodePal 语音测试，当前应该使用豆包音色')
      if (!result?.success) {
        throw new Error(result?.error || '语音测试失败')
      }
      setToast({ message: '语音测试已完成', type: 'success' })
    } catch (err) {
      setToast({ message: err?.message || '语音测试失败', type: 'error' })
    } finally {
      setIsTestingVoice(false)
    }
  }

  /**
   * 清理活跃状态文件
   */
  const handleClearStates = async () => {
    try {
      setIsClearing(true)
      const result = await window.electronAPI.clearK28States()
      if (!result?.success) {
        throw new Error(result?.error || '清理失败')
      }
      setToast({ message: '状态已清理', type: 'success' })
      await loadState({ silent: true })
    } catch (err) {
      setToast({ message: err?.message || '清理失败', type: 'error' })
    } finally {
      setIsClearing(false)
    }
  }

  /**
   * 立即修复 K28 抢占系统音频输出
   */
  const handleFixAudio = async () => {
    try {
      setIsFixingAudio(true)
      const result = await window.electronAPI.fixK28AudioOutput()
      if (!result?.success) {
        throw new Error(result?.error || '音频修复失败')
      }
      setToast({ message: '音频输出已修复', type: 'success' })
      await loadState({ silent: true, syncSwitches: false })
    } catch (err) {
      setToast({ message: err?.message || '音频修复失败', type: 'error' })
    } finally {
      setIsFixingAudio(false)
    }
  }

  const isVoiceEnabled = switches.VOICE_ENABLED === '1'
  // 同一时刻只允许一个链路测试在跑（灯色或语音）
  const busyTesting = Boolean(testingLight) || isTestingVoice

  return (
    <PageShell
      title="状态灯"
      subtitle="控制 AI 工作状态灯、豆包语音和本地运行状态"
      divider
      className="page-shell--no-padding"
      actions={(
        <>
          <Button variant="primary" size="sm" onClick={handleInstall} loading={isInstalling}>安装 / 修复</Button>
          <Button variant="secondary" size="sm" onClick={() => loadState({ silent: false })}>刷新</Button>
        </>
      )}
    >
      <StateView loading={isLoading} error={error} onRetry={loadState} loadingMessage="读取状态灯配置...">
        <div className="k28-page">
          <StatusBar
            statusTag={statusTag}
            basePath={state?.basePath || '~/.claude/k28-status-light'}
            installed={isInstalled}
            activeCount={activeStates.length}
            outputDevice={state?.currentOutputDevice}
            audio={audio}
            hasVolcKey={config.hasVolcApiKey}
            hasDeepSeekKey={config.hasDeepSeekApiKey}
          />
          <AudioGuardNotice
            audio={audio}
            guardEnabled={isAudioGuardEnabled}
            fixing={isFixingAudio}
            onFix={handleFixAudio}
            onDisable={() => handleToggle('AUDIO_GUARD_ENABLED', false)}
          />

          {!isInstalled ? (
            <InstallGuide onInstall={handleInstall} installing={isInstalling} />
          ) : (
            <div className="k28-grid">
              <div className="k28-card">
                {!isStatusEnabled && (
                  <div className="k28-card-hint">状态灯已关闭，hook 进入后会直接跳过</div>
                )}
                <div className="k28-card-head">
                  <div>
                    <div className="k28-card-title">配置</div>
                    <div className="k28-card-sub">开关拨动即生效 · API Key 单独保存</div>
                  </div>
                </div>
                <div className="k28-card-body">
                  <SwitchRow
                    title="启用状态灯"
                    desc="关闭后 Claude/Codex hook 直接跳过，不写状态、不渲染屏幕"
                    checked={isStatusEnabled}
                    onChange={(checked) => handleToggle('STATUS_LIGHT_ENABLED', checked)}
                  />
                  <SwitchRow
                    title="启用语音"
                    desc="只控制豆包 TTS 播报，不控制音乐和系统声音"
                    checked={isVoiceEnabled}
                    onChange={(checked) => handleToggle('VOICE_ENABLED', checked)}
                  />
                  <SwitchRow
                    title="保护系统音频"
                    desc="开启后 K28 抢默认输出时，切回最近使用的非 K28 设备"
                    checked={isAudioGuardEnabled}
                    onChange={(checked) => handleToggle('AUDIO_GUARD_ENABLED', checked)}
                  />
                  <SwitchRow
                    title="任务摘要"
                    desc="开启后 busy 时用短任务名，done 时复用同一摘要"
                    checked={switches.TASK_SUMMARY_ENABLED === '1'}
                    onChange={(checked) => handleToggle('TASK_SUMMARY_ENABLED', checked)}
                  />

                  <div className="k28-sep" />

                  <ApiKeyField
                    label="豆包 API Key"
                    configured={Boolean(config.hasVolcApiKey)}
                    saving={savingKey === 'VOLC_API_KEY'}
                    onSave={(value) => handleSaveKey('VOLC_API_KEY', value)}
                  />
                  <ApiKeyField
                    label="DeepSeek API Key"
                    configured={Boolean(config.hasDeepSeekApiKey)}
                    saving={savingKey === 'DEEPSEEK_API_KEY'}
                    onSave={(value) => handleSaveKey('DEEPSEEK_API_KEY', value)}
                  />
                </div>
              </div>

              <div className="k28-col">
                <div className="k28-card">
                  <div className="k28-card-head">
                    <div className="k28-card-title">链路自检</div>
                  </div>
                  <div className="k28-card-body">
                    {LIGHT_TESTS.map((item) => (
                      <div key={item.id} className="k28-row">
                        <div className="k28-row-main">
                          <span className={`k28-dot k28-dot--${item.tone}`} />
                          <div className="k28-row-info">
                            <div className="k28-row-name">{item.label}</div>
                            <div className="k28-row-desc">{item.description}</div>
                          </div>
                        </div>
                        <Button
                          variant="secondary"
                          size="sm"
                          loading={testingLight === item.id}
                          disabled={busyTesting && testingLight !== item.id}
                          onClick={() => handleTestLight(item.id)}
                        >
                          测试
                        </Button>
                      </div>
                    ))}

                    <div className="k28-sep" />

                    <div className="k28-row">
                      <div className="k28-row-main">
                        <span className="k28-dot k28-dot--idle" />
                        <div className="k28-row-info">
                          <div className="k28-row-name">豆包语音</div>
                          <div className="k28-row-desc">播报一段固定文案，验证 TTS 链路</div>
                        </div>
                      </div>
                      <Button
                        variant="secondary"
                        size="sm"
                        loading={isTestingVoice}
                        disabled={!isVoiceEnabled || (busyTesting && !isTestingVoice)}
                        onClick={handleTestVoice}
                      >
                        测试
                      </Button>
                    </div>
                  </div>
                </div>

                <div className="k28-card">
                  <div className="k28-card-head">
                    <div className="k28-card-title">活跃 session</div>
                    <Button variant="ghost" size="sm" onClick={handleClearStates} loading={isClearing}>清理</Button>
                  </div>
                  <div className="k28-card-body">
                    {activeStates.length === 0 ? (
                      <div className="k28-empty">
                        <div>当前没有活跃 session</div>
                        <div className="k28-empty-hint">Claude / Codex 开始工作后会自动出现</div>
                      </div>
                    ) : (
                      <div className="k28-session-scroll">
                        {activeStates.map((item) => (
                          <div key={item.key} className="k28-row">
                            <div className="k28-row-main">
                              <span className={`k28-dot k28-dot--${getStateTone(item.state)}`} />
                              <div className="k28-row-info">
                                <div className="k28-sess-name-row">
                                  <span className="k28-sess-name">{item.name || '未知项目'}</span>
                                  {item.source && (
                                    <span className={`k28-source k28-source--${item.source.toLowerCase()}`}>{item.source}</span>
                                  )}
                                </div>
                                <div className="k28-sess-task">{item.task || '无任务摘要'}</div>
                              </div>
                            </div>
                            <div className="k28-sess-aside">
                              <Tag variant={getStateTone(item.state) === 'idle' ? 'default' : getStateTone(item.state)}>
                                {getStateLabel(item.state)}
                              </Tag>
                              <span className="k28-sess-time">{formatEpoch(item.epoch)}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </StateView>

      {toast && (
        <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />
      )}
    </PageShell>
  )
}

/**
 * 顶部状态总览条
 * @param {Object} props
 * @param {{tone: string, label: string}} props.statusTag - 状态徽标
 * @param {string} props.basePath - 底层目录路径
 * @param {boolean} props.installed - 是否已安装
 * @param {number} props.activeCount - 活跃 session 数
 * @param {string} [props.outputDevice] - 当前输出设备
 * @param {object|null} [props.audio] - 音频保护状态
 * @param {boolean} props.hasVolcKey - 豆包 Key 是否已配置
 * @param {boolean} props.hasDeepSeekKey - DeepSeek Key 是否已配置
 * @returns {JSX.Element}
 */
function StatusBar({ statusTag, basePath, installed, activeCount, outputDevice, audio, hasVolcKey, hasDeepSeekKey }) {
  const audioUnavailable = audio && audio.available === false
  const audioHijacked = Boolean(audio?.outputRouteHijacked)
  const audioLabel = audioUnavailable ? '无法检测' : outputDevice || '未检测到'

  return (
    <div className="k28-statusbar">
      <div className="k28-statusbar-lead">
        <span className={`k28-dot k28-dot--${statusTag.tone}`} />
        <span className="k28-statusbar-state">{statusTag.label}</span>
        <span className="k28-statusbar-path">{basePath}</span>
      </div>
      {installed && (
        <>
          <div className="k28-statusbar-divider" />
          <div className="k28-statusbar-metrics">
            <div className="k28-metric">
              <span className="k28-metric-label">活跃</span>
              <span className="k28-metric-value">{activeCount}</span>
            </div>
            <div className={`k28-metric ${audioHijacked ? 'k28-metric--warning' : ''}`}>
              <span className="k28-metric-label">输出</span>
              <span className="k28-metric-value">{audioLabel}</span>
              {audioHijacked && (
                <Tag variant={audio?.guardEnabled ? 'warning' : 'default'} size="sm">
                  {audio?.guardEnabled ? '需修复' : '保护关闭'}
                </Tag>
              )}
            </div>
            <div className="k28-metric">
              <span className="k28-metric-label">豆包</span>
              <Tag variant={hasVolcKey ? 'success' : 'warning'} size="sm">{hasVolcKey ? '已配置' : '未配置'}</Tag>
            </div>
            <div className="k28-metric">
              <span className="k28-metric-label">DeepSeek</span>
              <Tag variant={hasDeepSeekKey ? 'success' : 'warning'} size="sm">{hasDeepSeekKey ? '已配置' : '未配置'}</Tag>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

/**
 * K28 音频抢占提示条
 * @param {Object} props
 * @param {object|null} props.audio - 音频保护状态
 * @param {boolean} props.guardEnabled - 音频保护是否开启
 * @param {boolean} props.fixing - 是否正在修复
 * @param {() => void} props.onFix - 手动修复回调
 * @param {() => void} props.onDisable - 关闭保护回调
 * @returns {JSX.Element|null}
 */
function AudioGuardNotice({ audio, guardEnabled, fixing, onFix, onDisable }) {
  if (!audio) return null

  if (audio.available === false) {
    return (
      <div className="k28-audio-notice k28-audio-notice--muted">
        <div>
          <div className="k28-audio-notice-title">无法检测系统音频输出</div>
          <div className="k28-audio-notice-desc">未找到 SwitchAudioSource，状态灯仍可用，但不能自动防止 K28 抢声音</div>
        </div>
      </div>
    )
  }

  if (!audio.outputRouteHijacked || !guardEnabled) return null

  const target = audio.lastSafeOutputDevice || audio.fallbackOutputDevice || 'MacBook Air扬声器'
  return (
    <div className="k28-audio-notice">
      <div>
        <div className="k28-audio-notice-title">K28 正在占用系统音频</div>
        <div className="k28-audio-notice-desc">音乐和系统声音可能会从 K28 输出，可切回 {target}</div>
      </div>
      <div className="k28-audio-notice-actions">
        <Button variant="secondary" size="sm" onClick={onFix} loading={fixing}>修复</Button>
        <Button variant="ghost" size="sm" onClick={onDisable}>关闭保护</Button>
      </div>
    </div>
  )
}

/**
 * 未安装引导卡
 * @param {Object} props
 * @param {() => void} props.onInstall - 安装回调
 * @param {boolean} props.installing - 安装中
 * @returns {JSX.Element}
 */
function InstallGuide({ onInstall, installing }) {
  return (
    <div className="k28-install">
      <div className="k28-install-title">尚未安装状态灯</div>
      <div className="k28-install-text">点「安装 / 修复」将完成本机部署：</div>
      <ul className="k28-install-steps">
        <li>部署脚本到 <span className="k28-mono">~/.claude/k28-status-light</span></li>
        <li>创建 Python venv 并安装 <span className="k28-mono">bleak</span></li>
        <li>写入 Claude / Codex hooks（改动前自动备份）</li>
      </ul>
      <Button variant="primary" onClick={onInstall} loading={installing}>安装 / 修复</Button>
      <div className="k28-install-hint">安装后可在此控制开关、API Key 与链路自检</div>
    </div>
  )
}

/**
 * 开关行
 * @param {Object} props
 * @param {string} props.title - 标题
 * @param {string} props.desc - 说明
 * @param {boolean} props.checked - 是否开启
 * @param {(checked: boolean) => void} props.onChange - 变更回调
 * @returns {JSX.Element}
 */
function SwitchRow({ title, desc, checked, onChange }) {
  return (
    <div className="k28-switch">
      <div className="k28-switch-info">
        <div className="k28-switch-name">{title}</div>
        <div className="k28-switch-desc">{desc}</div>
      </div>
      <Toggle checked={checked} onChange={onChange} />
    </div>
  )
}
