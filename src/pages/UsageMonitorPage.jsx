/**
 * 用量监测页面
 *
 * 负责：
 * - 展示 Token 用量数据（今日/近7天/近30天）
 * - 饼图展示模型分布（正常场景展示全部，极端场景展示 Top 5 + 其他）
 * - 明细表格展示全部模型数据
 * - 自动刷新机制
 *
 * @module pages/UsageMonitorPage
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { aggregateUsage, formatNumber } from '../store/usageAggregator';
import './usage.css';

const PERIODS = ['today', 'week', 'month'];
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
 * 用量监测页面组件
 * @returns {JSX.Element}
 */
export default function UsageMonitorPage() {
  // 当前周期：'today' | 'week' | 'month'
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

  // 自动刷新定时器
  const refreshTimerRef = useRef(null);

  // 避免闭包读取旧缓存
  const periodCacheRef = useRef(periodCache);

  // 避免闭包读取旧周期
  const currentPeriodRef = useRef(currentPeriod);

  // 防止同周期并发重算
  const refreshingSetRef = useRef(new Set());

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
   * 处理周期切换
   * @param {string} period - 新周期
   */
  const handlePeriodChange = (period) => {
    if (period === currentPeriod) return;
    setCurrentPeriod(period);
    setError(null);
  };

  /**
   * 手动刷新
   */
  const handleRefresh = () => {
    refreshPeriodData(currentPeriod, { force: true, showLoading: true });
  };

  // 当前周期显示数据：优先读取缓存，缺省回退空态
  const displayData = periodCache[currentPeriod]?.data || EMPTY_USAGE_DATA;

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
    <div className="usage-content">
      {/* 页面标题 */}
      <div className="usage-header">
        <h1>用量监测</h1>
        <p>追踪各模型的 Token 消耗</p>
      </div>

      {/* 工具栏 - 分段控制器 */}
      <div className="toolbar">
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
        </div>
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="error-banner">
          <span>⚠️ {error}</span>
          <button onClick={handleRefresh}>重试</button>
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
    </div>
  );
}

/**
 * 饼图组件
 * @param {Object} props
 * @param {Array} props.distribution - 分布数据
 * @param {string} props.total - 格式化后的总值
 * @returns {JSX.Element}
 */
function PieChart({ distribution, total }) {
  const CIRCUMFERENCE = 251.2; // 2 * PI * 40

  // 空状态
  if (!distribution || distribution.length === 0) {
    return (
      <div className="pie-chart">
        <svg className="pie-svg" viewBox="0 0 100 100">
          <circle cx="50" cy="50" r="40" fill="none" stroke="#e2e5ea" strokeWidth="20" />
        </svg>
        <div className="pie-center">
          <div className="pie-total">0</div>
          <div className="pie-unit">tokens</div>
        </div>
      </div>
    );
  }

  let accumulatedPercent = 0;

  return (
    <div className="pie-chart">
      <svg className="pie-svg" viewBox="0 0 100 100">
        {distribution.map((item, index) => {
          const dashArray = (item.percent / 100) * CIRCUMFERENCE;
          const dashOffset = -(accumulatedPercent / 100) * CIRCUMFERENCE;
          accumulatedPercent += item.percent;

          return (
            <circle
              key={item.key || index}
              cx="50"
              cy="50"
              r="40"
              fill="none"
              stroke={item.color}
              strokeWidth="20"
              strokeDasharray={`${dashArray} ${CIRCUMFERENCE}`}
              strokeDashoffset={dashOffset}
            />
          );
        })}
      </svg>
      <div className="pie-center">
        <div className="pie-total">{total}</div>
        <div className="pie-unit">tokens</div>
      </div>
    </div>
  );
}

/**
 * 图例组件
 * @param {Object} props
 * @param {Array} props.distribution - 分布数据
 * @returns {JSX.Element}
 */
function Legend({ distribution }) {
  if (!distribution || distribution.length === 0) {
    return <div className="legend" />;
  }

  return (
    <div className="legend">
      {distribution.map((item) => (
        <div key={item.key} className="legend-item">
          <div className="legend-dot" style={{ backgroundColor: item.color }} />
          <span>{item.name} {item.displayPercent || item.percent + '%'}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * 明细表格组件
 * @param {Object} props
 * @param {Array} props.models - 模型数据列表
 * @returns {JSX.Element}
 */
function DetailTable({ models }) {
  if (!models || models.length === 0) {
    return (
      <table className="data-table">
        <thead>
          <tr>
            <th>模型</th>
            <th className="number">总 Token</th>
            <th className="number">输入</th>
            <th className="number">输出</th>
            <th className="number">缓存命中</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td colSpan="5" style={{ textAlign: 'center', padding: '40px', color: '#8b919a' }}>
              暂无数据
            </td>
          </tr>
        </tbody>
      </table>
    );
  }

  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>模型</th>
          <th className="number">总 Token</th>
          <th className="number">输入</th>
          <th className="number">输出</th>
          <th className="number">缓存命中</th>
        </tr>
      </thead>
      <tbody>
        {models.map((model) => (
          <tr key={model.name}>
            <td>
              <div className="model-name">
                <div
                  className="model-dot"
                  style={{ backgroundColor: model.color }}
                />
                {model.name}
              </div>
            </td>
            <td className="number">{formatNumber(model.total)}</td>
            <td className="number">{formatNumber(model.input)}</td>
            <td className="number">{formatNumber(model.output)}</td>
            <td className="number">{formatNumber(model.cacheRead + model.cacheCreate)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
