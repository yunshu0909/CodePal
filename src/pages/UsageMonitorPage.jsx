/**
 * 用量监测页面
 *
 * 负责：
 * - 展示 Token 用量数据（今日/近7天/近30天/累计至今/自定义日期）
 * - 饼图展示模型分布与项目分布
 * - 明细表格展示各模型 Token 数据与预估费用
 * - 预算进度圆环与目标设定
 *
 * 数据与交互逻辑统一由 useUsageData hook 管理。
 *
 * @module pages/UsageMonitorPage
 */

import { useState } from 'react';
import useUsageData, { formatMetricValue } from './usage/useUsageData';
import { DetailTable } from './usage/components/UsageDisplayComponents';
import DatePickerModal from './usage/components/DatePickerModal';
import DistributionBar from './usage/components/DistributionBar';
import BudgetProgress from './usage/components/BudgetProgress';
import GoalSettingModal from './usage/components/GoalSettingModal';
import useUsageGoal from './usage/useUsageGoal';
import './usage.css';
import PageShell from '../components/PageShell';

/**
 * 格式化耗时显示
 * @param {number} durationMs - 时长（毫秒）
 * @returns {string}
 */
function formatDurationLabel(durationMs) {
  const safeMs = Math.max(0, Math.floor(durationMs || 0));
  const seconds = Math.max(1, Math.round(safeMs / 1000));

  if (seconds < 60) {
    return `${seconds} 秒`;
  }

  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;

  if (restSeconds === 0) {
    return `${minutes} 分钟`;
  }

  return `${minutes} 分 ${restSeconds} 秒`;
}

/**
 * 用量监测页面组件
 * @returns {JSX.Element}
 */
export default function UsageMonitorPage() {
  const {
    currentPeriod, displayData, costData, formatCost, periodTotals,
    loading, error, heavyTask, isPeriodDisabled, getPeriodDisabledReason,
    handlePeriodChange, handleRefresh,
    showCustomDateModal, customDateRange, setCustomDateRange,
    customDateError, setCustomDateError, datePickerPosition,
    appliedCustomRange, getCustomButtonLabel, getMaxSelectableDate,
    handleCustomDateConfirm, handleCustomDateCancel,
    dropdownRef, customTriggerRef,
  } = useUsageData();

  const {
    hasGoal, dismissed, goal, dailyTarget, weeklyTarget, monthlyTarget,
    saveGoal, dismissGoal, ready: goalReady,
  } = useUsageGoal();

  // 目标设定弹窗显隐状态
  const [showGoalModal, setShowGoalModal] = useState(false);

  const isHeavyTaskRunning = heavyTask.status === 'running';
  const isCurrentPeriodRefreshing = isHeavyTaskRunning && heavyTask.period === currentPeriod;

  return (
    <PageShell
      title="用量监测"
      subtitle="追踪 Token 消耗与预算执行情况"
      actions={
        <button className="btn-goal" onClick={() => setShowGoalModal(true)}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><circle cx="8" cy="8" r="6.5"/><circle cx="8" cy="8" r="3"/><circle cx="8" cy="8" r="0.5" fill="currentColor"/></svg>
          设定目标
        </button>
      }
    >
      {/* 预算进度圆环：等 electron-store 读完再渲染，避免闪出空态 */}
      <BudgetProgress
        hasGoal={hasGoal}
        dismissed={dismissed || !goalReady}
        dailyTarget={dailyTarget}
        weeklyTarget={weeklyTarget}
        monthlyTarget={monthlyTarget}
        todayUsed={periodTotals.today}
        weekUsed={periodTotals.week}
        monthUsed={periodTotals.month}
        onSetGoal={() => setShowGoalModal(true)}
        onDismiss={dismissGoal}
      />

      {/* 工具栏 - 分段控制器 */}
      <div className="usage-toolbar" ref={dropdownRef}>
        <div className="segment-control">
          <button
            className={`segment-item ${currentPeriod === 'today' ? 'active' : ''}`}
            onClick={() => handlePeriodChange('today')}
          >
            今日
          </button>
          <button
            className={`segment-item ${currentPeriod === 'week' ? 'active' : ''}`}
            onClick={() => handlePeriodChange('week')}
            disabled={isPeriodDisabled('week')}
            title={getPeriodDisabledReason('week')}
          >
            近7天
          </button>
          <button
            className={`segment-item ${currentPeriod === 'month' ? 'active' : ''}`}
            onClick={() => handlePeriodChange('month')}
            disabled={isPeriodDisabled('month')}
            title={getPeriodDisabledReason('month')}
          >
            近30天
          </button>
          <button
            className={`segment-item ${currentPeriod === 'allTime' ? 'active' : ''}`}
            onClick={() => handlePeriodChange('allTime')}
            disabled={isPeriodDisabled('allTime')}
            title={getPeriodDisabledReason('allTime')}
          >
            累计至今
          </button>
          <button
            ref={customTriggerRef}
            className={`segment-item ${currentPeriod === 'custom' ? 'active' : ''}`}
            onClick={() => handlePeriodChange('custom')}
            disabled={isPeriodDisabled('custom')}
            title={
              getPeriodDisabledReason('custom')
              || (currentPeriod === 'custom'
                ? `${appliedCustomRange.startDate} 至 ${appliedCustomRange.endDate}`
                : '选择自定义日期范围')
            }
          >
            <svg className="calendar-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="2" y="3" width="12" height="11" rx="1.5" />
              <path d="M2 6h12M5 2v3M11 2v3" />
            </svg>
            <span>{getCustomButtonLabel()}</span>
          </button>
        </div>

        {showCustomDateModal && (
          <DatePickerModal
            dateRange={customDateRange}
            onDateRangeChange={setCustomDateRange}
            error={customDateError}
            onErrorChange={setCustomDateError}
            maxDate={getMaxSelectableDate()}
            position={datePickerPosition}
            onConfirm={handleCustomDateConfirm}
            onCancel={handleCustomDateCancel}
          />
        )}
      </div>

      {error && (
        <div className="error-banner">
          <span>⚠️ {error}</span>
          {!isHeavyTaskRunning && (
            <button onClick={handleRefresh}>重试</button>
          )}
        </div>
      )}

      {loading && !isCurrentPeriodRefreshing && (
        <div className="usage-loading-overlay">
          <div className="loading-spinner" />
          <span>加载中...</span>
        </div>
      )}

      {isCurrentPeriodRefreshing ? (
        // 当前周期正在后台汇总：数据区整个让位给进度面板，避免“蓝色卡 + 一桌零”并存
        <div className="usage-progress-panel">
          <div className="usage-progress-panel__icon">
            <div className="usage-progress-panel__spinner" />
          </div>
          <div className="usage-progress-panel__eyebrow">正在汇总</div>
          <div className="usage-progress-panel__title">{heavyTask.label}</div>
          {heavyTask.rangeLabel && (
            <div className="usage-progress-panel__sub">{heavyTask.rangeLabel}</div>
          )}

          <div className="usage-progress-panel__bar-wrap">
            <div className="usage-progress-panel__bar-row">
              <span className="usage-progress-panel__days">
                {heavyTask.totalDays > 0
                  ? `已完成 ${heavyTask.processedDays} / ${heavyTask.totalDays} 天`
                  : '正在准备日期列表'}
              </span>
              <span className="usage-progress-panel__pct">{heavyTask.progressPercent}%</span>
            </div>
            <div className="usage-progress-panel__bar">
              <div
                className="usage-progress-panel__bar-fill"
                style={{ width: `${heavyTask.progressPercent}%` }}
              />
            </div>
            <div className="usage-progress-panel__elapsed">
              已耗时 {formatDurationLabel(heavyTask.elapsedMs)}
            </div>
          </div>

          <div className="usage-progress-panel__hint">
            正在扫描历史日志，可以先切到其他模块继续使用。<br />
            完成后回到这里会自动显示结果。
          </div>
        </div>
      ) : (
        <>
          <div className="overview-row">
            <div className="overview-card overview-card--token">
              <div className="overview-label">总 Token</div>
              <div className="overview-value">{formatMetricValue(displayData.total)}</div>
            </div>
            <div className="overview-card overview-card--cost">
              <div className="overview-label">预估费用</div>
              <div className="overview-value">{formatCost(costData.totalCost)}</div>
            </div>
          </div>

          <div className="section-divider">分布分析</div>
          <div className="dist-row">
            <DistributionBar
              title="按模型分布"
              items={displayData.distribution}
            />
            <DistributionBar
              title="按项目分布"
              items={displayData.projectDistribution}
              maxItems={4}
            />
          </div>

          <div className="section-divider">Token 明细</div>
          <div className="table-card">
            <DetailTable
              models={displayData.models}
              modelCosts={costData.modelCosts}
              formatCost={formatCost}
            />
          </div>

          <p className="cost-disclaimer">
            费用为基于官方公开定价的估算值，实际费用以账单为准。订阅制用户（如 Claude Max）的实际支出为固定月费，此处仅供参考等价消耗。
          </p>
        </>
      )}

      <GoalSettingModal
        open={showGoalModal}
        onClose={() => setShowGoalModal(false)}
        currentGoal={goal}
        onSave={saveGoal}
      />
    </PageShell>
  );
}
