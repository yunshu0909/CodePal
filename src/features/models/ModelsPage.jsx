/**
 * 模型接入页
 *
 * 负责：
 * - 新样式页面壳（PageShell native）：被挡住卡（没找到 Claude Code / 终端命令未安装）→ 每家一张供应商卡
 * - 首次读取出骨架；配置整体读不出时整块「读取失败」
 * - 一屏只留一个主按钮（填写 Key > 重新检测 > 安装命令；弹层打开时让给弹层）
 * - 同一时间只开一个弹层
 *
 * 设计定稿：specs/第三方模型接入/模型接入-定稿/
 *
 * @module features/models/ModelsPage
 */

import { useState } from 'react'
import PageShell from '../../components/PageShell'
import StateView from '../../components/StateView/StateView'
import BlockCard from './BlockCard'
import ProviderCard from './ProviderCard'
import useModels from './useModels'
import { PROVIDERS, claudeBlock, commandsBlock, primaryAction } from './modelsView'
import './models.css'

export default function ModelsPage() {
  const models = useModels()
  const { data } = models
  // 开着的弹层：{ providerId, kind: 'key' | 'add' }
  const [popover, setPopover] = useState(null)

  const now = Date.now()
  const primary = data ? primaryAction(data, Boolean(popover)) : null
  const claude = data ? claudeBlock(data.claudeCode) : null
  // 首次没填 Key 时主按钮只给第一张卡
  const firstUnkeyed = data ? PROVIDERS.find((p) => !data.providers?.[p.id]?.keySet)?.id : null

  return (
    <PageShell title="模型接入" native className="mj-page">
      <div className="np-scroll">
        {models.loadFailed ? (
          <StateView error="模型配置文件无法解析，修好或删除它后重试" onRetry={models.reload} />
        ) : (
          <div className="mj-stack">
            {data && (
              <BlockCard
                claude={claude}
                install={commandsBlock(data)}
                primary={primary}
                rechecking={models.rechecking}
                installing={models.installing}
                onRecheck={models.recheckClaude}
                onInstall={models.installCommands}
              />
            )}
            {PROVIDERS.map((preset) => (
              <ProviderCard
                key={preset.id}
                preset={preset}
                provider={data ? (data.providers?.[preset.id] || { keySet: false, keyReadable: false, models: [] }) : null}
                primaryKey={primary === 'key' && firstUnkeyed === preset.id}
                blocked={Boolean(claude)}
                testing={models.testing}
                removing={models.removing}
                commands={data?.commands || null}
                now={now}
                popover={popover?.providerId === preset.id ? popover.kind : null}
                onPopover={(kind) => setPopover(kind ? { providerId: preset.id, kind } : null)}
                actions={models}
              />
            ))}
          </div>
        )}
      </div>
    </PageShell>
  )
}
