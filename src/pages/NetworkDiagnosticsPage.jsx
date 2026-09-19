/**
 * 网络诊断页（出口 IP）
 *
 * 负责：
 * - 新样式窗口页面壳（PageShell native）：出口 IP 卡 →「监控」持续监控开关 →「IP 变化记录」
 * - 编排 useIpMonitor 的状态与动作，交给 egressView 推导画面
 * - 开关的成功 / 失败 Toast（检测本身不弹 Toast）
 *
 * 设计定稿：specs/redesign-CodePal视觉重做/网络诊断-定稿/
 *
 * @module pages/NetworkDiagnosticsPage
 */

import { useState, useCallback, useEffect } from 'react'
import PageShell from '../components/PageShell'
import { toast } from '../components/Toast'
import Toggle from '../components/Toggle'
import useIpMonitor from '../hooks/useIpMonitor'
import EgressIpCard from './network/EgressIpCard'
import IpChangeLog from './network/IpChangeLog'
import { deriveEgressView } from './network/egressView'
import './network/network.css'

/** 「刚变化」10 分钟后要自己退回「稳定」：页面开着时每 30 秒重算一次 */
const CLOCK_TICK_MS = 30 * 1000

export default function NetworkDiagnosticsPage() {
  const [now, setNow] = useState(() => Date.now())

  const handleToast = useCallback((message, type) => {
    toast.show(message, type)
  }, [])

  const { state, probing, saving, probeOnce, toggle } = useIpMonitor(handleToast)

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS)
    return () => clearInterval(id)
  }, [])

  // 每次拿到新状态都用最新时间推导，避免刚推来的变化被旧时钟判成「10 分钟前」
  useEffect(() => { setNow(Date.now()) }, [state])

  const view = state ? deriveEgressView(state, { now, probing }) : null

  return (
    <PageShell title="网络诊断" native className="nd-page">
      <div className="np-scroll">
        {view && (
          <>
            <EgressIpCard view={view} onCheck={probeOnce} />

            <div className="np-glabel">监控</div>
            <div className="np-card np-card--form">
              <div className="np-row">
                <div className="lf">
                  <div className="lb">持续监控</div>
                  <div className="ds">开启后页面内每 5 秒、后台每 60 秒检测一次</div>
                </div>
                <Toggle checked={Boolean(state.isEnabled)} disabled={saving} onChange={toggle} />
              </div>
            </div>

            <IpChangeLog view={view} />
          </>
        )}
      </div>

    </PageShell>
  )
}
