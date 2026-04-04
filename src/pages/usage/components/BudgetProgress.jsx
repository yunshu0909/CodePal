/**
 * 预算进度卡片组件
 *
 * 负责：
 * - 三圆环展示（今日/本周/本月）
 * - 正常态：各色圆环 + 百分比
 * - 超预算态：橙色满圈 + 真实百分比（14px）
 * - 空态引导：虚线框 + 设定目标按钮 + 暂不设定
 *
 * @module pages/usage/components/BudgetProgress
 */

import Button from '../../../components/Button/Button';
import { formatMetricValue } from '../useUsageData';

// 圆环参数：r=27, 周长=2π×27=169.65
const RING_RADIUS = 27;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

// 三个周期的颜色配置
const RING_COLORS = {
  today: { stroke: '#2563eb', bg: '#e2e5ea' },
  week: { stroke: '#16a34a', bg: '#e2e5ea' },
  month: { stroke: '#8b5cf6', bg: '#e2e5ea' },
};

// 超预算颜色
const OVER_COLORS = { stroke: '#ea580c', bg: '#fed7aa' };

const PERIOD_LABELS = {
  today: '今日消耗',
  week: '本周消耗',
  month: '本月消耗',
};

/**
 * 单个圆环
 * @param {object} props
 * @param {string} props.period - today/week/month
 * @param {number} props.used - 已用 Token
 * @param {number} props.target - 目标 Token
 */
function ProgressRing({ period, used, target }) {
  const pct = target > 0 ? (used / target) * 100 : 0;
  const isOver = pct > 100;

  // 圆环偏移量：0% → 全长，100% → 0
  const clampedPct = Math.min(pct, 100);
  const offset = RING_CIRCUMFERENCE * (1 - clampedPct / 100);

  const colors = isOver ? OVER_COLORS : RING_COLORS[period];
  const pctText = `${Math.round(pct)}%`;

  return (
    <div className="budget-progress-item">
      <span className="budget-progress-label">{PERIOD_LABELS[period]}</span>
      <div className="budget-progress-ring">
        <svg viewBox="0 0 72 72">
          <circle
            cx="36" cy="36" r={RING_RADIUS}
            fill="none" stroke={colors.bg} strokeWidth="6"
          />
          <circle
            cx="36" cy="36" r={RING_RADIUS}
            fill="none" stroke={colors.stroke} strokeWidth="6"
            strokeLinecap="round"
            strokeDasharray={RING_CIRCUMFERENCE}
            strokeDashoffset={offset}
          />
        </svg>
        <span
          className={`budget-progress-pct${isOver ? ' budget-progress-pct--over' : ''}`}
          style={{ color: colors.stroke }}
        >
          {pctText}
        </span>
      </div>
      <span className="budget-progress-val">
        {formatMetricValue(used)}{' '}
        <span className="budget-progress-lim">/ {formatMetricValue(target)}</span>
      </span>
    </div>
  );
}

/**
 * 预算进度卡片
 * @param {object} props
 * @param {boolean} props.hasGoal - 是否已设定目标
 * @param {boolean} props.dismissed - 是否已点击"暂不设定"
 * @param {number} props.dailyTarget - 每日目标 Token 数
 * @param {number} props.weeklyTarget - 每周目标 Token 数
 * @param {number} props.monthlyTarget - 每月目标 Token 数
 * @param {number} props.todayUsed - 今日已用 Token
 * @param {number} props.weekUsed - 本周已用 Token
 * @param {number} props.monthUsed - 本月已用 Token
 * @param {() => void} props.onSetGoal - 打开设定目标弹窗
 * @param {() => void} props.onDismiss - 暂不设定
 */
export default function BudgetProgress({
  hasGoal,
  dismissed,
  dailyTarget,
  weeklyTarget,
  monthlyTarget,
  todayUsed,
  weekUsed,
  monthUsed,
  onSetGoal,
  onDismiss,
}) {
  // 暂不设定后，不渲染任何内容
  if (!hasGoal && dismissed) return null;

  // 未设目标且未跳过：空态引导
  if (!hasGoal) {
    return (
      <div className="budget-empty">
        <div className="budget-empty-icon">
          <svg width="24" height="24" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <circle cx="8" cy="8" r="6.5" />
            <circle cx="8" cy="8" r="3" />
            <circle cx="8" cy="8" r="0.5" fill="currentColor" />
          </svg>
        </div>
        <span className="budget-empty-title">还没有设定用量目标</span>
        <span className="budget-empty-desc">设定每日 Token 目标，追踪消耗进度</span>
        <Button variant="primary" onClick={onSetGoal}>设定目标</Button>
        <button className="budget-empty-dismiss" onClick={onDismiss}>暂不设定</button>
      </div>
    );
  }

  // 已设目标：三圆环
  return (
    <div className="budget-progress-card">
      <ProgressRing period="today" used={todayUsed} target={dailyTarget} />
      <ProgressRing period="week" used={weekUsed} target={weeklyTarget} />
      <ProgressRing period="month" used={monthUsed} target={monthlyTarget} />
    </div>
  );
}
