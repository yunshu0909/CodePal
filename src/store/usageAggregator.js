/**
 * 用量数据聚合器
 *
 * 负责：
 * - 扫描并聚合 Claude 和 Codex 的日志数据
 * - 按模型统计 Token 使用量
 * - 生成用于展示的视图数据
 *
 * @module store/usageAggregator
 */

import { parseClaudeLog, parseCodexTokenSnapshot, calculateTotalTokens } from './logParser.js';

// 模型颜色映射表（每个模型唯一颜色，避免冲突）
const MODEL_COLORS = {
  'opus': '#f59e0b',           // 琥珀色（区别于 codex 的蓝色）
  'claude-opus': '#f59e0b',
  'sonnet': '#6366f1',         // 靛紫色
  'claude-sonnet': '#6366f1',
  'haiku': '#8b5cf6',          // 紫色
  'claude-haiku': '#8b5cf6',
  'claude': '#ec4899',         // 粉色
  'gpt-5': '#e67e22',          // 橙色
  'gpt-4o': '#f97316',         // 橙红色
  'gpt-4': '#fbbf24',          // 黄色（与 gpt-3.5 互换，避免与 opus 琥珀色太接近）
  'gpt-3.5': '#f59e0b',        // 琥珀色
  'kimi': '#16a34a',           // 绿色
  'kimi-pro': '#22c55e',
  'deepseek': '#a855f7',       // 紫罗兰
  'gemini': '#dc2626',         // 红色
  'qwen': '#10b981',           // 翠绿色
  'yi': '#ec4899',             // 粉色
  'llama': '#06b6d4',          // 青色
  'mistral': '#fbbf24',        // 黄色
  'codex': '#3b82f6',          // 蓝色
  'default': '#8b919a'         // 灰色
};

// Codex 会话 ID（UUID）匹配规则
const CODEX_SESSION_ID_REGEX = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * 获取北京时间日期（YYYY-MM-DD）
 * @param {Date} date - 参考时间
 * @returns {{year: string, month: string, day: string}} 北京时间的年月日
 */
function getBeijingDateParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });

  const parts = formatter.formatToParts(date);
  const map = {};
  for (const part of parts) {
    if (part.type === 'year' || part.type === 'month' || part.type === 'day') {
      map[part.type] = part.value;
    }
  }

  return {
    year: map.year,
    month: map.month,
    day: map.day
  };
}

/**
 * 根据周期获取时间窗口（北京时间）
 * @param {string} period - 周期：'today' | 'week' | 'month'
 * @returns {{start: Date, end: Date}} 时间窗口
 */
function getBeijingTimeWindow(period) {
  const now = new Date();
  const { year, month, day } = getBeijingDateParts(now);
  const todayStart = new Date(`${year}-${month}-${day}T00:00:00+08:00`);

  const start = new Date(todayStart);
  let end = new Date(now);

  switch (period) {
    case 'today':
      // [今日 00:00, 当前时刻)
      break;
    case 'week':
      // [今日-7天 00:00, 今日 00:00)，不含今日
      start.setUTCDate(start.getUTCDate() - 7);
      end = new Date(todayStart);
      break;
    case 'month':
      // [今日-30天 00:00, 今日 00:00)，不含今日
      start.setUTCDate(start.getUTCDate() - 30);
      end = new Date(todayStart);
      break;
    default:
      // 默认按 today 处理
      break;
  }

  return { start, end };
}

/**
 * 扫描 Claude 日志文件
 * @param {Date} start - 开始时间
 * @param {Date} end - 结束时间
 * @returns {Promise<Array>} 解析后的记录列表
 */
async function scanClaudeLogs(start, end) {
  const records = [];

  try {
    // 通过 IPC 调用主进程扫描文件
    if (!window.electronAPI?.scanLogFiles) {
      return records;
    }

    const result = await window.electronAPI.scanLogFiles({
      basePath: '~/.claude/projects',
      pattern: '**/*.jsonl',
      start: start.toISOString(),
      end: end.toISOString()
    });

    if (!result.success || !result.files) {
      return records;
    }
    if (result.truncated) {
      // 告警而不阻断：提醒当前统计可能因超大日志目录被截断
      console.warn('Claude log scan truncated:', {
        totalMatched: result.totalMatched,
        scannedCount: result.scannedCount
      });
    }

    // 解析每个文件
    for (const file of result.files) {
      for (const line of file.lines) {
        const record = parseClaudeLog(line);
        // 半开区间 [start, end)，避免边界重复计数
        if (record && record.timestamp >= start && record.timestamp < end) {
          records.push(record);
        }
      }
    }
  } catch (error) {
    console.error('Error scanning Claude logs:', error);
  }

  return records;
}

/**
 * 扫描 Codex 日志文件
 * @param {Date} start - 开始时间
 * @param {Date} end - 结束时间
 * @returns {Promise<Array>} 解析后的记录列表
 */
async function scanCodexLogs(start, end) {
  const records = [];

  try {
    if (!window.electronAPI?.scanLogFiles) {
      return records;
    }

    // Codex 日志按日期组织：~/.codex/sessions/YYYY/MM/DD/*.jsonl
    const result = await window.electronAPI.scanLogFiles({
      basePath: '~/.codex/sessions',
      pattern: '**/*.jsonl',
      start: start.toISOString(),
      end: end.toISOString()
    });

    if (!result.success || !result.files) {
      return records;
    }
    if (result.truncated) {
      // 告警而不阻断：提醒当前统计可能因超大日志目录被截断
      console.warn('Codex log scan truncated:', {
        totalMatched: result.totalMatched,
        scannedCount: result.scannedCount
      });
    }

    // 按 session 维护“窗口前最大累计值”和“窗口内最大累计值”
    // 目的：避免同一累计快照重复上报导致的双重计数
    const sessionSnapshots = new Map();

    // 解析每个文件
    for (const file of result.files) {
      const sessionId = extractCodexSessionId(file.path);
      const state = sessionSnapshots.get(sessionId) || { beforeWindow: null, inWindow: null };

      for (const line of file.lines) {
        const snapshot = parseCodexTokenSnapshot(line);
        if (!snapshot?.timestamp) {
          continue;
        }

        if (snapshot.timestamp < start) {
          state.beforeWindow = pickCodexMaxSnapshot(state.beforeWindow, snapshot);
          continue;
        }

        // 半开区间 [start, end)，避免边界重复计数
        if (snapshot.timestamp >= start && snapshot.timestamp < end) {
          state.inWindow = pickCodexMaxSnapshot(state.inWindow, snapshot);
        }
      }

      sessionSnapshots.set(sessionId, state);
    }

    // 使用“窗口内最大累计值 - 窗口前最大累计值”得到 session 真实增量
    for (const state of sessionSnapshots.values()) {
      if (!state.inWindow) {
        continue;
      }

      const before = state.beforeWindow || {
        inputTotal: 0,
        outputTotal: 0,
        cacheReadTotal: 0,
        totalTokens: 0
      };

      const deltaInputTotal = Math.max(0, state.inWindow.inputTotal - before.inputTotal);
      const deltaOutput = Math.max(0, state.inWindow.outputTotal - before.outputTotal);
      const deltaCacheRead = Math.max(0, state.inWindow.cacheReadTotal - before.cacheReadTotal);
      // Codex 的 input_tokens 已包含 cached_input_tokens。
      // 为了兼容当前 UI 的“总量 = input + output + cache”口径，需拆分为：
      // input(非缓存输入) + cache(缓存输入) + output。
      const deltaNonCachedInput = Math.max(0, deltaInputTotal - deltaCacheRead);
      const deltaTotal = deltaNonCachedInput + deltaOutput + deltaCacheRead;

      // 过滤零增量，避免污染模型分布与明细
      if (deltaTotal <= 0) {
        continue;
      }

      records.push({
        timestamp: state.inWindow.timestamp,
        model: state.inWindow.model,
        input: deltaNonCachedInput,
        output: deltaOutput,
        cacheRead: deltaCacheRead,
        cacheCreate: 0
      });
    }
  } catch (error) {
    console.error('Error scanning Codex logs:', error);
  }

  return records;
}

/**
 * 从 Codex 日志路径提取 sessionId
 * @param {string} filePath - 日志文件路径
 * @returns {string} sessionId（提取失败时回退为文件 stem）
 */
function extractCodexSessionId(filePath) {
  const normalizedPath = typeof filePath === 'string' ? filePath : '';
  const fileName = normalizedPath.split(/[\\/]/).pop() || '';
  const stem = fileName.replace(/\.jsonl$/i, '');
  const matched = stem.match(CODEX_SESSION_ID_REGEX);
  return (matched?.[1] || stem || 'unknown-codex-session').toLowerCase();
}

/**
 * 选择累计值更大的 Codex 快照
 * @param {object|null} current - 现有快照
 * @param {object} incoming - 新快照
 * @returns {object} 累计值更大的快照
 */
function pickCodexMaxSnapshot(current, incoming) {
  if (!current) {
    return incoming;
  }

  if (incoming.totalTokens > current.totalTokens) {
    return incoming;
  }

  // 同总量时取更新时间更晚的快照，规避日志写入顺序抖动
  if (incoming.totalTokens === current.totalTokens && incoming.timestamp > current.timestamp) {
    return incoming;
  }

  return current;
}

/**
 * 按模型聚合 Token 使用量
 * @param {Array} records - 解析后的记录列表
 * @returns {Map<string, object>} 聚合结果
 */
function aggregateByModel(records) {
  const aggregated = new Map();

  for (const record of records) {
    const model = record.model || 'unknown';

    if (!aggregated.has(model)) {
      aggregated.set(model, {
        name: model,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheCreate: 0,
        total: 0,
        count: 0
      });
    }

    const modelData = aggregated.get(model);
    modelData.input += record.input || 0;
    modelData.output += record.output || 0;
    modelData.cacheRead += record.cacheRead || 0;
    modelData.cacheCreate += record.cacheCreate || 0;
    modelData.total += calculateTotalTokens(record);
    modelData.count += 1;
  }

  return aggregated;
}

/**
 * 获取模型颜色
 * @param {string} model - 模型名称
 * @returns {string} 颜色代码
 */
function getModelColor(model) {
  const normalized = model.toLowerCase();

  // 直接匹配
  if (MODEL_COLORS[normalized]) {
    return MODEL_COLORS[normalized];
  }

  // 部分匹配
  for (const [key, color] of Object.entries(MODEL_COLORS)) {
    if (normalized.includes(key)) {
      return color;
    }
  }

  return MODEL_COLORS.default;
}

/**
 * 生成视图数据
 * 规则：
 * - 模型数 <= 5：饼图展示全部模型（每个模型单独一项）
 * - 模型数 > 5：饼图展示 Top 5 + 其他（合并第6名及以后）
 * @param {Map<string, object>} aggregated - 聚合后的数据
 * @returns {object} 视图数据
 */
function generateViewData(aggregated) {
  // 过滤掉总消耗为 0 的模型，避免在饼图中展示无效项
  const nonZeroModels = Array.from(aggregated.values())
    .filter(model => model.total > 0);

  // 转换为数组并排序（总 Token 降序；并列时模型名升序，避免 TopN 抖动）
  const models = nonZeroModels
    .sort((a, b) => (b.total - a.total) || a.name.localeCompare(b.name))
    .map(model => ({
      ...model,
      color: getModelColor(model.name)
    }));

  const total = models.reduce((sum, m) => sum + m.total, 0);
  const totalInput = models.reduce((sum, m) => sum + m.input, 0);
  const totalOutput = models.reduce((sum, m) => sum + m.output, 0);
  const totalCache = models.reduce((sum, m) => sum + m.cacheRead + m.cacheCreate, 0);

  // 使用最大余数法计算百分比，确保总和为 100%
  const modelsWithPercent = calculatePercentagesWithLargestRemainder(models, total);

  // 判断是否极端场景（模型数 > 5）
  const isExtremeScenario = models.length > 5;
  let distribution = [];

  if (!isExtremeScenario) {
    // ≤5 个模型：全部单独展示
    distribution = modelsWithPercent.map(model => ({
      name: model.name,
      percent: model.percent,
      displayPercent: formatPercentDisplay(model.percent, model.total, total),
      color: model.color,
      key: model.name
    }));
  } else {
    // >5 个模型：Top 5 + 其他
    const topModels = modelsWithPercent.slice(0, 5);
    const otherModels = modelsWithPercent.slice(5);

    distribution = topModels.map(model => ({
      name: model.name,
      percent: model.percent,
      displayPercent: formatPercentDisplay(model.percent, model.total, total),
      color: model.color,
      key: model.name
    }));

    const othersTotal = otherModels.reduce((sum, model) => sum + model.total, 0);
    const othersPercent = othersTotal > 0
      ? 100 - topModels.reduce((sum, m) => sum + m.percent, 0) // 确保总和为 100
      : 0;

    // 只要存在其他模型（无论占比多小），都展示“其他”项
    if (otherModels.length > 0) {
      distribution.push({
        name: `其他 (${otherModels.length}个模型)`,
        percent: othersPercent,
        displayPercent: formatPercentDisplay(othersPercent, othersTotal, total),
        color: MODEL_COLORS.default,
        key: 'others'
      });
    }
  }

  return {
    total,
    input: totalInput,
    output: totalOutput,
    cache: totalCache,
    models,
    distribution,
    isExtremeScenario,
    modelCount: models.length
  };
}

/**
 * 使用最大余数法计算百分比，确保总和为 100%
 * @param {Array} models - 模型数据数组
 * @param {number} total - 总 Token 数
 * @returns {Array} 带百分比的模型数组
 */
function calculatePercentagesWithLargestRemainder(models, total) {
  if (total === 0 || models.length === 0) {
    return models.map(m => ({ ...m, percent: 0 }));
  }

  // 1. 计算原始百分比和小数部分
  const withFraction = models.map(model => {
    const exactPercent = (model.total / total) * 100;
    const floorPercent = Math.floor(exactPercent);
    const fraction = exactPercent - floorPercent;
    return {
      ...model,
      exactPercent,
      floorPercent,
      fraction
    };
  });

  // 2. 先分配 floor 值
  let remaining = 100 - withFraction.reduce((sum, m) => sum + m.floorPercent, 0);

  // 3. 按小数部分降序，依次加 1，直到分完剩余的百分比
  const sortedByFraction = withFraction
    .map((m, index) => ({ ...m, originalIndex: index }))
    .sort((a, b) => b.fraction - a.fraction || b.total - a.total);

  for (let i = 0; i < remaining && i < sortedByFraction.length; i++) {
    sortedByFraction[i].floorPercent += 1;
  }

  // 4. 恢复原顺序并返回
  return sortedByFraction
    .sort((a, b) => a.originalIndex - b.originalIndex)
    .map(m => ({
      ...m,
      percent: m.floorPercent
    }));
}

/**
 * 格式化百分比显示
 * - 占比 > 0 但 < 1% 显示为 "<1%"
 * - 占比 = 0 显示为 "0%"
 * @param {number} percent - 计算后的百分比
 * @param {number} modelTotal - 该模型的 Token 数
 * @param {number} grandTotal - 总 Token 数
 * @returns {string} 格式化后的显示文本
 */
function formatPercentDisplay(percent, modelTotal, grandTotal) {
  if (percent === 0 && modelTotal > 0 && grandTotal > 0) {
    return '<1%';
  }
  return percent + '%';
}

/**
 * 聚合用量数据
 * 主入口函数
 * @param {string} period - 周期：'today' | 'week' | 'month'
 * @returns {Promise<{success: boolean, data?: object, error?: string}>}
 */
export async function aggregateUsage(period) {
  try {
    // 参数校验
    if (!['today', 'week', 'month'].includes(period)) {
      return { success: false, error: 'INVALID_PERIOD' };
    }

    // 1. 计算时间窗口（北京时间）
    const { start, end } = getBeijingTimeWindow(period);

    // 2. 扫描日志文件
    const [claudeRecords, codexRecords] = await Promise.all([
      scanClaudeLogs(start, end),
      scanCodexLogs(start, end)
    ]);

    // 合并所有记录
    const allRecords = [...claudeRecords, ...codexRecords];

    // 3. 按模型聚合
    const aggregated = aggregateByModel(allRecords);

    // 4. 生成视图数据
    const viewData = generateViewData(aggregated);

    return {
      success: true,
      data: {
        ...viewData,
        period,
        startTime: start.toISOString(),
        endTime: end.toISOString(),
        recordCount: allRecords.length
      }
    };
  } catch (error) {
    console.error('Error aggregating usage:', error);
    return { success: false, error: error.message };
  }
}

/**
 * 格式化数字显示
 * @param {number} num - 数字
 * @returns {string} 格式化后的字符串
 */
export function formatNumber(num) {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + 'M';
  }
  if (num >= 1000) {
    return (num / 1000).toFixed(1) + 'K';
  }
  return num.toString();
}

/**
 * 格式化百分比显示
 * @param {number} percent - 百分比
 * @returns {string} 格式化后的字符串
 */
export function formatPercent(percent) {
  return percent + '%';
}
