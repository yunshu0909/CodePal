/**
 * 网络诊断页面
 *
 * 负责：
 * - PageShell 外壳 + 左右分栏布局
 * - 左栏：公网 IP 监控（IpMonitorCard）
 * - 右栏：API 连通性检测（ApiConnectivityCard）
 * - 统一管理 Toast
 *
 * @module pages/NetworkDiagnosticsPage
 */

import { useState, useCallback } from 'react'
import PageShell from '../components/PageShell'
import Toast from '../components/Toast'
import IpMonitorCard from './network/IpMonitorCard'
import ApiConnectivityCard from './network/ApiConnectivityCard'
import '../styles/network-diagnostics.css'

export default function NetworkDiagnosticsPage() {
  const [toast, setToast] = useState(null)

  const handleToast = useCallback((message, type) => {
    setToast({ message, type })
  }, [])

  return (
    <PageShell
      title="网络诊断"
      subtitle="检测网络环境是否稳定"
      divider
      className="page-shell--no-padding"
    >
      <div className="nd-layout">
        <div className="nd-left">
          <IpMonitorCard onToast={handleToast} />
        </div>
        <div className="nd-right">
          <ApiConnectivityCard onToast={handleToast} />
        </div>
      </div>

      {toast && (
        <Toast
          message={toast.message}
          type={toast.type}
          onClose={() => setToast(null)}
        />
      )}
    </PageShell>
  )
}
