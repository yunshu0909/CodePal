/**
 * 对话回顾页
 *
 * 负责：
 * - 新样式外壳，页名「对话回顾」在工具栏
 * - 两个画面整页切换：列表页（找 + 认）→ 点一行 → 对话页（读 + 复制 / 启动），「‹ 对话回顾」返回
 * - 状态都在 useSessionBrowser；返回时列表的滚动位置、搜索词、筛选不变
 *
 * 设计事实源：specs/redesign-CodePal视觉重做/对话回顾-定稿/
 *
 * @module pages/SessionBrowserPage
 */

import PageShell from '../components/PageShell'
import useSessionBrowser from '../hooks/useSessionBrowser'
import SessionListView from './sessions/SessionListView'
import SessionDetailView from './sessions/SessionDetailView'
import './sessions/sessions.css'

export default function SessionBrowserPage() {
  const state = useSessionBrowser()
  const { view, back } = state

  return (
    <PageShell title="对话回顾" native className="sr-page">
      {view.page === 'detail'
        ? <SessionDetailView key={`${view.session.projectId}/${view.session.sessionId}`} session={view.session} hit={view.hit} onBack={back} />
        : <SessionListView state={state} />}
    </PageShell>
  )
}
