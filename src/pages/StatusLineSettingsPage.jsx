/**
 * 状态栏设置独立入口。
 * - 复用既有显示设置、额度快照与显式接入/接管流程。
 * - 以默认 PageShell 和现有组件承载，不引入新的视觉规则。
 * @module pages/StatusLineSettingsPage
 */
import ClaudeUsageStatusPage from './ClaudeUsageStatusPage'

/** @returns {JSX.Element} Claude Code 状态栏设置及两种 CLI 的只读额度。 */
export default function StatusLineSettingsPage() {
  return (
    <ClaudeUsageStatusPage
      title="状态栏设置"
    />
  )
}
