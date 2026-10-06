/**
 * 模型汇总（两页签：模型 / 审核规则）
 *
 * 负责页面外壳：工具栏只放页名，页签在工具栏下面、不带数字、默认「模型」；
 * 页签、哪一家展开、高级展开、打开的菜单只在这次打开页面时记住（离开再进入回到默认，窗口回到前台不变）。
 * 两个页签的数据各读各的（useModelHub / useReviewRules），谁坏只影响自己那块。
 *
 * @module features/modelHub/ModelHubPage
 */
import { useState } from 'react'
import PageShell from '../../components/PageShell'
import TabBar from '../../components/TabBar/TabBar'
import useModelHub from './useModelHub'
import useReviewRules from './useReviewRules'
import ModelsTab from './ModelsTab'
import RulesTab from './RulesTab'
import './modelHub.css'

const TABS = [
  { value: 'models', label: '模型' },
  { value: 'rules', label: '审核规则' },
]

/** 模型页签的保存成功时审核配置也已写进去：同步清掉审核规则页签的红字（两页签共用一份审核配置） */
function withExportSync(hub, markExported) {
  const synced = (save) => async (payload) => {
    const result = await save(payload)
    if (result?.success) markExported()
    return result
  }
  return { ...hub, setEnabled: synced(hub.setEnabled), setEffort: synced(hub.setEffort), setOrder: synced(hub.setOrder) }
}

export default function ModelHubPage({ onNavigate }) {
  const rules = useReviewRules()
  const hub = withExportSync(useModelHub(), rules.markExported)
  const [tab, setTab] = useState('models')
  const [open, setOpen] = useState(null)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [menu, setMenu] = useState(null)
  const switchTab = (next) => {
    setMenu(null)
    setTab(next)
  }
  return (
    <PageShell native title="模型汇总" className="mh-page">
      <div className="mh-tabs">
        <TabBar ariaLabel="模型汇总" value={tab} onChange={switchTab} options={TABS} />
      </div>
      <div className="np-scroll">
        {tab === 'models' ? (
          <ModelsTab
            hub={hub}
            selfReview={rules.data?.effective?.selfReview === true}
            {...{ open, setOpen, menu, setMenu, onNavigate }}
          />
        ) : (
          <RulesTab {...{ rules, hub, advancedOpen, setAdvancedOpen, menu, setMenu }} />
        )}
      </div>
    </PageShell>
  )
}
