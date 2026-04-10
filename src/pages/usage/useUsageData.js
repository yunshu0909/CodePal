/**
 * 用量监测数据管理 Hook
 *
 * 负责：
 * - 三周期（today/week/month）数据加载、缓存与自动刷新
 * - 自定义日期范围查询
 * - 周期切换与日期选择器交互状态
 * - 费用计算与数值格式化
 *
 * 从 UsageMonitorPage.jsx 拆分而来，保持行为完全不变。
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
  getDailyRefreshKey,
  formatDateDisplay,
  mapRangeErrorToMessage,
} from './usageDateUtils';
import {
  readUsageCache,
  writeUsageCache,
  shouldRefreshPeriod,
} from './useUsageCache';

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
 * 用量监测数据管理 Hook
 * @returns {object} 页面渲染所需的全部状态和方法
 */
export default function useUsageData() {
  // ---- 周期与加载状态 ----

  // 当前周期：'today' | 'week' | 'month' | 'custom'
  const [currentPeriod, setCurrentPeriod] = useState('today');

  // 三个周期的数据缓存（内存态 + 本地持久化）
  const [periodCache, setPeriodCache] = useState(() => readUsageCache());

  // 加载状态
  const [loading, setLoading] = useState(false);

  // 错误信息
  const [error, setError] = useState(null);

  // 周期刷新状态（用于避免并发重算）
  const [refreshingMap, setRefreshingMap] = useState({
    today: false,
    week: false,
    month: false
  });

  // ---- 自定义日期状态 ----

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

  // 自定义日期请求中标志
  const [customLoading, setCustomLoading] = useState(false);

  // 累计至今数据（首次加载后常驻内存）
  const [allTimeData, setAllTimeData] = useState(null);

  // 累计至今请求中标志
  const [allTimeLoading, setAllTimeLoading] = useState(false);

  // ---- Refs ----

  // 自动刷新定时器
  const refreshTimerRef = useRef(null);

  // 避免闭包读取旧缓存
  const periodCacheRef = useRef(periodCache);

  // 避免闭包读取旧周期
  const currentPeriodRef = useRef(currentPeriod);

  // 防止同周期并发重算
  const refreshingSetRef = useRef(new Set());

  // 防止累计至今并发请求
  const fetchingAllTimeRef = useRef(false);

  // dropdown 容器 ref，用于点击外部检测
  const dropdownRef = useRef(null);

  // 自定义日期按钮 ref，用于计算 dropdown 定位
  const customTriggerRef = useRef(null);

  // dropdown 在 toolbar 内的相对位置
  const [datePickerPosition, setDatePickerPosition] = useState({ left: 0, top: 0 });

  // ---- 同步 refs ----

  useEffect(() => {
    periodCacheRef.current = periodCache;
  }, [periodCache]);

  useEffect(() => {
    currentPeriodRef.current = currentPeriod;
  }, [currentPeriod]);

  // ---- 缓存管理 ----

  /**
   * 合并并持久化缓存
   * @param {'today'|'week'|'month'} period - 周期
   * @param {object} entry - 缓存条目
   */
  const updatePeriodCache = useCallback((period, entry) => {
    setPeriodCache((prev) => {
      const next = { ...prev, [period]: entry };
      writeUsageCache(next);
      return next;
    });
  }, []);

  // ---- 数据刷新 ----

  /**
   * 重算单个周期数据（带缓存新鲜度判断）
   * @param {'today'|'week'|'month'} period - 周期
   * @param {{force?: boolean, showLoading?: boolean}} options - 执行选项
   */
  const refreshPeriodData = useCallback(async (period, options = {}) => {
    const { force = false, showLoading = false } = options;

    if (refreshingSetRef.current.has(period)) return;

    const now = new Date();
    const cacheEntry = periodCacheRef.current[period];

    if (!force && !shouldRefreshPeriod(period, cacheEntry, now)) return;

    refreshingSetRef.current.add(period);
    setRefreshingMap((prev) => ({ ...prev, [period]: true }));

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
      setRefreshingMap((prev) => ({ ...prev, [period]: false }));

      if (showLoading && currentPeriodRef.current === period) {
        setLoading(false);
      }
    }
  }, [updatePeriodCache]);

  /**
   * 检查是否需要自动刷新
   */
  const checkAutoRefresh = useCallback(() => {
    refreshPeriodData('today', { showLoading: false });
    refreshPeriodData('week', { showLoading: false });
    refreshPeriodData('month', { showLoading: false });
  }, [refreshPeriodData]);

  // ---- 初始化与自动刷新 ----

  // 首次进入页面时预热三个周期缓存
  useEffect(() => {
    let isMounted = true;

    const bootstrap = async () => {
      setError(null);

      if (!window.electronAPI?.scanLogFiles) {
        // 测试/降级环境：用空数据填充缓存
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
    return () => { isMounted = false; };
  }, [refreshPeriodData]);

  // 每分钟检查是否需要刷新
  useEffect(() => {
    refreshTimerRef.current = setInterval(checkAutoRefresh, 60 * 1000);
    return () => {
      if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);
    };
  }, [checkAutoRefresh]);

  // ---- 自定义日期逻辑 ----

  /**
   * 获取今天的日期字符串（YYYY-MM-DD）
   */
  const getTodayString = useCallback(() => {
    const parts = getBeijingDateTimeParts(new Date());
    return `${parts.year}-${parts.month}-${parts.day}`;
  }, []);

  /**
   * 获取自定义按钮文案
   */
  const getCustomButtonLabel = useCallback(() => {
    if (currentPeriod === 'custom' && appliedCustomRange.startDate && appliedCustomRange.endDate) {
      const start = formatDateDisplay(appliedCustomRange.startDate);
      const end = formatDateDisplay(appliedCustomRange.endDate);
      return `${start} - ${end}`;
    }
    return '自定义';
  }, [currentPeriod, appliedCustomRange]);

  /**
   * 验证自定义日期范围
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
   */
  const getMaxSelectableDate = useCallback(() => {
    return getBeijingRelativeDayKey(-1);
  }, []);

  /**
   * 获取自定义日期范围数据
   */
  const fetchCustomRangeData = useCallback(async (startDate, endDate) => {
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
   * 获取累计至今数据（从 2020-01-01 到当前时刻的全部历史记录）
   *
   * 走前端单次扫描路径（aggregateUsage）而非 aggregateUsageRange：
   * 后者会逐日调用 recomputeDailySummary，每天都要全量扫描日志目录，
   * 对数年跨度来说会导致数千次目录扫描，卡死 UI。
   *
   * - 防并发：通过 ref 保证同时只有一个请求
   * - 无历史日志时降级为空态，不报错
   */
  const fetchAllTimeData = useCallback(async () => {
    if (fetchingAllTimeRef.current) return;
    fetchingAllTimeRef.current = true;
    setAllTimeLoading(true);
    try {
      const result = await aggregateUsage('allTime');
      if (result.success) {
        setAllTimeData(result.data || EMPTY_USAGE_DATA);
        setError(null);
      } else {
        setError(result.error || '加载失败');
      }
    } catch (err) {
      setError(err.message || '未知错误');
    } finally {
      fetchingAllTimeRef.current = false;
      setAllTimeLoading(false);
    }
  }, []);

  // ---- 交互处理 ----

  /**
   * 处理周期切换
   * @param {string} period - 新周期
   */
  const handlePeriodChange = useCallback((period) => {
    if (period === 'custom') {
      setShowCustomDateModal((prev) => {
        const next = !prev;
        if (next) updateDatePickerPosition();
        return next;
      });
      setCustomDateError(null);
      return;
    }

    if (period === currentPeriod) return;

    setShowCustomDateModal(false);
    setCurrentPeriod(period);
    setError(null);

    // 累计至今：首次点击时懒加载（已有数据则跳过）
    if (period === 'allTime' && !allTimeData) {
      fetchAllTimeData();
    }
  }, [currentPeriod, updateDatePickerPosition, fetchAllTimeData, allTimeData]);

  /**
   * 处理自定义日期确认
   */
  const handleCustomDateConfirm = useCallback(async () => {
    const validation = validateCustomDateRange();

    if (!validation.valid) {
      setCustomDateError(validation.error);
      return;
    }

    const newRange = { ...customDateRange };

    // 首次切换自定义时，复用当前已展示数据避免空白闪烁
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
  }, [customDateRange, customData, validateCustomDateRange, fetchCustomRangeData]);

  /**
   * 处理自定义日期取消
   */
  const handleCustomDateCancel = useCallback(() => {
    setShowCustomDateModal(false);
    setCustomDateError(null);
  }, []);

  /**
   * 手动刷新
   */
  const handleRefresh = useCallback(() => {
    if (currentPeriod === 'allTime') {
      // 请求进行中时跳过，避免先清空数据却无后续请求导致 UI 卡空白
      if (fetchingAllTimeRef.current) return;
      setAllTimeData(null);
      fetchAllTimeData();
      return;
    }
    refreshPeriodData(currentPeriod, { force: true, showLoading: true });
  }, [currentPeriod, refreshPeriodData, fetchAllTimeData]);

  // 点击外部关闭 dropdown
  useEffect(() => {
    if (!showCustomDateModal) return;

    const handleClickOutside = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        handleCustomDateCancel();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showCustomDateModal, handleCustomDateCancel]);

  // dropdown 打开后跟随窗口变化更新位置
  useEffect(() => {
    if (!showCustomDateModal) return;

    updateDatePickerPosition();
    window.addEventListener('resize', updateDatePickerPosition);
    return () => window.removeEventListener('resize', updateDatePickerPosition);
  }, [showCustomDateModal, updateDatePickerPosition]);

  // ---- 派生数据 ----

  // 当前周期显示数据
  const displayData = currentPeriod === 'custom'
    ? (customData || EMPTY_USAGE_DATA)
    : currentPeriod === 'allTime'
      ? (allTimeData || EMPTY_USAGE_DATA)
      : (periodCache[currentPeriod]?.data || EMPTY_USAGE_DATA);

  // 各模型预估费用
  const costData = useMemo(() => calculateCosts(displayData.models), [displayData.models]);

  // 三个周期的 total Token 数（用于预算进度圆环）
  const periodTotals = useMemo(() => ({
    today: periodCache.today?.data?.total || 0,
    week: periodCache.week?.data?.total || 0,
    month: periodCache.month?.data?.total || 0,
  }), [periodCache]);

  // ---- 返回值 ----

  return {
    // 核心数据
    currentPeriod,
    displayData,
    costData,
    formatCost,
    periodTotals,

    // 加载与错误
    loading,
    error,
    customLoading,
    allTimeLoading,

    // 周期切换
    handlePeriodChange,
    handleRefresh,

    // 自定义日期
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

    // DOM refs
    dropdownRef,
    customTriggerRef,
  };
}
