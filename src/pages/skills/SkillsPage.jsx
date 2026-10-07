/**
 * Skill 管理页（Native+ 双栏，照签收定稿 specs/skills-redesign/Skill管理-定稿/）
 *
 * 负责：
 * - 读快照（useSkillControl）与近 30 天次数（useSkillUsage），编排左栏列表与右栏总览 / 详情
 * - 开关、删除、重新读取；结果一律走全局 toast，删除与撤回连带确认走 confirmDialog
 * - 开关失败的三种结局：已保留原状态 / 已按实际状态显示 / 当前状态读不出
 * - Skills 要处理（v2.1.11，照定稿 specs/v2.1.10-Skills要处理与收进/Skills要处理-定稿/）：要处理的详情、收进确认框、
 *   忽略、撤回、继续恢复、取消忽略，以及装载总览下的收进记录 / 已忽略 / 找到的项目三个视图；
 *   各种结果（done / done-unverified / not-run / rolled-back / partial / needs-confirm）的提示与之后选中谁（E1–E3）
 * - 键盘：左栏 ↑↓（在 SkillList）、⌘F 聚焦搜索、Esc 清除搜索
 *
 * @module pages/skills/SkillsPage
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import PageShell from '../../components/PageShell'
import { toast, notifyToast } from '../../components/Toast'
import { confirmDialog } from '../../components/Modal/confirmDialog'
import useSkillControl from '../../hooks/useSkillControl'
import useSkillUsage from '../../hooks/useSkillUsage'
import SkillList from './SkillList'
import SkillOverview from './SkillOverview'
import SkillDetail from './SkillDetail'
import InboxDetail from './InboxDetail'
import CollectDialog from './CollectDialog'
import RecentOpsView from './RecentOpsView'
import IgnoredView from './IgnoredView'
import ProjectsView from './ProjectsView'
import {
  OVERVIEW_ID,
  TOOLS,
  VIEW_IDS,
  buildGroups,
  collectTargetOf,
  groupOfSelected,
  gateCollectTarget,
  inboxId,
  inboxItemsOf,
  inboxNameOf,
  isExternal,
  isOverviewLike,
  latestOperation,
  needsUsageFallback,
  resolveTab,
  tabOfGroup,
  tabOptionsOf,
  toolStatus,
  undoReasonText,
  usageIdentityOf,
  visibleTabsOf,
} from './skillsModel'
import './skills.css'

const TOOL_LABEL = Object.fromEntries(TOOLS.map((tool) => [tool.id, tool.label]))

/** 命令返回的新快照里，这个名字还在要处理里吗 */
function stillInInbox(result, name) {
  return inboxItemsOf(result?.snapshot || result?.data?.snapshot || null).some((item) => item.name === name)
}

/**
 * @param {string|null} skillName - 当前普通 Skill；空值不发请求。
 * @param {string|number} refreshToken - 显式刷新代次。
 * @param {object} usage - 当前聚合中该项的真实身份。
 * @param {string|null} batchId - 明细必须绑定当前聚合批次。
 * @param {'loading'|'error'|'ready'} usageStatus - 聚合读取状态。
 * @returns {object} 记录读取状态和同批记录；刷新/切换立即隐藏旧记录，迟到响应不得回写。
 */
function useRecords(skillName, refreshToken, usage, batchId, usageStatus) {
  const api = typeof window !== 'undefined' ? window.electronAPI : null
  const modern = Boolean(api?.skillUsageRecords)
  const key = JSON.stringify([skillName, refreshToken, modern ? batchId : null])
  const [records, setRecords] = useState({ status: 'idle', records: [], key: null })
  useEffect(() => {
    const query = modern ? api.skillUsageRecords : api?.listSkillRunSamples
    if (!skillName || !query) {
      setRecords({ status: 'idle', records: [], key })
      return undefined
    }
    if (modern && (!batchId || usageStatus === 'loading')) {
      setRecords({ status: 'loading', records: [], key })
      return undefined
    }
    if (modern && !usage?.assetId) {
      setRecords({ status: 'ready', records: [], key })
      return undefined
    }
    let cancelled = false
    setRecords({ status: 'loading', records: [], key })
    const options = modern ? { assetId: usage?.assetId, batchId, windowDays: 30 } : { skillName, windowDays: 30 }
    query(options).then((result) => {
      if (cancelled) return
      const matched = !modern || result?.data?.batchId === batchId
      setRecords(result?.success && matched ? { status: 'ready', records: result.data?.records || [], key } : { status: 'error', records: [], key })
    }).catch(() => {
      if (!cancelled) setRecords({ status: 'error', records: [], key })
    })
    return () => {
      cancelled = true
    }
  }, [api, key, modern, skillName, batchId, usage?.assetId, usageStatus])
  return records.key === key ? records : { status: skillName ? 'loading' : 'idle', records: [] }
}

/**
 * @param {object} props
 * @param {number} [props.refreshSignal=0] - 外部触发的重读
 * @returns {JSX.Element}
 */
export default function SkillsPage({ refreshSignal = 0 }) {
  const {
    status,
    snapshot,
    pendingKeys,
    selectedId,
    setSelectedId,
    query,
    setQuery,
    refreshState,
    refresh,
    execute,
    setActivation,
  } = useSkillControl(refreshSignal)
  const [usageToken, setUsageToken] = useState(0)
  const [collectTarget, setCollectTarget] = useState(null)
  const searchRef = useRef(null)

  const skills = snapshot?.skills || []
  const inbox = useMemo(() => inboxItemsOf(snapshot), [snapshot])
  const usageNames = useMemo(
    () => skills.filter((skill) => skill.managed || isExternal(skill)).map((skill) => skill.name).sort(),
    [skills],
  )
  const identity = useMemo(() => usageIdentityOf(skills), [skills])
  const refreshGeneration = `${usageToken}:${refreshSignal}`
  const { status: usageStatus, usageMap, batchId } = useSkillUsage(usageNames, 30, refreshGeneration, identity)
  const usageFailed = usageStatus === 'error'
  const groupFallback = needsUsageFallback(skills, usageMap, usageStatus)
  const groups = useMemo(() => buildGroups(skills, { usageMap, usageFailed: groupFallback, query: query.trim(), inbox }), [skills, usageMap, groupFallback, query, inbox])
  // 左栏页签（2026-10-03 用户定）：出哪几个按不带搜索词的分组算；次数没读到时分不出在用 / 没用，先不定
  const baseGroups = useMemo(() => buildGroups(skills, { usageMap, usageFailed: groupFallback, inbox }), [skills, usageMap, groupFallback, inbox])
  const usageReady = usageStatus !== 'loading'
  const searching = Boolean(query.trim())
  const [chosenTab, setChosenTab] = useState(null)
  const visibleTabs = useMemo(() => visibleTabsOf(baseGroups, groupFallback), [baseGroups, groupFallback])
  const tab = snapshot ? resolveTab(chosenTab, baseGroups, groupFallback) : null
  const tabOptions = useMemo(() => tabOptionsOf(visibleTabs, groups), [visibleTabs, groups])
  const selectedInboxName = inboxNameOf(selectedId)
  const selectedItem = selectedInboxName ? inbox.find((item) => item.name === selectedInboxName) || null : null
  const selectedSkill = isOverviewLike(selectedId) || selectedInboxName ? null : skills.find((skill) => skill.name === selectedId) || null
  const records = useRecords(selectedSkill && (selectedSkill.managed || isExternal(selectedSkill)) ? selectedSkill.name : null, refreshGeneration, usageMap.get(selectedSkill?.name), batchId, usageStatus)
  // 详情沿用全局提示，避免为后台读取新增详情布局。
  useEffect(() => {
    if (selectedSkill && refreshState === 'error') toast.error('读取失败，下面是上次读到的结果')
  }, [selectedSkill, refreshState])

  // 选中的没了：要处理的一条处理完了 → 资产库里有它就跟过去，没有回总览；Skill 删了 → 回总览
  useEffect(() => {
    if (!snapshot || isOverviewLike(selectedId)) return
    if (selectedInboxName) {
      if (inbox.some((item) => item.name === selectedInboxName)) return
      setSelectedId(skills.some((skill) => skill.name === selectedInboxName && skill.managed) ? selectedInboxName : OVERVIEW_ID)
      return
    }
    if (!skills.some((skill) => skill.name === selectedId)) setSelectedId(OVERVIEW_ID)
  }, [snapshot, skills, inbox, selectedId, selectedInboxName, setSelectedId])

  // 第一次读到（含次数）时定下停在哪：有要处理先停要处理；之后要处理清空也不自己跳回来
  useEffect(() => {
    if (tab && usageReady && chosenTab === null) setChosenTab(tab)
  }, [tab, usageReady, chosenTab])

  // 选中项换了（收进后跟到资产库那条、总览点「要处理」、搜索里选中后清掉搜索）：页签跟过去，让选中的那行看得见。
  // 只在选中项、搜索、读到与否变化时跟；后台刷新不把用户自己点的页签拉回去
  const groupsRef = useRef(baseGroups)
  groupsRef.current = baseGroups
  const ready = Boolean(snapshot) && usageReady
  useEffect(() => {
    if (searching || !ready) return
    const groupId = groupOfSelected(groupsRef.current, selectedId)
    const next = groupId ? tabOfGroup(groupId, visibleTabsOf(groupsRef.current, groupFallback)) : null
    if (next) setChosenTab(next)
  }, [selectedId, searching, ready, groupFallback])

  // ⌘F / Ctrl+F 聚焦搜索框
  useEffect(() => {
    const onKey = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const handleRefresh = useCallback(async () => {
    setUsageToken((token) => token + 1)
    await refresh({ silent: true })
  }, [refresh])

  const handleToggle = useCallback(async (skill, toolId, enabled) => {
    const label = TOOL_LABEL[toolId]
    const source = skill.origins?.find((origin) => origin.toolId === toolId && origin.mutable)
    const result = await setActivation({ skillName: skill.name, toolId, enabled, source })
    if (result.success) {
      toast.success(`已在 ${label} ${enabled ? '启用' : '停用'} ${skill.displayName || skill.name}`)
      return
    }
    if (result.error === 'STATE_UNKNOWN') {
      // 状态不确定：按重新读到的实际显示；这个工具还是读不出就明说
      let latest = result.snapshot || null
      if (!latest) {
        const reread = await refresh({ silent: true })
        latest = reread.success ? reread.data : null
      }
      const readable = latest && toolStatus(latest, toolId) === 'ok'
        && latest.skills?.find((item) => item.name === skill.name)?.tools?.[toolId]?.state !== 'unavailable'
      toast.error(readable ? '操作失败，已按实际状态显示' : '操作失败，当前状态读不出')
      return
    }
    toast.error(result.error === 'PERMISSION_DENIED' ? '操作失败，请检查工具目录权限' : '操作失败，已保留原状态')
  }, [setActivation, refresh])

  // 收进：确认框里点「收进」→ 执行 → 按结果关框、提示、决定选中谁（定稿 C3、C4、C14、E2）
  const handleCollect = useCallback(async (item, copy, keep) => {
    const result = await execute({
      action: 'collect',
      skillName: item.name,
      toolId: copy.toolId,
      sourceId: copy.sourceId,
      keep,
      expect: { sourceDigest: copy.digest, libraryDigest: item.libraryDigest ?? null },
      pendingKey: `${item.name}:collect:${copy.sourceId}`,
    })
    const outcome = result?.data?.outcome
    // 没执行：确认框留着（C4 ①）。内容变了：按返回的新快照更新框里的这一份和资产库版本，清空选择（C14）；
    // 位置被占：写收不了；其余可重试的写原因
    if (!result.success && outcome === 'not-run') {
      if (result.error === 'CONTENT_CHANGED') {
        let latest = result.snapshot || result.data?.snapshot || null
        if (!latest) {
          const reread = await refresh({ silent: true })
          latest = reread?.success ? reread.data : null
        }
        const fresh = latest ? collectTargetOf(latest, item.name, copy.sourceId) : { item, copy }
        if (!fresh) return { close: false, notice: { kind: 'retry', code: 'SOURCE_NOT_FOUND' } }
        setCollectTarget(fresh)
        return { close: false, notice: { kind: 'changed' } }
      }
      if (result.error === 'SLOT_OCCUPIED') return { close: false, notice: { kind: 'blocked' } }
      return { close: false, notice: { kind: 'retry', code: result.error } }
    }
    setCollectTarget(null)
    if (result.success && outcome === 'done-unverified') {
      notifyToast({ message: '已收进，但状态没读出来，请点「重新读取」', type: 'warning' })
    } else if (result.success) {
      toast.success(`已从 ${TOOL_LABEL[copy.toolId]} 收进资产库：${item.name}`)
      if (!stillInInbox(result, item.name)) setSelectedId(item.name)
    } else if (outcome === 'partial') {
      toast.error('收进没做完，也没能全部恢复；请点「继续恢复」')
    } else {
      toast.error('收进失败，已恢复原样')
    }
    return { close: true }
  }, [execute, refresh, setSelectedId])

  // 忽略一份：点即生效；这个名字处理完时选中要处理里的下一个（定稿 C5、E2）
  const handleIgnore = useCallback(async (item, copy) => {
    const order = inbox.map((entry) => entry.name)
    const result = await execute({ action: 'ignore', skillName: item.name, sourceId: copy.sourceId, pendingKey: `${item.name}:ignore:${copy.sourceId}` })
    if (!result.success) {
      toast.error('操作失败，已保留原状态')
      return
    }
    if (stillInInbox(result, item.name)) {
      toast.success('已忽略 1 份')
      return
    }
    toast.success(`已忽略 ${item.name}`)
    const remaining = inboxItemsOf(result.snapshot || result.data?.snapshot)
    const after = order.slice(order.indexOf(item.name) + 1).find((name) => remaining.some((entry) => entry.name === name))
    const next = after || remaining[0]?.name
    setSelectedId(next ? inboxId(next) : OVERVIEW_ID)
  }, [execute, inbox, setSelectedId])

  // 撤回：连带别的工具时先确认（定稿 C6、C7、C23）
  const handleUndo = useCallback(async (op) => {
    const run = (confirmed) => execute({
      action: 'undo',
      skillName: op.name,
      operationId: op.operationId,
      ...(confirmed ? { confirmed: true } : {}),
      pendingKey: `${op.name}:undo:${op.operationId}`,
    })
    let result = await run(false)
    if (result.success && result.data?.outcome === 'needs-confirm') {
      const tools = (result.data.needsConfirm?.toolIds || []).map((toolId) => TOOL_LABEL[toolId]).join('、')
      const ok = await confirmDialog({
        title: `撤回 ${op.name}？`,
        description: `${tools} 后来也打开了它。撤回后资产库里没有这一份了，${tools} 里也会没有它。`,
        confirmText: '撤回',
      })
      if (!ok) return
      result = await run(true)
    }
    if (result.success) {
      toast.success(`已撤回 ${op.name}，原件放回原处`)
      if (stillInInbox(result, op.name)) setSelectedId(inboxId(op.name))
      return
    }
    if (result.data?.outcome === 'partial') {
      toast.error('撤回没做完；请点「继续恢复」')
      return
    }
    // 撤不了：什么都没动，原因写在卡和收进记录上（定稿 C7，不另弹提示）；别的失败照原文提示
    if (!result.data?.reason) toast.error('操作失败，已保留原状态')
  }, [execute, setSelectedId])

  // 继续恢复没做完的收进或撤回（定稿 C20）
  const handleResume = useCallback(async (op) => {
    const result = await execute({ action: 'resume', skillName: op.name, operationId: op.operationId, pendingKey: `${op.name}:resume:${op.operationId}` })
    if (result.success) {
      toast.success('已恢复到收进之前')
      return
    }
    toast.error(`恢复停住了：${undoReasonText(result.data?.reason, op.from?.toolId)}`)
  }, [execute])

  // 取消忽略：按范围重新判断（定稿 C8）
  const handleUnignore = useCallback(async (entry) => {
    const result = await execute({ action: 'unignore', skillName: entry.name, ignoreId: entry.ignoreId, pendingKey: `${entry.name}:unignore:${entry.ignoreId}` })
    if (!result.success) {
      toast.error('操作失败，已保留原状态')
      return
    }
    const reason = result.data?.reason
    if (reason === 'source-gone') notifyToast({ message: '这一份已经不在了，已删掉忽略记录', type: 'warning' })
    else if (reason === 'same-as-library') toast.success('已取消忽略；它和资产库一样，可以在它的「启用」里换成链接')
    else toast.success('已取消忽略，回到要处理')
    const left = (result.snapshot || result.data?.snapshot)?.ignored
    if (Array.isArray(left) && left.length === 0) setSelectedId(OVERVIEW_ID)
  }, [execute, setSelectedId])

  // 资产库已有的详情里「换成链接」：就是收进占着位置的那一份（一样的那种确认框）
  const openGateCollect = useCallback((skill, toolId) => {
    const gate = skill.gate?.[toolId]
    if (!gate?.copy) return
    setCollectTarget(gateCollectTarget(skill.name, gate))
  }, [])

  const openFirstInbox = useCallback(() => {
    if (inbox[0]) setSelectedId(inboxId(inbox[0].name))
  }, [inbox, setSelectedId])

  const handleDelete = useCallback(async (skill) => {
    const tools = TOOLS.filter((tool) => (skill.locations || []).some((location) => location.toolId === tool.id)).map((tool) => tool.label)
    const description = tools.length > 0
      ? `资产库里的和 ${tools.join(' 和 ')} 里的都会删掉，不能撤销。`
      : '资产库里的会被删掉，不能撤销。'
    let outcome = null
    const confirmed = await confirmDialog({
      title: `删除 ${skill.name}？`,
      description,
      confirmText: '删除',
      danger: true,
      busyText: '删除中…',
      onConfirm: async () => {
        outcome = await execute({ skillName: skill.name, toolId: 'all', action: 'delete' })
        return true
      },
    })
    if (!confirmed || !outcome) return
    if (outcome.success) {
      setSelectedId(OVERVIEW_ID)
      toast.success(`已删除 ${skill.name}`)
      return
    }
    toast.error('删除失败，什么都没改')
  }, [execute, setSelectedId])

  const loading = status === 'loading' && !snapshot
  const failed = status === 'error' && !snapshot

  let detail
  if (failed) {
    detail = <div className="np-pane np-pane--detail"><div className="np-pane-empty">选一个 Skill 查看</div></div>
  } else if (selectedId === VIEW_IDS.recent) {
    detail = <RecentOpsView operations={snapshot?.operations || []} pendingKeys={pendingKeys} onUndo={handleUndo} onResume={handleResume} />
  } else if (selectedId === VIEW_IDS.ignored) {
    detail = <IgnoredView ignored={snapshot?.ignored || []} pendingKeys={pendingKeys} onUnignore={handleUnignore} />
  } else if (selectedId === VIEW_IDS.projects) {
    detail = <ProjectsView projects={snapshot?.projects} />
  } else if (selectedItem) {
    const libraryEntry = skills.find((skill) => skill.name === selectedItem.name && skill.managed) || null
    const op = latestOperation(snapshot, selectedItem.name)
    detail = (
      <InboxDetail
        item={selectedItem}
        skill={libraryEntry}
        snapshot={snapshot}
        op={op}
        pendingKeys={pendingKeys}
        onCollect={(copy) => setCollectTarget({ item: selectedItem, copy })}
        onIgnore={(copy) => handleIgnore(selectedItem, copy)}
        onUndo={() => op && handleUndo(op)}
        onResume={() => op && handleResume(op)}
        onToggle={(toolId, enabled) => libraryEntry && handleToggle(libraryEntry, toolId, enabled)}
        onFixGate={(toolId) => libraryEntry && openGateCollect(libraryEntry, toolId)}
      />
    )
  } else if (selectedSkill) {
    const op = latestOperation(snapshot, selectedSkill.name)
    detail = (
      <SkillDetail
        skill={selectedSkill}
        snapshot={snapshot}
        usage={usageMap.get(selectedSkill.name)}
        usageFailed={usageFailed}
        usageStatus={usageStatus}
        onRetryUsage={() => setUsageToken((token) => token + 1)}
        records={records}
        pluginNames={selectedSkill.managed ? selectedSkill.plugins || [] : []}
        pendingKeys={pendingKeys}
        onToggle={(toolId, enabled) => handleToggle(selectedSkill, toolId, enabled)}
        onFixGate={(toolId) => openGateCollect(selectedSkill, toolId)}
        op={op}
        showNext={inbox.length > 0 && !inbox.some((item) => item.name === selectedSkill.name)}
        onUndo={() => op && handleUndo(op)}
        onResume={() => op && handleResume(op)}
        onNext={openFirstInbox}
        onDelete={() => handleDelete(selectedSkill)}
      />
    )
  } else {
    detail = (
      <SkillOverview
        snapshot={snapshot}
        loading={loading}
        refreshState={refreshState}
        onRefresh={handleRefresh}
        onSelect={setSelectedId}
        onOpenInbox={openFirstInbox}
        onOpenView={(view) => setSelectedId(VIEW_IDS[view])}
      />
    )
  }

  return (
    <PageShell title="Skills" native className="sk-page">
      <div className="np-split">
        <SkillList
          status={status}
          snapshot={snapshot}
          groups={groups}
          tabs={usageReady ? tabOptions : null}
          tab={tab}
          onTabChange={setChosenTab}
          selectedId={selectedId}
          onSelect={setSelectedId}
          query={query}
          onQueryChange={setQuery}
          usageMap={usageMap}
          usageFailed={usageFailed}
          usageStatus={usageStatus}
          onRetry={() => refresh()}
          searchRef={searchRef}
        />
        {detail}
      </div>
      {collectTarget && (
        <CollectDialog
          item={collectTarget.item}
          copy={collectTarget.copy}
          firstCollect={snapshot?.central?.exists === false}
          libraryDisplay={snapshot?.central?.displayPath}
          onCancel={() => setCollectTarget(null)}
          onConfirm={(keep) => handleCollect(collectTarget.item, collectTarget.copy, keep)}
        />
      )}
    </PageShell>
  )
}
