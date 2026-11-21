/**
 * Subscribe before loading so a late IPC response cannot overwrite a newer sample.
 * 切回时先显示上次读到的状态（本次运行内存里，#100）；重读失败沿用页面已有的「状态待核实」样子。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from '../../components/Toast'
import { pageMemory, useRemember } from '../../store/pageMemory'

export default function useClaudeEnvironment() {
  const memory = pageMemory('claude-environment')
  const [state, setState] = useState(() => memory.value ?? null)
  useRemember(memory, state)
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)
  const [probing, setProbing] = useState(false)
  const alive = useRef(false)
  const savePending = useRef(false)
  const probePending = useRef(false)

  const apply = useCallback(value => {
    if (!alive.current || !value) return
    setState(previous => previous && previous.revision > value.revision ? previous : value)
    setError(null)
  }, [])
  const read = useCallback(async () => {
    try {
      const result = await window.electronAPI.claudeEnvironmentRead()
      if (!result?.success) throw Error('READ_FAILED')
      apply(result.data)
    } catch {
      if (alive.current) setError('读不到 Claude 环境状态，请重试')
    }
  }, [apply])

  useEffect(() => {
    alive.current = true
    const off = window.electronAPI?.onClaudeEnvironmentState?.(apply)
    window.electronAPI?.claudeEnvironmentForeground?.(true).catch(() => {})
    read()
    // This refreshes timestamps and local installation facts only; it never starts a probe.
    const timer = setInterval(read, 30000)
    return () => {
      alive.current = false
      off?.()
      clearInterval(timer)
      window.electronAPI?.claudeEnvironmentForeground?.(false).catch(() => {})
    }
  }, [apply, read])

  const probeOnce = useCallback(async () => {
    if (probePending.current) return
    probePending.current = true
    setProbing(true)
    try {
      const result = await window.electronAPI.claudeEnvironmentProbe()
      if (!result?.success) throw Error('PROBE_FAILED')
      apply(result.data)
    } catch {
      if (alive.current) setError('本次检测未完成，请重试')
    } finally {
      probePending.current = false
      if (alive.current) setProbing(false)
    }
  }, [apply])

  const toggle = useCallback(async enabled => {
    if (savePending.current) return
    savePending.current = true
    setSaving(true)
    try {
      const result = await window.electronAPI.claudeEnvironmentSetMonitoring(enabled)
      if (!alive.current) return
      if (result?.success) {
        apply(result.data)
        toast.success(enabled ? '已开启持续监测' : '已关闭持续监测')
      } else toast.error(result?.error?.message || '监测设置没有保存')
    } catch {
      if (alive.current) toast.error('监测设置没有保存，原设置保持不变')
    } finally {
      savePending.current = false
      if (alive.current) setSaving(false)
    }
  }, [apply])

  return { state, error, saving, busy: probing || Boolean(state?.busy), probeOnce, toggle, retry: read }
}
