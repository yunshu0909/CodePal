/**
 * API 端点检测结果行
 *
 * 负责：
 * - 展示单个 API 端点的状态徽标 + 耗时指标
 * - 未检测态、可达态、不可达态三种展示
 * - 不可达时显示红色边框 + 错误原因
 *
 * @module pages/network/EndpointResultRow
 */

/**
 * @param {Object} props
 * @param {string} props.name - 端点名称（OpenAI / Anthropic）
 * @param {Object|null} props.result - probeEndpoint 返回值，null 表示未检测
 */
export default function EndpointResultRow({ name, result }) {
  // 未检测态
  if (!result) {
    return (
      <div className="nd-api-item">
        <div className="nd-api-item-header">
          <span className="nd-api-item-name">{name}</span>
          <span className="nd-badge nd-badge--idle">
            <span className="nd-badge-dot"></span>
            未检测
          </span>
        </div>
      </div>
    )
  }

  const isError = !result.reachable
  const errorMessage = buildErrorMessage(result)

  return (
    <div className={`nd-api-item${isError ? ' nd-api-item--error' : ''}`}>
      <div className="nd-api-item-header">
        <span className="nd-api-item-name">{name}</span>
        <span className={`nd-badge ${isError ? 'nd-badge--danger' : 'nd-badge--success'}`}>
          <span className="nd-badge-dot"></span>
          {isError ? '不可达' : '可达'}
        </span>
      </div>
      <div className="nd-api-item-metrics">
        {/* 状态码：仅在 HTTP 有结果时显示 */}
        {result.http.statusCode != null && (
          <span className="nd-api-metric">
            状态码 <span className="nd-api-metric-value">{result.http.statusCode}</span>
          </span>
        )}
        {/* DNS */}
        {result.dns.durationMs != null && (
          <span className="nd-api-metric">
            DNS <span className={`nd-api-metric-value${result.dns.success ? '' : ' nd-api-metric-value--danger'}`}>
              {result.dns.success ? `${Math.round(result.dns.durationMs)}ms` : '失败'}
            </span>
          </span>
        )}
        {/* TLS：DNS 失败时不显示 */}
        {result.dns.success && result.tls.durationMs != null && (
          <span className="nd-api-metric">
            TLS <span className={`nd-api-metric-value${result.tls.success ? '' : ' nd-api-metric-value--danger'}`}>
              {result.tls.success ? `${Math.round(result.tls.durationMs)}ms` : '超时'}
            </span>
          </span>
        )}
        {/* HTTP：TLS 失败时不显示 */}
        {result.dns.success && result.tls.success && result.http.durationMs != null && (
          <span className="nd-api-metric">
            HTTP <span className={`nd-api-metric-value${result.http.success ? '' : ' nd-api-metric-value--danger'}`}>
              {result.http.success ? `${Math.round(result.http.durationMs)}ms` : '失败'}
            </span>
          </span>
        )}
      </div>
      {isError && errorMessage && (
        <div className="nd-api-item-error">{errorMessage}</div>
      )}
    </div>
  )
}

/**
 * 根据三段式结果构建错误描述文案
 * @param {Object} result - probeEndpoint 返回值
 * @returns {string|null}
 */
/**
 * 将技术错误码翻译为用户友好文案
 * @param {string} rawError
 * @returns {string}
 */
function friendlyError(rawError) {
  if (!rawError) return '未知错误'
  if (rawError.includes('ENOTFOUND')) return '域名无法解析，请检查 VPN 是否连接'
  if (rawError.includes('ETIMEOUT') || rawError.includes('TIMEOUT')) return '连接超时，网络可能不稳定'
  if (rawError.includes('EAI_AGAIN')) return '域名查询暂时失败，请稍后重试'
  if (rawError.includes('ECONNREFUSED')) return '连接被拒绝，目标服务可能不可用'
  if (rawError.includes('ECONNRESET') || rawError.includes('socket hang up')) return '连接被中断，网络可能不稳定'
  return '网络连接异常，请检查网络设置'
}

function buildErrorMessage(result) {
  if (!result.dns.success) {
    return friendlyError(result.dns.error)
  }
  if (!result.tls.success) {
    return '加密连接失败，DNS 正常但无法建立安全连接，请检查 VPN 代理设置'
  }
  if (!result.http.success) {
    return friendlyError(result.http.error)
  }
  return null
}
