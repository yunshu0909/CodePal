/**
 * 新建项目页的状态与动作
 *
 * 负责：
 * - 表单四项（名称、放在哪、代码文件夹、Git 档）与 Git 预检
 * - 实时校验：名字非法字符当场判断；同名、路径、撞名等停止输入 0.3 秒后交给主进程判断
 * - 创建、复制路径、浏览选文件夹
 * - 动作行左边那一句话（一个槽位，按优先级只出一条）
 *
 * 主进程通道：checkGitAvailable / validateProjectInit / executeProjectInit / selectFolder（preload 已暴露）。
 *
 * @module pages/projectInit/useProjectInit
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from '../../components/Toast'
import { isValidName, resolveCodeDir } from '../../../shared/projectInitManifest.mjs'
import { DEFAULT_TARGET_PATH, VALIDATE_DEBOUNCE_MS } from './projectInitConstants'

const EMPTY_ERRORS = { projectName: '', targetPath: '', codeDirName: '' }

/**
 * 主进程返回的校验错误按 field 归到对应输入
 * @param {Array<{field?: string, message: string}>} errors
 * @returns {{projectName: string, targetPath: string, codeDirName: string}}
 */
function toFieldErrors(errors) {
  const next = { ...EMPTY_ERRORS }
  for (const error of errors || []) {
    if (error.field && error.field in next && !next[error.field]) next[error.field] = error.message
  }
  return next
}

/**
 * @returns {Object} 页面需要的状态与处理函数
 */
export default function useProjectInit() {
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined
  const [projectName, setProjectName] = useState('')
  const [targetPath, setTargetPath] = useState(DEFAULT_TARGET_PATH)
  const [codeDirName, setCodeDirName] = useState('code')
  const [gitMode, setGitMode] = useState('dual')
  const [gitAvailable, setGitAvailable] = useState(true)
  const [remoteErrors, setRemoteErrors] = useState(EMPTY_ERRORS)
  const [creating, setCreating] = useState(false)
  // 创建结果：{ kind: 'ok' | 'nocommit' | 'fail', path?, text? }；改任何输入就清掉
  const [result, setResult] = useState(null)
  const validateSeq = useRef(0)

  // 进页检测一次 Git；没装就只能跳过
  useEffect(() => {
    let alive = true
    api?.checkGitAvailable?.().then((res) => {
      if (!alive) return
      const available = res?.data?.available !== false
      setGitAvailable(available)
      if (!available) setGitMode('none')
    }).catch(() => {})
    return () => { alive = false }
  }, [api])

  // 名字非法字符当场判断，不等主进程
  const localErrors = useMemo(() => ({
    projectName: projectName.trim() && !isValidName(projectName) ? '项目名称包含非法字符' : '',
    targetPath: '',
    codeDirName: !isValidName(resolveCodeDir(codeDirName)) ? '代码文件夹名包含非法字符' : '',
  }), [projectName, codeDirName])

  // 停止输入 0.3 秒后实时校验；只认最后一次请求的结果
  useEffect(() => {
    if (!api?.validateProjectInit) return undefined
    const seq = ++validateSeq.current
    const timer = setTimeout(async () => {
      try {
        const res = await api.validateProjectInit({ projectName, targetPath, codeDirName, gitMode })
        if (seq !== validateSeq.current) return
        const errors = toFieldErrors(res?.data?.errors)
        // 名称为空时不提名称的错，只提路径和代码文件夹
        if (!projectName.trim()) errors.projectName = ''
        setRemoteErrors(errors)
      } catch {
        if (seq === validateSeq.current) setRemoteErrors(EMPTY_ERRORS)
      }
    }, VALIDATE_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [api, projectName, targetPath, codeDirName, gitMode])

  const fieldErrors = {
    projectName: localErrors.projectName || remoteErrors.projectName,
    targetPath: remoteErrors.targetPath,
    codeDirName: localErrors.codeDirName || remoteErrors.codeDirName,
  }
  const firstError = fieldErrors.projectName || fieldErrors.targetPath || fieldErrors.codeDirName
  const canCreate = Boolean(projectName.trim()) && !firstError && !creating

  /** 改任何输入都清掉上一次的成功 / 失败那句 */
  const edit = useCallback((setter) => (value) => { setResult(null); setter(value) }, [])

  const create = useCallback(async () => {
    if (!canCreate || !api?.executeProjectInit) return
    const name = projectName.trim()
    setCreating(true)
    setResult(null)
    try {
      const res = await api.executeProjectInit({ projectName, targetPath, codeDirName, gitMode })
      if (res?.success) {
        toast.success(`已创建 ${name}`)
        setResult({ kind: res.data?.commit === 'skipped-no-identity' ? 'nocommit' : 'ok', path: res.data?.projectPath })
        setProjectName('')
        return
      }
      if (res?.data?.errors) {
        // 创建前的完整校验没过：落到对应输入，不算一次失败的创建
        setRemoteErrors(toFieldErrors(res.data.errors))
        return
      }
      toast.error('创建失败')
      const { failedStep = '创建项目', reason = '未知错误', rollback } = res?.data || {}
      const tail = rollback && rollback.success === false
        ? `有些文件没能撤回，请检查 ${rollback.path}`
        : '已撤回，没留下文件'
      setResult({ kind: 'fail', text: `${failedStep} 时失败：${reason}。${tail}` })
    } catch (error) {
      toast.error('创建失败')
      setResult({ kind: 'fail', text: `创建项目 时失败：${error?.message || '未知错误'}。已撤回，没留下文件` })
    } finally {
      setCreating(false)
    }
  }, [api, canCreate, projectName, targetPath, codeDirName, gitMode])

  const browse = useCallback(async () => {
    try {
      const res = await api?.selectFolder?.()
      if (res?.success && !res.canceled && res.path) {
        setResult(null)
        setTargetPath(res.path)
      }
    } catch {
      // 系统选文件夹窗口打不开：路径保持不变
    }
  }, [api])

  const copyPath = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(result?.path || '')
      toast.success('已复制路径')
    } catch {
      toast.error('复制失败')
    }
  }, [result])

  /** 动作行左边：创建中 > 失败 > 刚成功 > 输入问题 > 先填项目名称 > 空 */
  let message = null
  if (creating) message = { kind: 'busy', text: '正在创建…' }
  else if (result?.kind === 'fail') message = { kind: 'bad', text: result.text }
  else if (result?.kind === 'ok' || result?.kind === 'nocommit') message = { kind: result.kind, path: result.path }
  else if (firstError) message = { kind: 'bad', text: firstError }
  else if (!projectName.trim()) message = { kind: 'hint', text: '先填项目名称' }

  return {
    values: { projectName, targetPath, codeDirName, gitMode },
    setProjectName: edit(setProjectName),
    setTargetPath: edit(setTargetPath),
    setCodeDirName: edit(setCodeDirName),
    setGitMode: edit(setGitMode),
    gitAvailable,
    fieldErrors,
    creating,
    canCreate,
    message,
    create,
    browse,
    copyPath,
  }
}
