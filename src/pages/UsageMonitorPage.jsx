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
 * 用量监测页面组件
 * @returns {JSX.Element}
 */
export default function UsageMonitorPage() {
  const {
    currentPeriod, displayData, costData, formatCost, periodTotals,
    loading, error, customLoading, allTimeLoading,
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
          >
            近7天
          </button>
          <button
            className={`segment-item ${currentPeriod === 'month' ? 'active' : ''}`}
            onClick={() => handlePeriodChange('month')}
          >
            近30天
          </button>
          <button
            className={`segment-item ${currentPeriod === 'allTime' ? 'active' : ''}`}
            onClick={() => handlePeriodChange('allTime')}
          >
            累计至今
          </button>
          <button
            ref={customTriggerRef}
            className={`segment-item ${currentPeriod === 'custom' ? 'active' : ''}`}
            onClick={() => handlePeriodChange('custom')}
            title={currentPeriod === 'custom' ? `${appliedCustomRange.startDate} 至 ${appliedCustomRange.endDate}` : '选择自定义日期范围'}
          >
            <svg className="calendar-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="2" y="3" width="12" height="11" rx="1.5" />
              <path d="M2 6h12M5 2v3M11 2v3" />
            </svg>
            <span>{getCustomButtonLabel()}</span>
          </button>
        </div>

        {/* 自定义日期 dropdown */}
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

      {/* 错误提示 */}
      {error && (
        <div className="error-banner">
          <span>⚠️ {error}</span>
          {currentPeriod !== 'custom' && (
            <button onClick={handleRefresh}>重试</button>
          )}
        </div>
      )}

      {/* 加载态 */}
      {(loading || customLoading || allTimeLoading) && (
        <div className="usage-loading-overlay">
          <div className="loading-spinner" />
          <span>加载中...</span>
        </div>
      )}

      {/* 用量概览：总 Token + 预估费用 */}
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

      {/* 分布分析 */}
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

      {/* Token 明细 */}
      <div className="section-divider">Token 明细</div>
      <div className="table-card">
        <DetailTable
          models={displayData.models}
          modelCosts={costData.modelCosts}
          formatCost={formatCost}
        />
      </div>

      {/* 费用标注 */}
      <p className="cost-disclaimer">
        费用为基于官方公开定价的估算值，实际费用以账单为准。订阅制用户（如 Claude Max）的实际支出为固定月费，此处仅供参考等价消耗。
      </p>

      {/* 目标设定弹窗 */}
      <GoalSettingModal
        open={showGoalModal}
        onClose={() => setShowGoalModal(false)}
        currentGoal={goal}
        onSave={saveGoal}
      />
    </PageShell>
  );
}
