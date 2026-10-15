/**
 * 插件管理页的状态（后-06、后-08、后-11〜后-14、后-24、后-25）
 *
 * - 进入页面读一次（超过 10 秒按读取失败）；停在页面上不自动刷新
 * - 点开关：这一行立刻变到目标值并进入「正在保存…」，只传工具和开关值；两行各管各的
 * - 结果：成功弹成功提示；没改成 / 被锁定弹红色提示并退回；别处改过、没确认弹黄色提示并重读这一行
 * - 保存 10 秒还没结果：先提示没确认，这一行保持保存中，等结果回来后重读再按实际值显示
 * - 代次：页面卸载后结果一律作废；一行开始新的保存后，之前开始的读取不覆盖这一行
 * - 再进入页面时主进程说某一边还在保存：那一行显示保存中，每秒查一次，做完按读到的值显示
 *
 * @module features/devPlugin/useDevPlugin
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from '../../components/Toast'

const READ_TIMEOUT_MS = 10000
const SAVE_TIMEOUT_MS = 10000
const POLL_MS = 1000
const TOOLS = ['claude', 'codex']
export const TOOL_NAMES = { claude: 'Claude Code', codex: 'Codex' }
const FILE_LABELS = { claude: '~/.claude/settings.json', codex: '~/.codex/config.toml' }
const READ_TIMEOUT_TEXT = '读不到插件的安装信息：读取超过 10 秒没有结果'
const READ_FAILED_TEXT = '读不到插件的安装信息'

const uncertainText = (tool) => `保存结果没确认：${FILE_LABELS[tool]}，重新打开这页看实际状态`
const savedText = (tool, enabled) => `${TOOL_NAMES[tool]} 已在全局设置里${enabled ? '启用' : '停用'} dev-workflow，新开的会话生效`

/** 主进程给的一边 → 页面上的一行 */
function toRow(side, saving) {
  return { installed: side.installed === true, enabled: side.enabled === true, locked: side.locked === true, saving: saving === true }
}

/**
 * @returns {{status: 'loading'|'error'|'ready', error: string|null, versionText: string, rows: Record<string, object>|null,
 *   retry: () => void, setEnabled: (tool: string, enabled: boolean) => void}}
 */
export default function useDevPlugin() {
  const [view, setView] = useState({ status: 'loading', error: null, versionText: '', rows: null })
  const alive = useRef(true)
  // 每行的操作代次：每点一次开关 +1；读取开始时记下，回来时代次变了就不覆盖这一行
  const ops = useRef({ claude: 0, codex: 0 })
  const busy = useRef({ claude: false, codex: false })
  const timers = useRef(new Set())
  const loadToken = useRef(0)

  const later = useCallback((fn, ms) => {
    const id = setTimeout(() => {
      timers.current.delete(id)
      fn()
    }, ms)
    timers.current.add(id)
    return id
  }, [])
  const cancel = useCallback((id) => {
    clearTimeout(id)
    timers.current.delete(id)
  }, [])

  useEffect(() => {
    alive.current = true
    const pending = timers.current
    return () => {
      alive.current = false
      pending.forEach((id) => clearTimeout(id))
      pending.clear()
    }
  }, [])

  /** 读一次，超过 10 秒按读取失败；tool 给了表示只为这一行重读（主进程只更新这一边的写前身份） */
  const readOnce = useCallback((tool) => new Promise((resolve) => {
    const id = later(() => resolve({ ok: false, message: READ_TIMEOUT_TEXT }), READ_TIMEOUT_MS)
    Promise.resolve()
      .then(() => window.electronAPI.devPluginRead(tool ? { tool } : undefined))
      .then((result) => {
        cancel(id)
        if (result && result.success) resolve({ ok: true, data: result.data })
        else resolve({ ok: false, message: (result && result.error && result.error.message) || READ_FAILED_TEXT })
      }, () => {
        cancel(id)
        resolve({ ok: false, message: READ_FAILED_TEXT })
      })
  }), [later, cancel])

  const showError = useCallback((message) => {
    setView((prev) => ({ ...prev, status: 'error', error: message }))
  }, [])

  const setRow = useCallback((tool, patch) => {
    setView((prev) => (prev.rows ? { ...prev, rows: { ...prev.rows, [tool]: { ...prev.rows[tool], ...patch } } } : prev))
  }, [])

  /** 某一行还在主进程里保存（再进入页面时）：每秒查一次，做完按读到的值显示 */
  const pollRow = useCallback((tool, op) => {
    later(async () => {
      const result = await readOnce(tool)
      if (!alive.current || ops.current[tool] !== op) return
      if (!result.ok) {
        busy.current[tool] = false
        return showError(result.message)
      }
      if (result.data.saving && result.data.saving[tool]) return pollRow(tool, op)
      busy.current[tool] = false
      setRow(tool, toRow(result.data[tool], false))
    }, POLL_MS)
  }, [later, readOnce, setRow, showError])

  /** 只重读并更新一行（别处改过、结果没确认之后） */
  const rereadRow = useCallback(async (tool) => {
    const op = ops.current[tool]
    const result = await readOnce(tool)
    if (!alive.current || ops.current[tool] !== op) return
    if (!result.ok) {
      busy.current[tool] = false
      return showError(result.message)
    }
    const stillSaving = Boolean(result.data.saving && result.data.saving[tool])
    setRow(tool, toRow(result.data[tool], stillSaving))
    if (stillSaving) pollRow(tool, op)
    else busy.current[tool] = false
  }, [readOnce, setRow, showError, pollRow])

  /** 进入页面 / 重试：读两边，整页显示 */
  const load = useCallback(async () => {
    const token = ++loadToken.current
    const startOps = { ...ops.current }
    setView((prev) => (prev.status === 'ready' ? prev : { ...prev, status: 'loading', error: null }))
    const result = await readOnce()
    if (!alive.current || token !== loadToken.current) return
    if (!result.ok) return showError(result.message)
    const { data } = result
    setView((prev) => {
      const rows = {}
      for (const tool of TOOLS) {
        const moved = ops.current[tool] !== startOps[tool]
        rows[tool] = moved && prev.rows ? prev.rows[tool] : toRow(data[tool], data.saving && data.saving[tool])
      }
      return { status: 'ready', error: null, versionText: data.versionText, rows }
    })
    // 这一行用的是本次读取的结果时，是否在保存以主进程说的为准（重试后不会被上一次的保存中卡住）
    for (const tool of TOOLS) {
      if (ops.current[tool] !== startOps[tool]) continue
      busy.current[tool] = Boolean(data.saving && data.saving[tool])
      if (busy.current[tool]) pollRow(tool, ops.current[tool])
    }
  }, [readOnce, showError, pollRow])

  useEffect(() => {
    load()
  }, [load])

  const retry = useCallback(() => {
    setView((prev) => ({ ...prev, status: 'loading', error: null }))
    load()
  }, [load])

  const setEnabled = useCallback(async (tool, enabled) => {
    const row = view.rows && view.rows[tool]
    if (!row || !row.installed || row.locked || row.saving || busy.current[tool]) return
    busy.current[tool] = true
    const op = ++ops.current[tool]
    const original = row.enabled
    setRow(tool, { enabled, saving: true })

    let timedOut = false
    const timer = later(() => {
      if (!alive.current || ops.current[tool] !== op) return
      timedOut = true
      toast.warning(uncertainText(tool))
    }, SAVE_TIMEOUT_MS)

    let result
    try {
      result = await window.electronAPI.devPluginSetEnabled({ tool, enabled })
    } catch {
      result = { success: false, error: { code: 'failed', message: `没改成：${FILE_LABELS[tool]} 写不进去` } }
    }
    cancel(timer)
    if (!alive.current || ops.current[tool] !== op) return

    // 已经提示过没确认：不再宣称成功或失败，重读后按实际值显示
    if (timedOut) return rereadRow(tool)
    if (result && result.success) {
      busy.current[tool] = false
      setRow(tool, { enabled: result.data.enabled, saving: false })
      toast.success(savedText(tool, result.data.enabled))
      return
    }
    const code = result && result.error ? result.error.code : 'failed'
    const message = (result && result.error && result.error.message) || `没改成：${FILE_LABELS[tool]} 写不进去`
    if (code === 'changed' || code === 'uncertain') {
      toast.warning(message)
      return rereadRow(tool)
    }
    busy.current[tool] = false
    setRow(tool, { enabled: original, saving: false })
    toast.error(message)
  }, [view.rows, later, cancel, setRow, rereadRow])

  return { ...view, retry, setEnabled }
}
