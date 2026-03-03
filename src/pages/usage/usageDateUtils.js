/**
 * 用量监测日期工具函数
 *
 * 负责：
 * - 北京时间日期计算（年月日、日期 key、日起点）
 * - 日批次刷新 key 计算
 * - 日期格式化显示
 * - 后端错误码映射
 *
 * @module pages/usage/usageDateUtils
 */

const DAILY_REFRESH_MINUTE = 5

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
 * 获取"日批次刷新 key"
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
 * 格式化日期显示为 M/D 格式
 * @param {string} dateStr - YYYY-MM-DD 格式日期
 * @returns {string}
 */
function formatDateDisplay(dateStr) {
  if (!dateStr) return '';
  const [, month, day] = dateStr.split('-');
  return `${Number(month)}/${Number(day)}`;
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

export {
  DAILY_REFRESH_MINUTE,
  getBeijingDateTimeParts,
  getBeijingDayKey,
  getBeijingRelativeDayKey,
  getBeijingDayStart,
  getDailyRefreshKey,
  formatDateDisplay,
  mapRangeErrorToMessage,
};
