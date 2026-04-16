/**
 * 用量监测数据管理 Hook
 *
 * 负责：
 * - 今日数据的轻量加载与自动刷新
 * - 重周期（7天/30天/累计至今/自定义）后台汇总协调
 * - 周期切换与日期选择器交互状态
 * - 费用计算与数值格式化
 *
 * @module pages/usage/useUsageData
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { aggregateUsage } from '../../store/usageAggregator';
import { calculateCosts, formatCost } from '../../store/costCalculator';
import {
  getBeijingDateTimeParts,
  getBeijingDayKey,
  getBeijingRelativeDayKey,
  formatDateDisplay,
} from './usageDateUtils';
import {
  readUsageCache,
  writeUsageCache,
  shouldRefreshPeriod,
} from './useUsageCache';
import useUsageHeavyPeriods, { buildPredefinedRange } from './useUsageHeavyPeriods';

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
 * 格式化 Token 数值（带 K/M/B 单位）
 * @param {number|null} num - 原始数值
 * @returns {string}
 */
export function formatMetricValue(num) {
  if (num == null) return '0';
  if (num >= 1000000000) return (num / 1000000000).toFixed(1) + 'B';
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return num.toString();
}

/**
 * 创建 today 缓存条目
 * @param {object} data - 聚合结果
 * @returns {object}
 */
function buildTodayCacheEntry(data) {
  const now = new Date();

  return {
    data,
    computedAt: now.toISOString(),
    dayKey: getBeijingDayKey(now)
  };
}

/**
 * 用量监测数据管理 Hook
 * @returns {object} 页面渲染所需的全部状态和方法
 */
export default function useUsageData() {
  // 当前周期：'today' | 'week' | 'month' | 'allTime' | 'custom'
  const [currentPeriod, setCurrentPeriod] = useState('today');
  // 预设周期缓存（内存态 + 本地持久化）
  const [periodCache, setPeriodCache] = useState(() => readUsageCache());
  // 首屏轻量加载状态，仅用于 today
  const [loading, setLoading] = useState(false);
  // 顶部错误提示
  const [error, setError] = useState(null);
  // 自定义日期弹窗显隐状态
  const [showCustomDateModal, setShowCustomDateModal] = useState(false);
  // 自定义日期范围（临时状态，确认后才生效）
  const [customDateRange, setCustomDateRange] = useState(() => {
    const yestStr = getBeijingRelativeDayKey(-1);
    return { startDate: yestStr, endDate: yestStr };
  });
  // 当前生效的自定义日期范围（用于展示）
  const [appliedCustomRange, setAppliedCustomRange] = useState({
    startDate: '',
    endDate: ''
  });
  // 自定义日期校验错误信息
  const [customDateError, setCustomDateError] = useState(null);
  // 自定义日期范围的数据（独立状态，不缓存到本地存储）
  const [customData, setCustomData] = useState(null);
  // dropdown 在 toolbar 内的相对位置
  const [datePickerPosition, setDatePickerPosition] = useState({ left: 0, top: 0 });

  // 自动刷新定时器
  const refreshTimerRef = useRef(null);
  // 避免闭包读取旧缓存
  const periodCacheRef = useRef(periodCache);
  // 避免闭包读取旧周期
  const currentPeriodRef = useRef(currentPeriod);
  // 避免 today 并发刷新
  const refreshingTodayRef = useRef(false);
  // dropdown 容器 ref，用于点击外部检测
  const dropdownRef = useRef(null);
  // 自定义日期按钮 ref，用于计算 dropdown 定位
  const customTriggerRef = useRef(null);

  useEffect(() => {
    periodCacheRef.current = periodCache;
  }, [periodCache]);

  useEffect(() => {
    currentPeriodRef.current = currentPeriod;
  }, [currentPeriod]);

  /**
   * 合并并持久化缓存
   * @param {'today'|'week'|'month'|'allTime'} period - 周期
   * @param {object} entry - 缓存条目
   */
  const updatePeriodCache = useCallback((period, entry) => {
    setPeriodCache((prev) => {
      const next = { ...prev, [period]: entry };
      writeUsageCache(next);
      return next;
    });
  }, []);

  const {
    heavyTask,
    isPeriodDisabled,
    getPeriodDisabledReason,
    runHeavyPeriodTask,
  } = useUsageHeavyPeriods({
    periodCache,
    customData,
    updatePeriodCache,
    setCustomData,
    setError,
  });

  /**
   * 获取 today 数据
   * @param {{force?: boolean, showLoading?: boolean}} options - 执行选项
   */
  const refreshTodayData = useCallback(async (options = {}) => {
    const { force = false, showLoading = false } = options;
    const cacheEntry = periodCacheRef.current.today;

    if (refreshingTodayRef.current) return;
    if (!force && !shouldRefreshPeriod('today', cacheEntry, new Date())) return;

    refreshingTodayRef.current = true;

    if (showLoading && currentPeriodRef.current === 'today') {
      setLoading(true);
    }

    try {
      const result = await aggregateUsage('today');

      if (result.success) {
        updatePeriodCache('today', buildTodayCacheEntry(result.data));
        if (currentPeriodRef.current === 'today') {
          setError(null);
        }
      } else if (currentPeriodRef.current === 'today') {
        const hasFallback = Boolean(periodCacheRef.current.today?.data);
        setError(hasFallback ? '刷新失败，显示上次数据' : (result.error || '加载失败'));
      }
    } catch (err) {
      if (currentPeriodRef.current === 'today') {
        const hasFallback = Boolean(periodCacheRef.current.today?.data);
        setError(hasFallback ? '刷新失败，显示上次数据' : (err.message || '未知错误'));
      }
    } finally {
      refreshingTodayRef.current = false;

      if (showLoading && currentPeriodRef.current === 'today') {
        setLoading(false);
      }
    }
  }, [updatePeriodCache]);

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
  const getCustomButtonLabel = useCallback(() => {
    if (appliedCustomRange.startDate && appliedCustomRange.endDate) {
      const start = formatDateDisplay(appliedCustomRange.startDate);
      const end = formatDateDisplay(appliedCustomRange.endDate);
      return `${start} - ${end}`;
    }

    return '自定义';
  }, [appliedCustomRange]);

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

    if (end >= today) {
      return { valid: false, error: '结束日期不能为今天或未来日期' };
    }

    return { valid: true, error: null };
  }, [customDateRange, getTodayString]);

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
   * 获取可选最大日期（昨天）
   * @returns {string}
   */
  const getMaxSelectableDate = useCallback(() => {
    return getBeijingRelativeDayKey(-1);
  }, []);

  useEffect(() => {
    let isMounted = true;

    const bootstrap = async () => {
      setError(null);

      if (!window.electronAPI?.scanLogFiles) {
        const now = new Date().toISOString();
        const fallbackCache = {
          today: { data: EMPTY_USAGE_DATA, computedAt: now, dayKey: getBeijingDayKey(new Date()) },
          week: null,
          month: null,
          allTime: null
        };

        if (isMounted) {
          setPeriodCache(fallbackCache);
          writeUsageCache(fallbackCache);
          setLoading(false);
        }

        return;
      }

      const hasTodayCache = Boolean(periodCacheRef.current.today?.data);
      if (!hasTodayCache) {
        setLoading(true);
      }

      await refreshTodayData({
        showLoading: !hasTodayCache && currentPeriodRef.current === 'today'
      });

      if (isMounted) {
        setLoading(false);
      }
    };

    bootstrap();
    return () => { isMounted = false; };
  }, [refreshTodayData]);

  // today 每分钟轻量刷新一次；重周期改为“按需进入后台汇总”，避免首屏叠加三轮重扫。
  useEffect(() => {
    refreshTimerRef.current = window.setInterval(() => {
      refreshTodayData({ showLoading: false });
    }, 60 * 1000);

    return () => {
      if (refreshTimerRef.current) {
        window.clearInterval(refreshTimerRef.current);
      }
    };
  }, [refreshTodayData]);

  /**
   * 处理周期切换
   * @param {'today'|'week'|'month'|'allTime'|'custom'} period - 新周期
   */
  const handlePeriodChange = useCallback((period) => {
    if (period === 'custom') {
      if (isPeriodDisabled('custom')) {
        setError(getPeriodDisabledReason('custom'));
        return;
      }

      if (currentPeriod !== 'custom' && appliedCustomRange.startDate && appliedCustomRange.endDate) {
        setShowCustomDateModal(false);
        setCurrentPeriod('custom');
        setCustomDateError(null);
        setError(null);

        if (!customData && heavyTask.status !== 'running') {
          runHeavyPeriodTask('custom', appliedCustomRange, {
            hasFallbackData: false
          });
        }

        return;
      }

      setShowCustomDateModal((prev) => {
        const next = !prev;
        if (next) updateDatePickerPosition();
        return next;
      });
      setCustomDateError(null);
      return;
    }

    if (period === currentPeriod) return;

    if (isPeriodDisabled(period)) {
      setError(getPeriodDisabledReason(period));
      return;
    }

    setShowCustomDateModal(false);
    setCurrentPeriod(period);
    setError(null);

    if (period === 'today') {
      refreshTodayData({
        showLoading: !periodCacheRef.current.today?.data
      });
      return;
    }

    // 重任务运行中允许查看已有缓存，但不允许再发起新的区间重算。
    if (heavyTask.status === 'running') {
      return;
    }

    const cacheEntry = periodCacheRef.current[period];
    if (shouldRefreshPeriod(period, cacheEntry, new Date())) {
      const nextRange = period === 'allTime' ? undefined : buildPredefinedRange(period);
      runHeavyPeriodTask(period, nextRange, {
        hasFallbackData: Boolean(cacheEntry?.data)
      });
    }
  }, [
    appliedCustomRange,
    currentPeriod,
    customData,
    getPeriodDisabledReason,
    heavyTask.status,
    isPeriodDisabled,
    refreshTodayData,
    runHeavyPeriodTask,
    updateDatePickerPosition
  ]);

  /**
   * 处理自定义日期确认
   */
  const handleCustomDateConfirm = useCallback(async () => {
    if (heavyTask.status === 'running') {
      const busyMessage = getPeriodDisabledReason('custom');
      setCustomDateError(busyMessage);
      setError(busyMessage);
      return;
    }

    const validation = validateCustomDateRange();

    if (!validation.valid) {
      setCustomDateError(validation.error);
      return;
    }

    const newRange = { ...customDateRange };
    const fallbackData = currentPeriodRef.current === 'custom'
      ? (customData || EMPTY_USAGE_DATA)
      : (periodCacheRef.current[currentPeriodRef.current]?.data || EMPTY_USAGE_DATA);
    const hasFallbackData = Boolean(customData) || Boolean(periodCacheRef.current[currentPeriodRef.current]?.data);

    if (!customData) {
      setCustomData(fallbackData);
    }

    setAppliedCustomRange(newRange);
    setCurrentPeriod('custom');
    setShowCustomDateModal(false);
    setCustomDateError(null);
    setError(null);

    await runHeavyPeriodTask('custom', newRange, { hasFallbackData });
  }, [
    customData,
    customDateRange,
    getPeriodDisabledReason,
    heavyTask.status,
    runHeavyPeriodTask,
    validateCustomDateRange
  ]);

  /**
   * 处理自定义日期取消
   */
  const handleCustomDateCancel = useCallback(() => {
    setShowCustomDateModal(false);
    setCustomDateError(null);
  }, []);

  /**
   * 手动刷新当前周期
   */
  const handleRefresh = useCallback(() => {
    if (heavyTask.status === 'running' && currentPeriod !== 'today') {
      const busyMessage = heavyTask.period === currentPeriod
        ? `正在后台汇总${heavyTask.label}，完成后才能重新发起当前区间计算`
        : getPeriodDisabledReason(currentPeriod);
      setError(busyMessage);
      return;
    }

    if (currentPeriod === 'today') {
      refreshTodayData({ force: true, showLoading: true });
      return;
    }

    if (currentPeriod === 'custom') {
      if (!appliedCustomRange.startDate || !appliedCustomRange.endDate) {
        return;
      }

      runHeavyPeriodTask('custom', appliedCustomRange, {
        hasFallbackData: Boolean(customData)
      });
      return;
    }

    const nextRange = currentPeriod === 'allTime' ? undefined : buildPredefinedRange(currentPeriod);
    runHeavyPeriodTask(currentPeriod, nextRange, {
      hasFallbackData: Boolean(periodCacheRef.current[currentPeriod]?.data)
    });
  }, [
    appliedCustomRange,
    currentPeriod,
    customData,
    getPeriodDisabledReason,
    heavyTask,
    refreshTodayData,
    runHeavyPeriodTask
  ]);

  useEffect(() => {
    if (!showCustomDateModal || heavyTask.status !== 'running') return;

    // 任务一旦开始就收起日期弹层，避免用户误以为还能改出第二个区间任务。
    setShowCustomDateModal(false);
    setCustomDateError(null);
  }, [heavyTask.status, showCustomDateModal]);

  useEffect(() => {
    if (!showCustomDateModal) return;

    const handleClickOutside = (event) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        handleCustomDateCancel();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showCustomDateModal, handleCustomDateCancel]);

  useEffect(() => {
    if (!showCustomDateModal) return;

    updateDatePickerPosition();
    window.addEventListener('resize', updateDatePickerPosition);
    return () => window.removeEventListener('resize', updateDatePickerPosition);
  }, [showCustomDateModal, updateDatePickerPosition]);

  const displayData = currentPeriod === 'custom'
    ? (customData || EMPTY_USAGE_DATA)
    : (periodCache[currentPeriod]?.data || EMPTY_USAGE_DATA);
  const costData = useMemo(() => calculateCosts(displayData.models), [displayData.models]);
  const periodTotals = useMemo(() => ({
    today: periodCache.today?.data?.total || 0,
    week: periodCache.week?.data?.total || 0,
    month: periodCache.month?.data?.total || 0,
  }), [periodCache]);

  return {
    currentPeriod,
    displayData,
    costData,
    formatCost,
    periodTotals,
    loading,
    error,
    heavyTask,
    isPeriodDisabled,
    getPeriodDisabledReason,
    handlePeriodChange,
    handleRefresh,
    showCustomDateModal,
    customDateRange,
    setCustomDateRange,
    customDateError,
    setCustomDateError,
    datePickerPosition,
    appliedCustomRange,
    getCustomButtonLabel,
    getMaxSelectableDate,
    handleCustomDateConfirm,
    handleCustomDateCancel,
    dropdownRef,
    customTriggerRef,
  };
}
