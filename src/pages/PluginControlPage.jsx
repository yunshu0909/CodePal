/**
 * Plugin 控制中心页面
 *
 * 负责双端 Plugin 盘点、筛选、详情及官方生命周期操作。
 *
 * @module pages/PluginControlPage
 */

import React, { useMemo, useState } from 'react'
import PageShell from '../components/PageShell'
import Button from '../components/Button/Button'
import SearchInput from '../components/SearchInput/SearchInput'
import StateView from '../components/StateView/StateView'
import Modal from '../components/Modal/Modal'
import Tag from '../components/Tag/Tag'
import Toast from '../components/Toast'
import usePluginControl from '../hooks/usePluginControl'
import '../styles/plugin-control.css'

const FILTERS = [
  ['installed', '已安装'],
  ['all', '全部'],
  ['codex', 'Codex'],
  ['claude-code', 'Claude'],
  ['updates', '可更新'],
]

function capabilityText(capabilities = {}) {
  const labels = [
    ['skills', 'Skills'], ['commands', 'Commands'], ['mcp', 'MCP'],
    ['hooks', 'Hooks'], ['connectors', 'Connectors'], ['agents', 'Agents'],
  ]
  const values = labels.filter(([key]) => capabilities[key] > 0).map(([key, label]) => `${capabilities[key]} ${label}`)
  return values.length ? values.join(' · ') : '未声明组件'
}

function toolLabel(toolId) {
  return toolId === 'codex' ? 'Codex' : 'Claude Code'
}

export default function PluginControlPage() {
  const { status, snapshot, pendingKeys, refresh, execute } = usePluginControl()
  const [filter, setFilter] = useState('installed')
  const [query, setQuery] = useState('')
  const [details, setDetails] = useState(null)
  const [installOpen, setInstallOpen] = useState(false)
  const [installForm, setInstallForm] = useState({ toolId: 'codex', pluginId: '', scope: 'user' })
  const [toast, setToast] = useState(null)

  const plugins = useMemo(() => (snapshot?.plugins || []).filter((plugin) => {
    if (filter === 'installed' && !plugin.installed) return false
    if ((filter === 'codex' || filter === 'claude-code') && plugin.toolId !== filter) return false
    if (filter === 'updates' && !plugin.updateAvailable) return false
    if (query.trim()) {
      const needle = query.trim().toLowerCase()
      return [plugin.name, plugin.id, plugin.marketplace, plugin.description].some((value) => value?.toLowerCase().includes(needle))
    }
    return true
  }), [snapshot, filter, query])

  const runAction = async (plugin, action) => {
    if (action === 'uninstall' && !window.confirm(`卸载 ${plugin.name}？Plugin 的运行能力将从 ${toolLabel(plugin.toolId)} 移除。`)) return
    const result = await execute({ pluginId: plugin.id, toolId: plugin.toolId, action, scope: plugin.scope || 'user' })
    if (result.success) {
      setDetails(null)
      setToast(result.verified === false
        ? { type: 'warning', message: '命令已完成，但目标工具状态重读失败，请稍后刷新确认' }
        : { type: 'success', message: action === 'update' ? '更新完成，重启工具后应用新版本' : '操作完成，已按工具原生状态刷新' })
    } else if (result.error === 'PLUGIN_MANAGED_OR_PROTECTED') {
      setToast({ type: 'warning', message: '该 Plugin 由工具或管理员管理，不能在 CodePal 中修改' })
    } else if (result.error === 'AUTH_REQUIRED') {
      setToast({ type: 'warning', message: '请先在对应工具中完成认证，再重试此操作' })
    } else if (result.error === 'PLUGIN_NOT_FOUND') {
      setToast({ type: 'warning', message: '工具已找不到该 Plugin，正在等待下一次状态刷新' })
    } else setToast({ type: 'error', message: '操作失败，原状态已保留' })
  }

  const install = async () => {
    const result = await execute({ ...installForm, action: 'install' })
    if (result.success) {
      setInstallOpen(false)
      setInstallForm((previous) => ({ ...previous, pluginId: '' }))
      setToast({ type: 'success', message: 'Plugin 已安装，状态已重新读取' })
    } else setToast({ type: 'error', message: '安装失败，请检查 marketplace 与 Plugin 名称' })
  }

  const fatalError = status === 'error'
    ? <><strong>Plugin 状态读取失败</strong><br /><span>没有修改任何 Plugin</span></>
    : null
  const unavailableTools = Object.values(snapshot?.tools || {}).filter((tool) => !tool.available)

  return (
    <PageShell
      title="Plugin 控制中心"
      subtitle="统一管理 Codex 与 Claude Code Plugin；安装来源仅限已配置 marketplace"
      className="page-shell--no-padding plugin-control-page"
      actions={<Button variant="primary" size="sm" onClick={() => setInstallOpen(true)}>安装 Plugin</Button>}
    >
      <StateView
        loading={status === 'loading'}
        loadingMessage="正在读取真实 Plugin 状态"
        error={fatalError}
        onRetry={refresh}
        empty={status === 'ready' && (snapshot?.plugins || []).length === 0}
        emptyMessage="还没有可管理的 Plugin"
        emptyHint="从已配置 marketplace 安装"
      >
        <>
          <div className="plugin-summary">
            <div><strong>{snapshot?.summary?.installed || 0}</strong><span>已安装</span></div>
            <div><strong>{snapshot?.summary?.enabled || 0}</strong><span>已启用</span></div>
            <div><strong>{snapshot?.summary?.updates || 0}</strong><span>可更新</span></div>
            <div><strong>{snapshot?.summary?.available || 0}</strong><span>可安装</span></div>
          </div>

          <div className="plugin-toolbar">
            <div className="plugin-filters" aria-label="Plugin 筛选">
              {FILTERS.map(([id, label]) => <button key={id} type="button" className={filter === id ? 'is-active' : ''} onClick={() => setFilter(id)}>{label}</button>)}
            </div>
            <SearchInput value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 Plugin" />
          </div>

          {unavailableTools.length > 0 && <div className="plugin-partial">{unavailableTools.map((tool) => tool.name).join('、')} CLI 暂时不可用，其他数据仍可管理</div>}

          <div className="plugin-table">
            <div className="plugin-row plugin-row--header"><div>Plugin</div><div>工具</div><div>状态</div><div>版本</div><div>来源</div><div>能力</div><div /></div>
            {plugins.length === 0 ? <div className="plugin-filter-empty">没有符合当前条件的 Plugin</div> : plugins.map((plugin) => {
              const pending = pendingKeys.has(`${plugin.toolId}:${plugin.id}`)
              return (
                <div className="plugin-row" key={`${plugin.toolId}:${plugin.id}`}>
                  <div className="plugin-name"><strong>{plugin.name}</strong><span>{plugin.id}</span></div>
                  <div><Tag variant={plugin.toolId === 'codex' ? 'warning' : 'info'}>{toolLabel(plugin.toolId)}</Tag></div>
                  <div><Tag variant={plugin.installed && plugin.enabled ? 'success' : 'default'}>{plugin.installed ? (plugin.enabled ? '已启用' : '已停用') : '未安装'}</Tag></div>
                  <div>{plugin.version}</div>
                  <div className="plugin-source" title={plugin.marketplace}>{plugin.marketplace}</div>
                  <div className="plugin-capabilities">{capabilityText(plugin.capabilities)}</div>
                  <div className="plugin-actions">
                    <Button variant="ghost" size="sm" disabled={pending} aria-label={`查看 ${plugin.name} 详情`} onClick={() => setDetails(plugin)}>详情</Button>
                    {plugin.installed ? (
                      <>
                        <Button variant="secondary" size="sm" disabled={pending} onClick={() => runAction(plugin, plugin.enabled ? 'disable' : 'enable')}>{pending ? '处理中' : plugin.enabled ? '停用' : '启用'}</Button>
                        {plugin.toolId === 'claude-code' && plugin.updateAvailable && <Button variant="secondary" size="sm" disabled={pending} onClick={() => runAction(plugin, 'update')}>更新</Button>}
                        <Button variant="danger" size="sm" disabled={pending} aria-label={`卸载 ${plugin.name}`} onClick={() => runAction(plugin, 'uninstall')}>卸载</Button>
                      </>
                    ) : <Button variant="primary" size="sm" disabled={pending} onClick={() => runAction(plugin, 'install')}>安装</Button>}
                  </div>
                </div>
              )
            })}
          </div>
          <footer className="plugin-footer">状态来自 Codex / Claude 官方 CLI；CodePal 不编辑 Plugin cache 或外部账号凭证</footer>
        </>
      </StateView>

      <Modal open={Boolean(details)} onClose={() => setDetails(null)} title="Plugin 详情" size="md">
        {details && <div className="plugin-details">
          <div><span>Plugin</span><strong>{details.id}</strong></div>
          <div><span>工具</span><strong>{toolLabel(details.toolId)}</strong></div>
          <div><span>版本</span><strong>{details.version}</strong></div>
          <div><span>Marketplace</span><strong>{details.marketplace}</strong></div>
          <div><span>Scope</span><strong>{details.scope}</strong></div>
          <div><span>组件</span><strong>{capabilityText(details.capabilities)}</strong></div>
          <div><span>Auth policy</span><strong>{details.auth?.policy || 'UNKNOWN'}</strong></div>
          <p>认证状态仅展示，不在 CodePal 内代办第三方登录或连接。</p>
        </div>}
      </Modal>

      <Modal
        open={installOpen}
        onClose={() => setInstallOpen(false)}
        title="安装 Plugin"
        size="sm"
        footer={<><Button variant="secondary" onClick={() => setInstallOpen(false)}>取消</Button><Button variant="primary" disabled={!installForm.pluginId.trim()} onClick={install}>安装</Button></>}
      >
        <div className="plugin-install-form">
          <label>工具<select value={installForm.toolId} onChange={(event) => setInstallForm((previous) => ({ ...previous, toolId: event.target.value }))}><option value="codex">Codex</option><option value="claude-code">Claude Code</option></select></label>
          <label>Plugin ID<input value={installForm.pluginId} onChange={(event) => setInstallForm((previous) => ({ ...previous, pluginId: event.target.value }))} placeholder="plugin@marketplace" /></label>
          {installForm.toolId === 'claude-code' && <label>Scope<select value={installForm.scope} onChange={(event) => setInstallForm((previous) => ({ ...previous, scope: event.target.value }))}><option value="user">user</option><option value="project">project</option><option value="local">local</option></select></label>}
          <p>仅使用工具中已配置的 marketplace；本页不新增或修改 marketplace。</p>
        </div>
      </Modal>

      {toast && <Toast {...toast} onClose={() => setToast(null)} />}
    </PageShell>
  )
}
