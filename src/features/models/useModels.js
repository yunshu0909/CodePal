/**
 * 模型接入页 · 数据与动作
 *
 * 负责：
 * - 进页面、窗口重新激活时读 models:list（配置 + Claude Code 检测 + 终端命令状态）
 * - 后台审核 / 终端写回结果时（models:changed）原地更新那一行和顶上「在终端里用」的状态，不弹 Toast
 * - 存 Key、测一下、加 / 改 / 移除模型、重新检测、安装 / 更新命令、加入 PATH；成功失败的 Toast 在这里统一发
 * - 存 Key、添加、改名成功后自动测一次（AI 补，用户 2026-09-26 认可）
 *
 * @module features/models/useModels
 */

import { createElement, useCallback, useEffect, useRef, useState } from 'react'
import { toast } from '../../components/Toast'
import { confirmDialog } from '../../components/Modal/confirmDialog'
import { PathConfirmBody } from './TerminalStrip'

const api = () => window.electronAPI

/** 写操作的失败原因：没有 message 时给一句兜底 */
const errMessage = (res) => res?.error?.message || '出错了'

/**
 * 模型接入页的状态与动作
 * @returns {object}
 */
export default function useModels() {
  // null = 首次读取中（卡头照常、模型行出骨架）
  const [data, setData] = useState(null)
  // 配置整体读不出时整块显示「读取失败」
  const [loadFailed, setLoadFailed] = useState(false)
  // 正在测的模型：`${providerId}__${modelId}`
  const [testing, setTesting] = useState(() => new Set())
  // 正在移除的模型，同一个键
  const [removing, setRemoving] = useState(() => new Set())
  // 正在安装 / 更新终端命令：'install' | 'update' | null
  const [installing, setInstalling] = useState(null)
  // 加入 PATH 的确认框开着：主按钮让给确认框（定稿 §5 C4）
  const [confirmingPath, setConfirmingPath] = useState(false)
  const [rechecking, setRechecking] = useState(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const reload = useCallback(async () => {
    const res = await api().modelsList()
    if (!mounted.current) return
    if (res?.success) {
      setData(res.data)
      setLoadFailed(false)
    } else {
      setLoadFailed(true)
    }
  }, [])

  /** 用主进程返回的一家数据替换本地那一家；写操作顺带返回的终端命令状态一起换 */
  const applyProvider = useCallback((providerId, provider, commands) => {
    setData((d) => d && ({
      ...d,
      providers: { ...d.providers, [providerId]: provider },
      commands: commands || d.commands,
    }))
  }, [])

  /** 某个模型的最近结果 */
  const applyResult = useCallback((providerId, modelId, lastResult) => {
    setData((d) => {
      const prov = d?.providers?.[providerId]
      if (!prov || !prov.models.some((m) => m.id === modelId)) return d
      const models = prov.models.map((m) => (m.id === modelId ? { ...m, lastResult } : m))
      return { ...d, providers: { ...d.providers, [providerId]: { ...prov, models } } }
    })
  }, [])

  const mark = (setter, key, on) => setter((s) => {
    const next = new Set(s)
    if (on) next.add(key)
    else next.delete(key)
    return next
  })

  const test = useCallback(async (providerId, modelId) => {
    const key = `${providerId}__${modelId}`
    mark(setTesting, key, true)
    try {
      const res = await api().modelsTest({ providerId, modelId })
      if (!mounted.current) return
      if (res?.success) {
        applyResult(providerId, modelId, res.data.lastResult)
        // 测过能用的模型数变了，顶上「在终端里用」那一行跟着变（后-11）
        if (res.data.commands) setData((d) => d && ({ ...d, commands: res.data.commands }))
      } else {
        // 没跑到调用那一步（Claude Code 不见了、Key 读不到）：提示原因并重读检测结果
        toast.error(errMessage(res))
        reload()
      }
    } finally {
      if (mounted.current) mark(setTesting, key, false)
    }
  }, [applyResult, reload])

  /**
   * 存 Key；成功后自动测一次这家的模型
   * @returns {Promise<{ok: boolean, message?: string}>} 失败时 message 留在弹层里
   */
  const saveKey = useCallback(async (providerId, key) => {
    const res = await api().modelsSetKey({ providerId, key })
    if (!res?.success) {
      const code = res?.error?.code
      return { ok: false, message: code === 'invalid_input' ? errMessage(res) : `保存失败：${errMessage(res)}` }
    }
    const { provider, commands } = res.data
    applyProvider(providerId, provider, commands)
    toast.success('Key 已保存')
    for (const m of provider.models) test(providerId, m.id)
    return { ok: true }
  }, [applyProvider, test])

  /**
   * 添加模型；成功后自动测一次
   * @returns {Promise<{ok: boolean, message?: string}>}
   */
  const addModel = useCallback(async (providerId, name) => {
    const res = await api().modelsAddModel({ providerId, name })
    if (!res?.success) {
      const code = res?.error?.code
      return { ok: false, message: code === 'invalid_input' || code === 'duplicate' ? errMessage(res) : `添加失败：${errMessage(res)}` }
    }
    const { provider, commands } = res.data
    applyProvider(providerId, provider, commands)
    toast.success(`已添加 ${name}`)
    const added = provider.models.find((m) => m.name === name)
    if (added) test(providerId, added.id)
    return { ok: true }
  }, [applyProvider, test])

  /**
   * 改模型名或参数；改名成功后自动测一次新名字
   * @param {string} providerId
   * @param {string} modelId
   * @param {object} patch - name / effort / contextTokens / maxOutputTokens
   * @param {(newId: string) => void} [onRenamed] - 改名换了 id 时调用，和数据更新同一批渲染（展开状态跟着走）
   * @returns {Promise<{ok: boolean, model?: object, message?: string, inline?: boolean}>}
   *   inline = 校验类失败，红字留在输入框下；其他失败已弹红 Toast
   */
  const updateModel = useCallback(async (providerId, modelId, patch, onRenamed) => {
    const res = await api().modelsUpdateModel({ providerId, modelId, patch })
    if (!res?.success) {
      const code = res?.error?.code
      if (code === 'invalid_input' || code === 'duplicate') return { ok: false, inline: true, message: errMessage(res) }
      toast.error(`保存失败：${errMessage(res)}`)
      return { ok: false }
    }
    const { model, commands } = res.data
    const renamed = model.id !== modelId
    setData((d) => {
      const prov = d?.providers?.[providerId]
      if (!prov) return d
      // 改名即换 id，旧名字的测试结果不再算数
      const models = prov.models.map((m) => (m.id === modelId ? { ...m, ...model, lastResult: renamed ? null : m.lastResult } : m))
      return { ...d, providers: { ...d.providers, [providerId]: { ...prov, models } }, commands: commands || d.commands }
    })
    if (renamed && onRenamed) onRenamed(model.id)
    toast.success('已保存')
    if ('name' in patch) test(providerId, model.id)
    return { ok: true, model }
  }, [test])

  // 移除在确认对话框里执行：按钮「移除中…」，成功才关框；失败对话框留着 + 红 Toast
  const removeModel = useCallback(async (providerId, model) => {
    const key = `${providerId}__${model.id}`
    await confirmDialog({
      title: `移除 ${model.name}？`,
      description: '移除后审核和终端都不能再用它，Key 不受影响。',
      confirmText: '移除',
      busyText: '移除中…',
      danger: true,
      onConfirm: async () => {
        mark(setRemoving, key, true)
        try {
          const res = await api().modelsRemoveModel({ providerId, modelId: model.id })
          if (res?.success) {
            applyProvider(providerId, res.data.provider, res.data.commands)
            toast.success(`已移除 ${model.name}`)
            return true
          }
          toast.error(`移除失败：${errMessage(res)}`)
          return false
        } finally {
          if (mounted.current) mark(setRemoving, key, false)
        }
      },
    })
  }, [applyProvider])

  const recheckClaude = useCallback(async () => {
    setRechecking(true)
    try {
      const res = await api().modelsRecheckClaude()
      if (mounted.current && res?.success) setData((d) => d && ({ ...d, claudeCode: res.data }))
    } finally {
      if (mounted.current) setRechecking(false)
    }
  }, [])

  /**
   * 安装或更新终端命令（同一个动作，后-10）；只差 Toast 和进行中文字
   * @param {'install'|'update'} [mode='install']
   */
  const installCommands = useCallback(async (mode = 'install') => {
    setInstalling(mode)
    try {
      const res = await api().modelsInstallCommands()
      if (!mounted.current) return
      if (res?.success) {
        toast.success(mode === 'update' ? '已更新终端命令' : '已安装终端命令')
        await reload()
      } else {
        toast.error(errMessage(res))
      }
    } finally {
      if (mounted.current) setInstalling(null)
    }
  }, [reload])

  /**
   * 加入 PATH：先确认改哪个文件、加哪一行（后-13、后-15）。确认后写好就关框再弹 Toast；
   * 写不进也关框、红 Toast、留在差一步；要写的文件在确认期间变了就按新文件重新确认
   * @param {string} profile - 确认框里写的文件（主进程算好的，~ 开头）
   * @param {string|null} [identity] - 这个文件的身份（主进程给的），点「加入」时带回去核对（后-13-例6）
   */
  const addToPath = useCallback(async (profile, identity) => {
    if (!profile) return
    let retarget = null
    setConfirmingPath(true)
    try {
      await confirmDialog({
        title: '把 ~/.local/bin 加入 PATH？',
        description: createElement(PathConfirmBody, { profile }),
        confirmText: '加入',
        cancelText: '取消',
        busyText: '加入中…',
        onConfirm: async () => {
          const res = await api().modelsAddToPath(identity ? { expectedProfile: profile, expectedIdentity: identity } : { expectedProfile: profile })
          if (!mounted.current) return true
          if (!res?.success) {
            if (res?.error?.code === 'target_changed' && res.error.profile) retarget = { profile: res.error.profile, identity: res.error.identity || null }
            else toast.error(errMessage(res))
            return true
          }
          const { profile: written, pathStatus, commands } = res.data
          if (commands) setData((d) => d && ({ ...d, commands }))
          if (pathStatus === 'found') toast.success('已加入 PATH，新开一个终端窗口就能用 codepal')
          else if (pathStatus === 'missing') toast.error(`已写入 ${written}，但终端还是找不到 codepal，看看 shell 配置里有没有改写 PATH`)
          else toast.info(`已写入 ${written}，还没确认终端能不能找到 codepal`)
          return true
        },
      })
    } finally {
      if (mounted.current) setConfirmingPath(false)
    }
    if (retarget && mounted.current) {
      setData((d) => d && ({ ...d, commands: { ...d.commands, profile: retarget.profile, profileIdentity: retarget.identity } }))
      await addToPath(retarget.profile, retarget.identity)
    }
  }, [])

  // 进页面读一次；窗口重新激活时重读（配置可能被命令行改过、Claude Code 可能刚装好）
  useEffect(() => {
    reload()
    const onFocus = () => { reload() }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [reload])

  // 后台审核 / 终端写回结果：原地更新，不弹 Toast
  useEffect(() => {
    const unsubscribe = api().onModelsChanged((change) => {
      applyResult(change.providerId, change.modelId, change.lastResult)
      if (change.commands) setData((d) => d && ({ ...d, commands: change.commands }))
    })
    return () => { if (typeof unsubscribe === 'function') unsubscribe() }
  }, [applyResult])

  return {
    data,
    loadFailed,
    testing,
    removing,
    installing,
    confirmingPath,
    rechecking,
    reload,
    test,
    saveKey,
    addModel,
    updateModel,
    removeModel,
    recheckClaude,
    installCommands,
    addToPath,
  }
}
