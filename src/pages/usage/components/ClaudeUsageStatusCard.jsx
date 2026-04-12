/**
 * Claude Code 会员额度状态卡片
 *
 * 负责：
 * - 展示 Claude Code 会员额度接入状态与 5h/7d 水平进度条
 * - 按固定颜色断点(60/85)渲染进度条,与状态栏脚本严格对齐
 * - 提供显示模式 radio 单选组 + 阈值输入的配置表单
 * - 覆盖 9 种渲染态:主态/等待首个数据/账号无额度数据/配置冲突/未接入/
 *   未安装 Claude Code/接入失败/读取异常/off 模式
 *
 * @module pages/usage/components/ClaudeUsageStatusCard
 */

import Button from '../../../components/Button/Button'
import './ClaudeUsageStatusCard.css'

// 颜色断点与 `electron/services/claudeUsageStatusService.js` 的 color_pct 严格对齐
// 修改这里时务必同步修改脚本的 Python 部分,避免终端和 UI 不一致
const PCT_WARNING_THRESHOLD = 60
const PCT_DANGER_THRESHOLD = 85

/**
 * 根据百分比返回对应的色阶类名后缀
 * @param {number|null|undefined} value - 已用百分比
 * @returns {'success'|'warning'|'danger'|'dim'}
 */
function pctColorClass(value) {
  const num = Number(value)
  if (!Number.isFinite(num)) return 'dim'
  if (num < PCT_WARNING_THRESHOLD) return 'success'
  if (num < PCT_DANGER_THRESHOLD) return 'warning'
  return 'danger'
}

/**
 * 格式化重置时间为展示文案
 * @param {number|string|null|undefined} unixSeconds - Unix 秒时间戳
 * @returns {{remaining: string, absolute: string}}
 */
function formatResetTime(unixSeconds) {
  if (!unixSeconds) return { remaining: '--', absolute: '' }
  const date = new Date(Number(unixSeconds) * 1000)
  if (Number.isNaN(date.getTime())) return { remaining: '--', absolute: '' }

  const diffMs = Math.max(0, date.getTime() - Date.now())
  const totalMinutes = Math.floor(diffMs / 60000)
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60

  let remaining
  if (days > 0) {
    remaining = `${days} 天 ${hours}h`
  } else if (hours > 0) {
    remaining = `${hours}h ${String(minutes).padStart(2, '0')}m`
  } else {
    remaining = `${minutes}m`
  }

  // 超过 1 天时显示星期+时间（如"周三 08:00"），否则只显示时间
  const absolute = days > 0
    ? date.toLocaleString('zh-CN', {
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
    : date.toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })

  return { remaining, absolute }
}

/**
 * 格式化快照更新时间
 * @param {number|string|null|undefined} unixSeconds - Unix 秒时间戳
 * @returns {string}
 */
function formatUpdatedAt(unixSeconds) {
  if (!unixSeconds) return '尚未同步'
  const date = new Date(Number(unixSeconds) * 1000)
  if (Number.isNaN(date.getTime())) return '尚未同步'
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

/**
 * 派生渲染态 — 从后端返回的 statusState 推导出精确的 UI 分支
 *
 * 后端 integrationState 枚举：ready / waiting_for_data / conflict / not_configured / not_installed / setup_failed
 * 前端在此基础上进一步细分：
 * - waiting_for_data + snapshot.updatedAt 存在 → 'no_rate_limits'(账号无额度数据)
 * - ready + config.displayMode='off' → 'off_with_data'(仅视觉差异,数据仍展示)
 * - error 存在且没有 statusState → 'read_error'(前端 IPC 读取异常)
 *
 * @param {object|null} statusState - 后端返回的状态对象
 * @param {string|null} error - 前端捕获的错误信息
 * @returns {string} 精确渲染态名
 */
function deriveRenderState(statusState, error) {
  if (error && !statusState) return 'read_error'
  if (!statusState) return 'read_error'

  const integration = statusState.integrationState || 'not_configured'
  const snapshot = statusState.snapshot
  const config = statusState.config

  if (integration === 'waiting_for_data') {
    // 脚本已跑过但 hasRateLimits=false → 账号无额度数据(非 Max / 第三方后端)
    if (snapshot?.updatedAt) return 'no_rate_limits'
    // 快照还没写过 → 真·等待首个数据
    return 'waiting_first_data'
  }

  if (integration === 'ready') {
    if (config?.displayMode === 'off') return 'off_with_data'
    // 快照过期判断：updatedAt 距今超过 15 分钟视为 stale
    // off 模式下不触发（off 已明确提示"数据照常同步"，不与 stale 叠加）
    const STALE_MS = 15 * 60 * 1000
    if (snapshot?.updatedAt && (Date.now() - Number(snapshot.updatedAt) * 1000) > STALE_MS) {
      return 'stale'
    }
  }

  return integration
}

/**
 * 状态到徽标(variant, label)的映射
 * @param {string} renderState - 派生渲染态
 * @returns {{variant: string, label: string}}
 */
function getBadge(renderState) {
  switch (renderState) {
    case 'ready':
    case 'off_with_data':
      return { variant: 'ready', label: '已接入' }
    case 'stale':
      return { variant: 'waiting', label: '数据过期' }
    case 'waiting_first_data':
      return { variant: 'waiting', label: '等待数据' }
    case 'no_rate_limits':
      return { variant: 'waiting', label: '无额度数据' }
    case 'conflict':
      return { variant: 'conflict', label: '检测到自定义配置' }
    case 'not_configured':
      return { variant: 'waiting', label: '尚未接入' }
    case 'not_installed':
      return { variant: 'absent', label: '未安装 Claude Code' }
    case 'setup_failed':
      return { variant: 'failed', label: '接入失败' }
    case 'read_error':
      return { variant: 'failed', label: '读取异常' }
    default:
      return { variant: 'absent', label: '未知状态' }
  }
}

/**
 * 渲染 5h/7d 数据行
 * @param {string} label - 标签(5 小时额度 / 7 天额度)
 * @param {number|null|undefined} pct - 已用百分比
 * @param {number|null|undefined} resetsAt - 重置时间 unix 秒
 * @returns {JSX.Element}
 */
function UsageRow({ label, pct, resetsAt }) {
  const colorClass = pctColorClass(pct)
  const hasValue = Number.isFinite(Number(pct))
  const width = hasValue ? Math.min(100, Math.max(0, Number(pct))) : 0
  const reset = formatResetTime(resetsAt)

  return (
    <div className="claude-status-row">
      <div className="claude-status-row__head">
        <span className="claude-status-row__label">{label}</span>
        <strong className={`claude-status-row__pct claude-status-row__pct--${colorClass}`}>
          {hasValue ? `${Math.round(Number(pct))}%` : '--'}
        </strong>
      </div>
      <div className="claude-status-row__bar">
        <div
          className={`claude-status-row__fill claude-status-row__fill--${hasValue ? colorClass : 'success'}`}
          style={{ width: `${width}%` }}
        />
      </div>
      {hasValue && (
        <div className="claude-status-row__meta">
          距重置 <strong>{reset.remaining}</strong>
          {reset.absolute && <> · 将于 {reset.absolute} 重置</>}
        </div>
      )}
    </div>
  )
}

/**
 * 渲染主卡的数据体(两条水平进度条)
 * @param {object} snapshot - 快照数据
 * @returns {JSX.Element}
 */
function DataBody({ snapshot }) {
  return (
    <div className="claude-status-card__body">
      <UsageRow
        label="5 小时额度"
        pct={snapshot?.fiveHourUsedPercentage}
        resetsAt={snapshot?.resetsAt}
      />
      <UsageRow
        label="7 天额度"
        pct={snapshot?.sevenDayUsedPercentage}
        resetsAt={snapshot?.sevenDayResetsAt}
      />
    </div>
  )
}

/**
 * 渲染空态/引导态(用于 waiting / no_rate_limits / not_installed / conflict / setup_failed / read_error)
 * @param {object} props - 空态配置
 * @returns {JSX.Element}
 */
function EmptyBody({
  icon,
  iconVariant = 'neutral',
  title,
  desc,
  reasons,
  primaryLabel,
  onPrimary,
  primaryLoading = false,
  hint,
}) {
  return (
    <div className="claude-status-empty">
      <div className={`claude-status-empty__icon claude-status-empty__icon--${iconVariant}`}>
        {icon}
      </div>
      <div className="claude-status-empty__title">{title}</div>
      {desc && <div className="claude-status-empty__desc">{desc}</div>}
      {reasons && <div className="claude-status-empty__reasons">{reasons}</div>}
      {primaryLabel && (
        <div className="claude-status-empty__actions">
          <Button variant="primary" onClick={onPrimary} loading={primaryLoading}>
            {primaryLabel}
          </Button>
        </div>
      )}
      {hint && <div className="claude-status-empty__hint">{hint}</div>}
    </div>
  )
}

/**
 * 单个 radio 选项
 * @param {object} props - radio 选项属性
 * @returns {JSX.Element}
 */
function RadioOption({ checked, onChange, label, desc, value, name }) {
  return (
    <label className={`claude-radio-option${checked ? ' claude-radio-option--checked' : ''}`}>
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={() => onChange(value)}
        className="claude-radio-option__native"
      />
      <span className="claude-radio-option__dot" aria-hidden="true" />
      <span className="claude-radio-option__content">
        <div className="claude-radio-option__label">{label}</div>
        <div className="claude-radio-option__desc">{desc}</div>
      </span>
    </label>
  )
}

/**
 * Claude Code 会员额度状态卡片
 * @param {object} props - 组件属性
 * @param {object|null} props.statusState - 当前状态(后端 IPC 返回)
 * @param {boolean} props.loading - 是否加载中
 * @param {boolean} props.installing - 是否安装中
 * @param {boolean} props.saving - 是否保存中
 * @param {string|null} props.error - 错误信息
 * @param {{displayMode: string, fiveHourThreshold: string|number, sevenDayThreshold: string|number}} props.formConfig - 表单配置
 * @param {(field: string, value: string) => void} props.onFormChange - 表单更新回调
 * @param {() => void} props.onSave - 保存回调
 * @param {() => void} props.onRefresh - 刷新回调
 * @param {(options?: {force?: boolean}) => void} props.onEnsureInstalled - 安装/修复回调
 * @returns {JSX.Element}
 */
export default function ClaudeUsageStatusCard({
  statusState,
  loading,
  installing,
  saving,
  error,
  formConfig,
  onFormChange,
  onSave,
  onRefresh,
  onEnsureInstalled,
}) {
  const renderState = deriveRenderState(statusState, error)
  const badge = getBadge(renderState)
  const snapshot = statusState?.snapshot || null
  const claudeInstalled = Boolean(statusState?.claudeInstalled)
  const showSettings = claudeInstalled && renderState !== 'not_installed' && renderState !== 'read_error'
  const updatedAtLabel = formatUpdatedAt(snapshot?.updatedAt)
  const offHintVisible = renderState === 'off_with_data'

  return (
    <>
      <section className={`claude-status-card${renderState === 'stale' ? ' claude-status-card--stale' : ''}`}>
        <header className="claude-status-card__header">
          <div>
            <h2 className="claude-status-card__title">会员额度</h2>
            {offHintVisible && (
              <div className="claude-status-card__hint">
                ⏸ 状态栏显示已关闭 · 本页数据照常实时同步
              </div>
            )}
          </div>
          <span className={`claude-status-badge claude-status-badge--${badge.variant}`}>
            {badge.label}
          </span>
        </header>

        {/* 快照过期提示:数据仍展示但半透明 + 黄色提示条 */}
        {renderState === 'stale' && (
          <div className="claude-status-stale-notice">
            ⚠ 数据可能已过期 — 最后同步于 {updatedAtLabel}，打开 Claude Code 对话即可自动刷新。
          </div>
        )}

        {/* 主态 / off 模式 / 快照过期:显示两条水平进度条 */}
        {(renderState === 'ready' || renderState === 'off_with_data' || renderState === 'stale') && (
          <DataBody snapshot={snapshot} />
        )}

        {/* 等待首个快照 */}
        {renderState === 'waiting_first_data' && (
          <EmptyBody
            icon="⏳"
            iconVariant="warning"
            title="等待首个额度快照"
            desc={
              <>
                状态栏已接入成功,但 Claude Code 还没有发送过 rate_limits 数据。<br />
                打开 Claude Code 对话一次,额度会自动出现在这里。
              </>
            }
            primaryLabel={loading ? '刷新中...' : '刷新状态'}
            primaryLoading={loading}
            onPrimary={onRefresh}
          />
        )}

        {/* 账号无额度数据(非 Max 订阅 / 第三方后端)*/}
        {renderState === 'no_rate_limits' && (
          <EmptyBody
            icon="ⓘ"
            iconVariant="warning"
            title="当前账号没有返回额度数据"
            desc={
              <>
                Claude Code 已经成功接入并运行过脚本,但你的账号在最近一次对话里没有返回{' '}
                <span className="claude-status-empty__code">rate_limits</span> 字段。常见原因:
              </>
            }
            reasons={
              <>
                <span>① 你不是 Claude Max 订阅用户(只有 Max 订阅者才有 5h/7d 额度)</span>
                <span>② 或者你的 Claude Code 通过环境变量指向了第三方 API(如 Kimi、AICodeMirror 等),第三方后端不实现这个字段</span>
                <span>③ 如果你确认自己是 Max 用户并使用官方 API,检查网络后再开一次对话试试</span>
              </>
            }
            primaryLabel={loading ? '刷新中...' : '刷新状态'}
            primaryLoading={loading}
            onPrimary={onRefresh}
            hint={`最后同步 ${updatedAtLabel} · 脚本已运行但无额度字段`}
          />
        )}

        {/* 尚未接入(已装 Claude Code 但没安装过状态栏)*/}
        {renderState === 'not_configured' && (
          <EmptyBody
            icon="⚡"
            iconVariant="neutral"
            title="一键接入 Claude Code 会员额度"
            desc={
              <>
                CodePal 会为你自动配置 Claude Code 的状态栏脚本,之后打开 Claude Code 就能在底部看到 5h / 7d 额度。
                你不需要手动改{' '}
                <span className="claude-status-empty__code">settings.json</span> 或写脚本。
              </>
            }
            primaryLabel={installing ? '处理中...' : '立即接入'}
            primaryLoading={installing}
            onPrimary={() => onEnsureInstalled?.({ force: false })}
          />
        )}

        {/* 检测到自定义 statusLine 配置 */}
        {renderState === 'conflict' && (
          <EmptyBody
            icon="⚠"
            iconVariant="warning"
            title="检测到已有自定义 statusLine"
            desc={
              <>
                你的{' '}
                <span className="claude-status-empty__code">~/.claude/settings.json</span>{' '}
                里已经配置了状态栏脚本。CodePal 不会静默覆盖你的配置。
                <br />
                如果你想让 CodePal 接管,点击下方按钮,旧配置会先备份到同目录。
              </>
            }
            primaryLabel={installing ? '处理中...' : '接管并安装'}
            primaryLoading={installing}
            onPrimary={() => onEnsureInstalled?.({ force: true })}
            hint="备份路径:~/.claude/settings.json.codepal-backup-<时间戳>"
          />
        )}

        {/* 未安装 Claude Code */}
        {renderState === 'not_installed' && (
          <EmptyBody
            icon="○"
            iconVariant="neutral"
            title="本机未安装 Claude Code"
            desc={
              <>
                这个功能需要先安装 Claude Code CLI。安装完成后回到 CodePal,点击下方"刷新状态",系统会自动帮你接入。
              </>
            }
            primaryLabel={loading ? '刷新中...' : '刷新状态'}
            primaryLoading={loading}
            onPrimary={onRefresh}
          />
        )}

        {/* 接入失败(权限 / 写入错误)*/}
        {renderState === 'setup_failed' && (
          <EmptyBody
            icon="✕"
            iconVariant="danger"
            title="无法写入 Claude 配置文件"
            desc={
              <>
                CodePal 尝试写入{' '}
                <span className="claude-status-empty__code">~/.claude/settings.json</span>{' '}
                但失败了。通常是因为目录权限不足,或文件正在被其他进程占用。
              </>
            }
            primaryLabel={installing ? '处理中...' : '重试接入'}
            primaryLoading={installing}
            onPrimary={() => onEnsureInstalled?.({ force: false })}
            hint={error ? `错误详情:${error}` : undefined}
          />
        )}

        {/* 前端 IPC 读取异常 */}
        {renderState === 'read_error' && (
          <EmptyBody
            icon="✕"
            iconVariant="danger"
            title="无法读取额度状态"
            desc="CodePal 在读取 Claude 会员额度状态时遇到问题。可能是快照文件损坏、权限不足,或者主进程通信异常。"
            primaryLabel={loading ? '重试中...' : '重试'}
            primaryLoading={loading}
            onPrimary={onRefresh}
            hint={error ? `错误详情:${error}` : undefined}
          />
        )}

        {/* 底部 meta bar:只在有数据态显示 */}
        {(renderState === 'ready' || renderState === 'off_with_data' || renderState === 'stale') && (
          <footer className="claude-status-card__footer">
            <span>最后同步 {updatedAtLabel}</span>
            <Button variant="ghost" size="sm" onClick={onRefresh} disabled={loading}>
              {loading ? '刷新中...' : '刷新状态'}
            </Button>
          </footer>
        )}
      </section>

      {/* 显示设置卡 — 只在 Claude Code 已安装时显示 */}
      {showSettings && (
        <section className="claude-settings-card">
          <header className="claude-settings-card__header">
            <h2 className="claude-settings-card__title">显示设置</h2>
            <p className="claude-settings-card__subtitle">
              控制 Claude Code 底部状态栏的显示行为
            </p>
          </header>

          <div className="claude-settings-card__body">
            <div className="claude-settings-group">
              <div className="claude-settings-group__label">显示模式</div>

              <RadioOption
                name="claude-display-mode"
                value="always"
                checked={formConfig.displayMode === 'always'}
                onChange={(v) => onFormChange('displayMode', v)}
                label="总是显示"
                desc="Claude Code 底部状态栏常驻显示 5h 和 7d 额度"
              />

              <RadioOption
                name="claude-display-mode"
                value="threshold"
                checked={formConfig.displayMode === 'threshold'}
                onChange={(v) => onFormChange('displayMode', v)}
                label="达阈值才显示"
                desc="只有 5h 或 7d 任一超过下面的阈值时,才出现在状态栏"
              />

              <RadioOption
                name="claude-display-mode"
                value="off"
                checked={formConfig.displayMode === 'off'}
                onChange={(v) => onFormChange('displayMode', v)}
                label="关闭"
                desc="不在 Claude Code 底部显示,但 CodePal 这里仍实时更新数据"
              />
            </div>

            <div className="claude-settings-group">
              <div className="claude-settings-group__label">
                阈值(仅在"达阈值才显示"模式下生效)
              </div>
              <div className="claude-threshold-row">
                <div className="claude-threshold-field">
                  <div className="claude-threshold-field__label">5 小时阈值</div>
                  <div className="claude-threshold-field__control">
                    <input
                      className="claude-threshold-field__input"
                      type="number"
                      min="0"
                      max="100"
                      value={formConfig.fiveHourThreshold}
                      onChange={(e) => onFormChange('fiveHourThreshold', e.target.value)}
                    />
                    <span className="claude-threshold-field__suffix">%</span>
                  </div>
                </div>
                <div className="claude-threshold-field">
                  <div className="claude-threshold-field__label">7 天阈值</div>
                  <div className="claude-threshold-field__control">
                    <input
                      className="claude-threshold-field__input"
                      type="number"
                      min="0"
                      max="100"
                      value={formConfig.sevenDayThreshold}
                      onChange={(e) => onFormChange('sevenDayThreshold', e.target.value)}
                    />
                    <span className="claude-threshold-field__suffix">%</span>
                  </div>
                </div>
              </div>
              <div className="claude-threshold-help">
                阈值只影响"是否出现在 Claude Code 状态栏",不影响本页进度条的颜色(颜色固定规则:&lt;60% 绿 · 60-85% 黄 · ≥85% 红)。
              </div>
            </div>
          </div>

          <footer className="claude-settings-card__footer">
            <Button variant="primary" onClick={onSave} loading={saving}>
              {saving ? '保存中...' : '保存设置'}
            </Button>
          </footer>
        </section>
      )}
    </>
  )
}
