/**
 * 用量监测缓存工具函数
 *
 * 负责：
 * - 本地缓存读写（localStorage）
 * - 缓存新鲜度判断（今日/7天/30天）
 *
 * @module pages/usage/useUsageCache
 */

import { getBeijingDayKey, getDailyRefreshKey } from './usageDateUtils';

const TODAY_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const USAGE_CACHE_STORAGE_KEY = 'usage-monitor-cache-v3';

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

export {
  TODAY_REFRESH_INTERVAL_MS,
  createEmptyCache,
  readUsageCache,
  writeUsageCache,
  shouldRefreshPeriod,
};
