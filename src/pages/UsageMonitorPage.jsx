/**
 * 用量监测页面
 *
 * 负责：
 * - 展示 Token 用量数据（今日/近7天/近30天/自定义日期）
 * - 饼图展示模型分布（正常场景展示全部，极端场景展示 Top 5 + 其他）
 * - 明细表格展示全部模型数据
 * - 自动刷新机制
 * - 自定义日期范围选择（V0.8）
 *
 * @module pages/UsageMonitorPage
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { aggregateUsage } from '../store/usageAggregator';
import { DetailTable } from './usage/components/UsageDisplayComponents';
import { calculateCosts, formatCost } from '../store/costCalculator';
import DatePickerModal from './usage/components/DatePickerModal';
import DistributionBar from './usage/components/DistributionBar';
import BudgetProgress from './usage/components/BudgetProgress';
import GoalSettingModal from './usage/components/GoalSettingModal';
import useUsageGoal from './usage/useUsageGoal';
import {
  getBeijingDateTimeParts,
  getBeijingDayKey,
  getBeijingRelativeDayKey,
  getDailyRefreshKey,
  formatDateDisplay,
  mapRangeErrorToMessage,
} from './usage/usageDateUtils';
import {
  readUsageCache,
  writeUsageCache,
  shouldRefreshPeriod,
} from './usage/useUsageCache';
import './usage.css';
import PageShell from '../components/PageShell';


const EMPTY_USAGE_DATA = {
  total: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreate: 0,
  models: [],
  distribution: [],
  projectDistribution: [],
  isExtremeScenario: false,
  modelCount: 0
};

/**
 * 用量监测页面组件
 * @returns {JSX.Element}
 */
export default function UsageMonitorPage() {
  // 当前周期：'today' | 'week' | 'month' | 'custom'
  const [currentPeriod, setCurrentPeriod] = useState('today');

  // 自定义日期弹窗显隐状态
  const [showCustomDateModal, setShowCustomDateModal] = useState(false);

  // 自定义日期范围（临时状态，确认后才生效）
  const [customDateRange, setCustomDateRange] = useState(() => {
    // 默认日期：昨天（北京时间）
    const yestStr = getBeijingRelativeDayKey(-1);
    return {
      startDate: yestStr,
      endDate: yestStr
    };
  });

  // 当前生效的自定义日期范围（用于展示）
  const [appliedCustomRange, setAppliedCustomRange] = useState({
    startDate: '',
    endDate: ''
  });

  // 自定义日期校验错误信息
  const [customDateError, setCustomDateError] = useState(null);

  // 用量目标管理
  const {
    hasGoal, dismissed, goal, dailyTarget, weeklyTarget, monthlyTarget,
    saveGoal, dismissGoal,
  } = useUsageGoal();

  // 目标设定弹窗
  const [showGoalModal, setShowGoalModal] = useState(false);

  // 三个周期的数据缓存（内存态 + 本地持久化）
  const [periodCache, setPeriodCache] = useState(() => readUsageCache());

  // 自定义日期范围的数据（独立状态，不缓存到本地存储）
  const [customData, setCustomData] = useState(null);

  // 加载状态
  const [loading, setLoading] = useState(false);

  // 错误信息
  const [error, setError] = useState(null);


  // 自动刷新定时器
  const refreshTimerRef = useRef(null);

  // 避免闭包读取旧缓存
  const periodCacheRef = useRef(periodCache);

  // 避免闭包读取旧周期
  const currentPeriodRef = useRef(currentPeriod);

  // 防止同周期并发重算
  const refreshingSetRef = useRef(new Set());

  // 自定义日期请求中标志（用于加载态）
  const [customLoading, setCustomLoading] = useState(false);

  /**
   * 合并并持久化缓存
   * @param {'today'|'week'|'month'} period - 周期
   * @param {object} entry - 缓存条目
   */
  const updatePeriodCache = useCallback((period, entry) => {
    setPeriodCache((prev) => {
      const next = {
        ...prev,
        [period]: entry
      };
      writeUsageCache(next);
      return next;
    });
  }, []);

  /**
   * 重算单个周期数据（带缓存新鲜度判断）
   * @param {'today'|'week'|'month'} period - 周期
   * @param {{force?: boolean, showLoading?: boolean}} options - 执行选项
   */
  const refreshPeriodData = useCallback(async (period, options = {}) => {
    const { force = false, showLoading = false } = options;

    if (refreshingSetRef.current.has(period)) {
      return;
    }

    const now = new Date();
    const cacheEntry = periodCacheRef.current[period];

    // 只在"强制刷新"或"缓存过期"时重算
    if (!force && !shouldRefreshPeriod(period, cacheEntry, now)) {
      return;
    }

    refreshingSetRef.current.add(period);

    if (showLoading && currentPeriodRef.current === period) {
      setLoading(true);
    }

    try {
      const result = await aggregateUsage(period);

      if (result.success) {
        const computedAt = new Date().toISOString();
        const entry = {
          data: result.data,
          computedAt,
          dayKey: period === 'today' ? getBeijingDayKey(new Date()) : undefined,
          dailyRefreshKey: period !== 'today' ? getDailyRefreshKey(new Date()) : undefined
        };

        updatePeriodCache(period, entry);

        if (currentPeriodRef.current === period) {
          setError(null);
        }
      } else {
        const hasFallback = Boolean(periodCacheRef.current[period]?.data);
        if (currentPeriodRef.current === period) {
          setError(hasFallback ? '刷新失败，显示上次数据' : (result.error || '加载失败'));
        }
      }
    } catch (err) {
      const hasFallback = Boolean(periodCacheRef.current[period]?.data);
      if (currentPeriodRef.current === period) {
        setError(hasFallback ? '刷新失败，显示上次数据' : (err.message || '未知错误'));
      }
    } finally {
      refreshingSetRef.current.delete(period);

      if (showLoading && currentPeriodRef.current === period) {
        setLoading(false);
      }
    }
  }, [updatePeriodCache]);

  /**
   * 检查是否需要自动刷新
   * - 今日：每5分钟刷新
   * - 7天/30天：每日北京时间 00:05 刷新
   */
  const checkAutoRefresh = useCallback(() => {
    refreshPeriodData('today', { showLoading: false });
    refreshPeriodData('week', { showLoading: false });
    refreshPeriodData('month', { showLoading: false });
  }, [refreshPeriodData]);

  useEffect(() => {
    periodCacheRef.current = periodCache;
  }, [periodCache]);

  useEffect(() => {
    currentPeriodRef.current = currentPeriod;
  }, [currentPeriod]);

  // 首次进入页面时预热三个周期缓存，确保后续切换仅切展示
  useEffect(() => {
    let isMounted = true;

    const bootstrap = async () => {
      setError(null);

      if (!window.electronAPI?.scanLogFiles) {
        // 测试/降级环境：用空数据填充缓存，保证页面结构稳定
        const now = new Date().toISOString();
        const fallbackCache = {
          today: { data: EMPTY_USAGE_DATA, computedAt: now, dayKey: getBeijingDayKey(new Date()) },
          week: { data: EMPTY_USAGE_DATA, computedAt: now, dailyRefreshKey: getDailyRefreshKey(new Date()) },
          month: { data: EMPTY_USAGE_DATA, computedAt: now, dailyRefreshKey: getDailyRefreshKey(new Date()) }
        };

        if (isMounted) {
          setPeriodCache(fallbackCache);
          writeUsageCache(fallbackCache);
          setLoading(false);
        }
        return;
      }

      const hasCurrentCache = Boolean(periodCacheRef.current[currentPeriodRef.current]?.data);
      if (!hasCurrentCache) {
        setLoading(true);
      }

      await Promise.all([
        refreshPeriodData('today', { showLoading: !hasCurrentCache && currentPeriodRef.current === 'today' }),
        refreshPeriodData('week', { showLoading: false }),
        refreshPeriodData('month', { showLoading: false })
      ]);

      if (isMounted) {
        setLoading(false);
      }
    };

    bootstrap();

    return () => {
      isMounted = false;
    };
  }, [refreshPeriodData]);

  // 设置自动刷新定时器
  useEffect(() => {
    // 每分钟检查一次是否需要刷新
    refreshTimerRef.current = setInterval(checkAutoRefresh, 60 * 1000);

    return () => {
      if (refreshTimerRef.current) {
        clearInterval(refreshTimerRef.current);
      }
    };
  }, [checkAutoRefresh]);

  /**
   * 获取今天的日期字符串（YYYY-MM-DD）
   * @returns {string}
   */
  const getTodayString = useCallback(() => {
    const parts = getBeijingDateTimeParts(new Date());
    return `${parts.year}-${parts.month}-${parts.day}`;
  }, []);

  /**
   * 获取自定义按钮文案
   * @returns {string}
   */
  const getCustomButtonLabel = () => {
    if (currentPeriod === 'custom' && appliedCustomRange.startDate && appliedCustomRange.endDate) {
      const start = formatDateDisplay(appliedCustomRange.startDate);
      const end = formatDateDisplay(appliedCustomRange.endDate);
      return `${start} - ${end}`;
    }
    return '自定义';
  };

  /**
   * 验证自定义日期范围
   * @returns {{valid: boolean, error: string|null}}
   */
  const validateCustomDateRange = useCallback(() => {
    const { startDate, endDate } = customDateRange;

    if (!startDate || !endDate) {
      return { valid: false, error: '请选择开始日期和结束日期' };
    }

    const start = new Date(startDate);
    const end = new Date(endDate);
    const today = new Date(getTodayString());

    if (start > end) {
      return { valid: false, error: '开始日期不能晚于结束日期' };
    }

    // 结束日期 < 今天（今天和未来都不允许）
    if (end >= today) {
      return { valid: false, error: '结束日期不能为今天或未来日期' };
    }

    return { valid: true, error: null };
  }, [customDateRange, getTodayString]);

  // dropdown 容器 ref，用于点击外部检测
  const dropdownRef = useRef(null);
  // 自定义日期按钮 ref，用于计算 dropdown 定位
  const customTriggerRef = useRef(null);
  // dropdown 在 toolbar 内的相对位置
  const [datePickerPosition, setDatePickerPosition] = useState({ left: 0, top: 0 });

  /**
   * 计算并更新日期选择器位置
   */
  const updateDatePickerPosition = useCallback(() => {
    if (!dropdownRef.current || !customTriggerRef.current) return;

    const triggerRect = customTriggerRef.current.getBoundingClientRect();
    const toolbarRect = dropdownRef.current.getBoundingClientRect();

    setDatePickerPosition({
      left: triggerRect.left - toolbarRect.left,
      top: triggerRect.bottom - toolbarRect.top + 4
    });
  }, []);

  /**
   * 处理周期切换
   * @param {string} period - 新周期
   */
  const handlePeriodChange = (period) => {
    // 点击自定义时切换 dropdown 显隐，但不立即切换周期
    if (period === 'custom') {
      setShowCustomDateModal((prev) => {
        const next = !prev;
        if (next) {
          updateDatePickerPosition();
        }
        return next;
      });
      setCustomDateError(null);
      return;
    }

    if (period === currentPeriod) return;

    // 切换到预设时：关闭 dropdown，取消自定义激活态，文案恢复"自定义"
    setShowCustomDateModal(false);
    setCurrentPeriod(period);
    setError(null);
  };

  /**
   * 获取自定义日期范围数据
   * @param {string} startDate - 开始日期 (YYYY-MM-DD)
   * @param {string} endDate - 结束日期 (YYYY-MM-DD)
   * @returns {Promise<{success: boolean, data?: object, error?: string}>}
   */
  const fetchCustomRangeData = useCallback(async (startDate, endDate) => {
    // 前后端并行阶段：后端接口未就绪时允许跳过请求，仅保留前端交互验证
    if (!window.electronAPI?.aggregateUsageRange) {
      return { success: true, data: null, skipped: true };
    }

    try {
      const result = await window.electronAPI.aggregateUsageRange({
        startDate,
        endDate,
        timezone: 'Asia/Shanghai'
      });

      return result;
    } catch (err) {
      return { success: false, error: err.message || '请求异常' };
    }
  }, []);

  /**
   * 获取可选最大日期（昨天）
   * @returns {string}
   */
  const getMaxSelectableDate = useCallback(() => {
    return getBeijingRelativeDayKey(-1);
  }, []);

  /**
   * 处理自定义日期确认
   */
  const handleCustomDateConfirm = async () => {
    const validation = validateCustomDateRange();

    if (!validation.valid) {
      setCustomDateError(validation.error);
      return;
    }

    const newRange = { ...customDateRange };

    // 首次切换自定义时，先复用当前已展示数据，避免出现"空白闪烁"
    if (!customData) {
      const fallbackData =
        periodCacheRef.current[currentPeriodRef.current]?.data || EMPTY_USAGE_DATA;
      setCustomData(fallbackData);
    }

    setAppliedCustomRange(newRange);
    setCurrentPeriod('custom');
    setShowCustomDateModal(false);
    setCustomDateError(null);
    setError(null);

    setCustomLoading(true);

    try {
      const result = await fetchCustomRangeData(newRange.startDate, newRange.endDate);

      if (result.success && result.data) {
        setCustomData(result.data);
        setError(null);
      } else if (result.success && result.skipped) {
        setError(null);
      } else {
        const mappedError = mapRangeErrorToMessage(result.error);
        const hasFallback = Boolean(customData);
        setError(hasFallback
          ? `数据获取失败：${mappedError}，显示上次数据`
          : mappedError);
      }
    } catch (err) {
      const mappedError = mapRangeErrorToMessage(err.message);
      const hasFallback = Boolean(customData);
      setError(hasFallback
        ? `数据获取失败：${mappedError}，显示上次数据`
        : mappedError);
    } finally {
      setCustomLoading(false);
    }
  };

  /**
   * 处理自定义日期取消
   */
  const handleCustomDateCancel = () => {
    setShowCustomDateModal(false);
    setCustomDateError(null);
  };

  // 点击外部关闭 dropdown 的 effect
  useEffect(() => {
    if (!showCustomDateModal) return;

    const handleClickOutside = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        handleCustomDateCancel();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showCustomDateModal]);

  // dropdown 打开后跟随窗口变化更新位置，避免错位
  useEffect(() => {
    if (!showCustomDateModal) return;

    updateDatePickerPosition();
    window.addEventListener('resize', updateDatePickerPosition);

    return () => {
      window.removeEventListener('resize', updateDatePickerPosition);
    };
  }, [showCustomDateModal, updateDatePickerPosition]);

  /**
   * 手动刷新
   */
  const handleRefresh = () => {
    refreshPeriodData(currentPeriod, { force: true, showLoading: true });
  };

  // 当前周期显示数据：优先读取缓存，缺省回退空态
  // 自定义周期使用独立状态 customData，失败时保留上一次有效数据
  const displayData = currentPeriod === 'custom'
    ? (customData || EMPTY_USAGE_DATA)
    : (periodCache[currentPeriod]?.data || EMPTY_USAGE_DATA);

  // 基于当前展示数据计算各模型预估费用
  const costData = useMemo(() => calculateCosts(displayData.models), [displayData.models]);

  // 三个周期的 total Token 数（用于预算进度圆环）
  const periodTotals = useMemo(() => ({
    today: periodCache.today?.data?.total || 0,
    week: periodCache.week?.data?.total || 0,
    month: periodCache.month?.data?.total || 0,
  }), [periodCache]);

  // 格式化数字显示（带单位）
  const formatMetricValue = (num) => {
    if (num == null) return '0';
    if (num >= 1000000000) return (num / 1000000000).toFixed(1) + 'B';
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num.toString();
  };

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
      {/* 预算进度圆环 */}
      <BudgetProgress
        hasGoal={hasGoal}
        dismissed={dismissed}
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
      {(loading || customLoading) && (
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
