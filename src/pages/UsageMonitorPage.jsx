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

import { useState, useEffect, useRef, useCallback } from 'react';
import { aggregateUsage } from '../store/usageAggregator';
import { PieChart, Legend, DetailTable } from './usage/components/UsageDisplayComponents';
import './usage.css';
import PageShell from '../components/PageShell';

const PERIODS = ['today', 'week', 'month', 'custom'];
const TODAY_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const DAILY_REFRESH_MINUTE = 5;
const USAGE_CACHE_STORAGE_KEY = 'usage-monitor-cache-v3';

const EMPTY_USAGE_DATA = {
  total: 0,
  input: 0,
  output: 0,
  cache: 0,
  models: [],
  distribution: [],
  isExtremeScenario: false,
  modelCount: 0
};

/**
 * 获取北京时间年月日时分
 * @param {Date} date - 参考时间
 * @returns {{year: string, month: string, day: string, hour: number, minute: number}}
 */
function getBeijingDateTimeParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });

  const parts = formatter.formatToParts(date);
  const map = {};

  for (const part of parts) {
    if (part.type === 'year' || part.type === 'month' || part.type === 'day' || part.type === 'hour' || part.type === 'minute') {
      map[part.type] = part.value;
    }
  }

  return {
    year: map.year,
    month: map.month,
    day: map.day,
    hour: Number(map.hour),
    minute: Number(map.minute)
  };
}

/**
 * 获取北京时间日期 key（YYYY-MM-DD）
 * @param {Date} date - 参考时间
 * @returns {string}
 */
function getBeijingDayKey(date = new Date()) {
  const parts = getBeijingDateTimeParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * 获取北京时间相对日期 key（YYYY-MM-DD）
 * @param {number} offsetDays - 相对今天的偏移天数（-1 表示昨天）
 * @param {Date} date - 参考时间
 * @returns {string}
 */
function getBeijingRelativeDayKey(offsetDays, date = new Date()) {
  const dayStart = getBeijingDayStart(date);
  dayStart.setUTCDate(dayStart.getUTCDate() + offsetDays);
  return getBeijingDayKey(dayStart);
}

/**
 * 获取北京时间当日 00:00 对应的 UTC Date
 * @param {Date} date - 参考时间
 * @returns {Date}
 */
function getBeijingDayStart(date = new Date()) {
  const parts = getBeijingDateTimeParts(date);
  return new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00+08:00`);
}

/**
 * 获取“日批次刷新 key”
 * - 00:05 之前仍视为前一日批次
 * - 00:05 及之后视为当日批次
 * @param {Date} date - 参考时间
 * @returns {string}
 */
function getDailyRefreshKey(date = new Date()) {
  const parts = getBeijingDateTimeParts(date);
  const dayStart = getBeijingDayStart(date);

  // 00:05 前不应触发新一轮 7天/30天重算
  if (parts.hour === 0 && parts.minute < DAILY_REFRESH_MINUTE) {
    dayStart.setUTCDate(dayStart.getUTCDate() - 1);
  }

  return getBeijingDayKey(dayStart);
}

/**
 * 创建空缓存容器
 * @returns {{today: null|object, week: null|object, month: null|object}}
 */
function createEmptyCache() {
  return {
    today: null,
    week: null,
    month: null
  };
}

/**
 * 读取本地缓存
 * @returns {{today: null|object, week: null|object, month: null|object}}
 */
function readUsageCache() {
  try {
    const raw = window.localStorage.getItem(USAGE_CACHE_STORAGE_KEY);
    if (!raw) return createEmptyCache();

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return createEmptyCache();

    return {
      today: parsed.today || null,
      week: parsed.week || null,
      month: parsed.month || null
    };
  } catch {
    return createEmptyCache();
  }
}

/**
 * 写入本地缓存
 * @param {{today: null|object, week: null|object, month: null|object}} cache - 缓存数据
 */
function writeUsageCache(cache) {
  try {
    window.localStorage.setItem(USAGE_CACHE_STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // localStorage 写失败时静默，避免影响主流程
  }
}

/**
 * 判断今日缓存是否新鲜
 * @param {object|null} entry - 周期缓存条目
 * @param {Date} now - 当前时间
 * @returns {boolean}
 */
function isTodayCacheFresh(entry, now) {
  if (!entry?.computedAt || !entry?.dayKey) return false;

  // 跨日后即视为过期，避免沿用前一日数据
  if (entry.dayKey !== getBeijingDayKey(now)) {
    return false;
  }

  const computedAt = new Date(entry.computedAt);
  if (Number.isNaN(computedAt.getTime())) return false;

  return (now.getTime() - computedAt.getTime()) < TODAY_REFRESH_INTERVAL_MS;
}

/**
 * 判断 7天/30天缓存是否新鲜
 * @param {object|null} entry - 周期缓存条目
 * @param {Date} now - 当前时间
 * @returns {boolean}
 */
function isRangeCacheFresh(entry, now) {
  if (!entry?.dailyRefreshKey) return false;
  return entry.dailyRefreshKey === getDailyRefreshKey(now);
}

/**
 * 判断周期是否需要重算
 * @param {'today'|'week'|'month'} period - 周期
 * @param {object|null} entry - 周期缓存条目
 * @param {Date} now - 当前时间
 * @returns {boolean}
 */
function shouldRefreshPeriod(period, entry, now) {
  if (!entry?.data) return true;

  if (period === 'today') {
    return !isTodayCacheFresh(entry, now);
  }

  return !isRangeCacheFresh(entry, now);
}

/**
 * 将后端错误码映射为用户可读文案
 * @param {string|undefined} errorCode - 后端错误码或错误消息
 * @returns {string}
 */
function mapRangeErrorToMessage(errorCode) {
  switch (errorCode) {
    case 'INVALID_DATE_RANGE':
      return '日期范围无效，请检查开始和结束日期'
    case 'DATE_OUT_OF_RANGE':
      return '结束日期不能为今天或未来日期'
    case 'INVALID_TIMEZONE':
      return '时区参数无效，仅支持北京时间'
    case 'PERMISSION_DENIED':
      return '无权限读取日志目录，请检查系统权限'
    case 'RECOMPUTE_FAILED':
    case 'RECOMPUTE_EMPTY':
    case 'AGGREGATE_FAILED':
      return '区间数据聚合失败，请稍后重试'
    default:
      return errorCode || '数据获取失败'
  }
}

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

  // 三个周期的数据缓存（内存态 + 本地持久化）
  const [periodCache, setPeriodCache] = useState(() => readUsageCache());

  // 自定义日期范围的数据（独立状态，不缓存到本地存储）
  const [customData, setCustomData] = useState(null);

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

    // 只在“强制刷新”或“缓存过期”时重算
    if (!force && !shouldRefreshPeriod(period, cacheEntry, now)) {
      return;
    }

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
   * 格式化日期显示为 M/D 格式
   * @param {string} dateStr - YYYY-MM-DD 格式日期
   * @returns {string}
   */
  const formatDateDisplay = (dateStr) => {
    if (!dateStr) return '';
    const [year, month, day] = dateStr.split('-');
    return `${Number(month)}/${Number(day)}`;
  };

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

    // 1. 开始/结束必填
    if (!startDate || !endDate) {
      return { valid: false, error: '请选择开始日期和结束日期' };
    }

    const start = new Date(startDate);
    const end = new Date(endDate);
    const today = new Date(getTodayString());

    // 2. 开始日期 <= 结束日期
    if (start > end) {
      return { valid: false, error: '开始日期不能晚于结束日期' };
    }

    // 3. 结束日期 < 今天（今天和未来都不允许）
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
    // 执行日期校验
    const validation = validateCustomDateRange();

    if (!validation.valid) {
      // 校验失败：显示错误文案，不触发数据更新
      setCustomDateError(validation.error);
      return;
    }

    // 校验通过：应用日期范围，关闭弹窗
    const newRange = { ...customDateRange };

    // 首次切换自定义时，先复用当前已展示数据，避免出现“空白闪烁”
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

    // 开始加载自定义日期数据
    setCustomLoading(true);

    try {
      const result = await fetchCustomRangeData(newRange.startDate, newRange.endDate);

      if (result.success && result.data) {
        // 成功：更新自定义数据，清除错误
        setCustomData(result.data);
        setError(null);
      } else if (result.success && result.skipped) {
        // 后端未接入时仅完成交互，不展示错误
        setError(null);
      } else {
        // 失败：保留上一次有效展示（如果有），显示错误提示
        const mappedError = mapRangeErrorToMessage(result.error);
        const hasFallback = Boolean(customData);
        setError(hasFallback
          ? `数据获取失败：${mappedError}，显示上次数据`
          : mappedError);
      }
    } catch (err) {
      // 异常：保留上一次有效展示，显示错误提示
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
    // 不修改当前周期和日期范围
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

  // 格式化数字显示（带单位）
  const formatMetricValue = (num) => {
    if (num >= 1000000000) {
      return (num / 1000000000).toFixed(1) + 'B';
    }
    if (num >= 1000000) {
      return (num / 1000000).toFixed(1) + 'M';
    }
    if (num >= 1000) {
      return (num / 1000).toFixed(1) + 'K';
    }
    return num.toString();
  };

  return (
    <PageShell title="用量监测" subtitle="追踪各模型的 Token 消耗">
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
          <div
            className="date-picker-dropdown"
            style={{ left: `${datePickerPosition.left}px`, top: `${datePickerPosition.top}px` }}
          >
            {/* 日期输入区域：左右两个输入框 + 中间分隔符 */}
            <div className="date-inputs">
              <div className="date-input-wrapper">
                <div className="date-input-label">开始日期</div>
                <input
                  type="date"
                  className="date-input"
                  value={customDateRange.startDate}
                  max={getMaxSelectableDate()}
                  onChange={(e) => {
                    setCustomDateRange((prev) => ({
                      ...prev,
                      startDate: e.target.value
                    }));
                    // 用户修改时清除错误提示
                    if (customDateError) setCustomDateError(null);
                  }}
                />
              </div>
              <div className="date-separator">~</div>
              <div className="date-input-wrapper">
                <div className="date-input-label">结束日期</div>
                <input
                  type="date"
                  className="date-input"
                  value={customDateRange.endDate}
                  max={getMaxSelectableDate()}
                  onChange={(e) => {
                    setCustomDateRange((prev) => ({
                      ...prev,
                      endDate: e.target.value
                    }));
                    // 用户修改时清除错误提示
                    if (customDateError) setCustomDateError(null);
                  }}
                />
              </div>
            </div>
            {/* 错误提示 */}
            {customDateError && (
              <div className="date-picker-error">
                <span>⚠️ {customDateError}</span>
              </div>
            )}
            {/* 操作按钮区 */}
            <div className="date-picker-actions">
              <button className="btn btn--secondary" onClick={handleCustomDateCancel}>
                取消
              </button>
              <button className="btn btn--primary" onClick={handleCustomDateConfirm}>
                确定
              </button>
            </div>
          </div>
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


      {/* 图表行：左侧指标卡(2x2) + 右侧饼图 */}
      <div className="chart-row">
        {/* 左侧：2x2 指标卡 */}
        <div className="metrics-column">
          <div className="metric-card">
            <div className="metric-label">总 Token</div>
            <div className="metric-value">{formatMetricValue(displayData.total)}</div>
          </div>
          <div className="metric-card">
            <div className="metric-label">输入</div>
            <div className="metric-value">{formatMetricValue(displayData.input)}</div>
          </div>
          <div className="metric-card">
            <div className="metric-label">输出</div>
            <div className="metric-value">{formatMetricValue(displayData.output)}</div>
          </div>
          <div className="metric-card">
            <div className="metric-label">缓存命中</div>
            <div className="metric-value">{formatMetricValue(displayData.cache)}</div>
          </div>
        </div>

        {/* 右侧：饼图 */}
        <div className="chart-container">
          <div className="chart-title">
            模型占比
          </div>
          <PieChart
            distribution={displayData.distribution}
            total={formatMetricValue(displayData.total)}
          />
          <Legend distribution={displayData.distribution} />
        </div>
      </div>

      {/* 明细表格 */}
      <div className="card">
        <div className="card-header">
          <div className="card-title">
            {displayData.isExtremeScenario
              ? `模型用量明细（${displayData.modelCount}个模型，已展开）`
              : '模型用量明细'}
          </div>
        </div>
        <div className="card-body" style={{ padding: 0 }}>
          <DetailTable models={displayData.models} />
        </div>
      </div>
    </PageShell>
  );
}
