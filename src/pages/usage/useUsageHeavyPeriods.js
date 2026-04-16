/**
 * 重周期用量后台任务 Hook
 *
 * 负责：
 * - 7天/30天/累计至今/自定义区间的后台汇总
 * - 单任务互斥与按钮禁用态
 * - 接收主进程按天推送的真实进度
 *
 * @module pages/usage/useUsageHeavyPeriods
 */

import { useState, useEffect, useRef, useCallback, startTransition } from 'react';
import { aggregateUsage } from '../../store/usageAggregator';
import {
  getBeijingDayKey,
  getBeijingRelativeDayKey,
  getDailyRefreshKey,
  formatDateDisplay,
  mapRangeErrorToMessage,
} from './usageDateUtils';

const ELAPSED_TIMER_INTERVAL_MS = 1000;
const PROGRESS_RENDER_THROTTLE_MS = 250;
const HEAVY_PERIOD_LABELS = Object.freeze({
  week: '近7天',
  month: '近30天',
  allTime: '累计至今',
  custom: '自定义区间',
});

/**
 * 生成空闲重任务状态
 * @returns {{id:number,requestId:string,status:'idle',period:null,label:string,rangeLabel:string,progressPercent:number,elapsedMs:number,totalDays:number,processedDays:number,cachedDays:number,recomputedDays:number,failedDays:number,currentDate:string,currentSource:string|null}}
 */
function createIdleHeavyTask() {
  return {
    id: 0,
    requestId: '',
    status: 'idle',
    period: null,
    label: '',
    rangeLabel: '',
    progressPercent: 0,
    elapsedMs: 0,
    totalDays: 0,
    processedDays: 0,
    cachedDays: 0,
    recomputedDays: 0,
    failedDays: 0,
    currentDate: '',
    currentSource: null
  };
}

/**
 * 构建重周期日期范围文案（仅日期范围，不含周期标题）
 * @param {'week'|'month'|'allTime'|'custom'} period - 周期
 * @param {{startDate?: string, endDate?: string}|undefined} range - 日期区间
 * @returns {string}
 */
function buildHeavyTaskRangeLabel(period, range) {
  // 累计至今没有可解释的日期范围，返回空让 UI 单独处理
  if (period === 'allTime' || !range?.startDate || !range?.endDate) {
    return '';
  }

  return `${formatDateDisplay(range.startDate)} - ${formatDateDisplay(range.endDate)}`;
}

/**
 * 构建预设周期对应的日期区间
 * @param {'week'|'month'} period - 周期
 * @returns {{startDate: string, endDate: string}}
 */
function buildPredefinedRange(period) {
  if (period === 'week') {
    return {
      startDate: getBeijingRelativeDayKey(-7),
      endDate: getBeijingRelativeDayKey(-1)
    };
  }

  return {
    startDate: getBeijingRelativeDayKey(-30),
    endDate: getBeijingRelativeDayKey(-1)
  };
}

/**
 * 创建缓存条目
 * @param {'week'|'month'|'allTime'} period - 周期
 * @param {object} data - 聚合结果
 * @returns {object}
 */
function buildCacheEntry(period, data) {
  const now = new Date();

  return {
    data,
    computedAt: now.toISOString(),
    dayKey: period === 'today' ? getBeijingDayKey(now) : undefined,
    dailyRefreshKey: period !== 'today' ? getDailyRefreshKey(now) : undefined
  };
}

/**
 * 生成前端任务 ID
 * @param {'week'|'month'|'allTime'|'custom'} period - 周期
 * @returns {string}
 */
function createTaskRequestId(period) {
  return `usage-${period}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 将进度载荷映射为新的重任务状态
 * @param {object} prev - 旧状态
 * @param {object} progress - 进度载荷
 * @param {number} elapsedMs - 当前已耗时
 * @returns {object}
 */
function buildHeavyTaskProgressState(prev, progress, elapsedMs) {
  return {
    ...prev,
    progressPercent: typeof progress.progressPercent === 'number' ? progress.progressPercent : prev.progressPercent,
    elapsedMs,
    totalDays: typeof progress.totalDays === 'number' ? progress.totalDays : prev.totalDays,
    processedDays: typeof progress.processedDays === 'number' ? progress.processedDays : prev.processedDays,
    cachedDays: typeof progress.cachedDays === 'number' ? progress.cachedDays : prev.cachedDays,
    recomputedDays: typeof progress.recomputedDays === 'number' ? progress.recomputedDays : prev.recomputedDays,
    failedDays: typeof progress.failedDays === 'number' ? progress.failedDays : prev.failedDays,
    currentDate: progress.currentDate || prev.currentDate,
    currentSource: progress.currentSource ?? prev.currentSource
  };
}

/**
 * 判断进度更新是否真的改变了可见状态
 * @param {object} prev - 旧状态
 * @param {object} next - 新状态
 * @returns {boolean}
 */
function hasHeavyTaskVisualChange(prev, next) {
  return (
    prev.progressPercent !== next.progressPercent
    || prev.elapsedMs !== next.elapsedMs
    || prev.totalDays !== next.totalDays
    || prev.processedDays !== next.processedDays
    || prev.cachedDays !== next.cachedDays
    || prev.recomputedDays !== next.recomputedDays
    || prev.failedDays !== next.failedDays
    || prev.currentDate !== next.currentDate
    || prev.currentSource !== next.currentSource
  );
}

/**
 * 重周期用量后台任务 Hook
 * @param {object} options - 依赖项
 * @param {object} options.periodCache - 预设周期缓存
 * @param {object|null} options.customData - 自定义区间数据
 * @param {(period: 'week'|'month'|'allTime', entry: object) => void} options.updatePeriodCache - 更新预设周期缓存
 * @param {(data: object) => void} options.setCustomData - 更新自定义区间数据
 * @param {(message: string|null) => void} options.setError - 更新错误提示
 * @returns {object}
 */
export default function useUsageHeavyPeriods({
  periodCache,
  customData,
  updatePeriodCache,
  setCustomData,
  setError,
}) {
  // 重周期后台任务状态
  const [heavyTask, setHeavyTask] = useState(createIdleHeavyTask);

  // 重任务耗时定时器
  const elapsedTimerRef = useRef(null);
  // 当前运行中的重任务序号，防止过期任务回写
  const heavyTaskRunIdRef = useRef(0);
  // 当前运行中的前端任务 ID，用于关联主进程进度事件
  const activeTaskRequestIdRef = useRef('');
  // 任务启动时间，用于计算已耗时
  const taskStartedAtRef = useRef(0);
  // 进度渲染节流定时器，避免缓存命中时高频刷新整页
  const progressFlushTimerRef = useRef(null);
  // 节流窗口内暂存的最新进度
  const queuedProgressRef = useRef(null);
  // 上次真正应用到 React 状态的时间戳
  const lastProgressAppliedAtRef = useRef(0);

  /**
   * 清理进度渲染节流定时器
   */
  const clearProgressFlushTimer = useCallback(() => {
    if (!progressFlushTimerRef.current) return;
    window.clearTimeout(progressFlushTimerRef.current);
    progressFlushTimerRef.current = null;
  }, []);

  /**
   * 立即提交最新进度到 React 状态
   * 为什么用 transition：
   * - 进度与耗时属于“辅助反馈”，优先级应低于用户点击/切页
   * - 这样后台汇总时，页面交互不会被进度卡片刷新抢占
   * @param {object} progress - 主进程进度数据
   */
  const commitUsageAggregationProgress = useCallback((progress) => {
    clearProgressFlushTimer();
    queuedProgressRef.current = null;
    lastProgressAppliedAtRef.current = Date.now();

    startTransition(() => {
      setHeavyTask((prev) => {
        if (prev.requestId !== progress.taskId) {
          return prev;
        }

        const elapsedMs = taskStartedAtRef.current > 0
          ? (Date.now() - taskStartedAtRef.current)
          : prev.elapsedMs;
        const next = buildHeavyTaskProgressState(prev, progress, elapsedMs);

        return hasHeavyTaskVisualChange(prev, next) ? next : prev;
      });
    });
  }, [clearProgressFlushTimer]);

  /**
   * 刷新节流窗口内缓存的最新进度
   */
  const flushQueuedUsageProgress = useCallback(() => {
    if (!queuedProgressRef.current) {
      clearProgressFlushTimer();
      return;
    }

    const latestProgress = queuedProgressRef.current;
    commitUsageAggregationProgress(latestProgress);
  }, [clearProgressFlushTimer, commitUsageAggregationProgress]);

  /**
   * 安排一次延迟进度刷新
   */
  const scheduleQueuedUsageProgress = useCallback(() => {
    if (progressFlushTimerRef.current) {
      return;
    }

    const elapsedSinceLastApply = Date.now() - lastProgressAppliedAtRef.current;
    const delay = Math.max(0, PROGRESS_RENDER_THROTTLE_MS - elapsedSinceLastApply);

    progressFlushTimerRef.current = window.setTimeout(() => {
      flushQueuedUsageProgress();
    }, delay);
  }, [flushQueuedUsageProgress]);

  /**
   * 清理耗时定时器
   */
  const clearElapsedTimer = useCallback(() => {
    if (!elapsedTimerRef.current) return;
    window.clearInterval(elapsedTimerRef.current);
    elapsedTimerRef.current = null;
  }, []);

  /**
   * 启动耗时计时器
   * 为什么单独维护耗时：
   * - 真实进度按“天”更新，某一天很慢时进度可能长时间不动
   * - 持续跳动的已耗时能让用户确认任务仍在工作，而不是又卡死了
   * @param {number} runId - 当前任务序号
   */
  const startElapsedTimer = useCallback((runId) => {
    taskStartedAtRef.current = Date.now();
    clearElapsedTimer();

    elapsedTimerRef.current = window.setInterval(() => {
      startTransition(() => {
        setHeavyTask((prev) => {
          if (prev.status !== 'running' || prev.id !== runId) {
            return prev;
          }

          return {
            ...prev,
            elapsedMs: Date.now() - taskStartedAtRef.current
          };
        });
      });
    }, ELAPSED_TIMER_INTERVAL_MS);
  }, [clearElapsedTimer]);

  /**
   * 启动新的重周期后台任务
   * @param {'week'|'month'|'allTime'|'custom'} period - 周期
   * @param {{startDate?: string, endDate?: string}|undefined} range - 日期区间
   * @returns {{id:number,requestId:string,status:'running',period:string,label:string,rangeLabel:string,progressPercent:number,elapsedMs:number,totalDays:number,processedDays:number,cachedDays:number,recomputedDays:number,failedDays:number,currentDate:string,currentSource:string|null}}
   */
  const beginHeavyTask = useCallback((period, range) => {
    const nextRunId = heavyTaskRunIdRef.current + 1;
    const requestId = createTaskRequestId(period);
    const nextTask = {
      id: nextRunId,
      requestId,
      status: 'running',
      period,
      label: HEAVY_PERIOD_LABELS[period] || '区间汇总',
      rangeLabel: buildHeavyTaskRangeLabel(period, range),
      progressPercent: 0,
      elapsedMs: 0,
      totalDays: 0,
      processedDays: 0,
      cachedDays: 0,
      recomputedDays: 0,
      failedDays: 0,
      currentDate: range?.startDate || '',
      currentSource: null
    };

    heavyTaskRunIdRef.current = nextRunId;
    activeTaskRequestIdRef.current = requestId;
    queuedProgressRef.current = null;
    lastProgressAppliedAtRef.current = 0;
    clearProgressFlushTimer();
    setHeavyTask(nextTask);
    startElapsedTimer(nextRunId);

    return nextTask;
  }, [clearProgressFlushTimer, startElapsedTimer]);

  /**
   * 结束重周期后台任务
   * @param {number} runId - 当前任务序号
   * @param {string} requestId - 前端任务 ID
   */
  const finishHeavyTask = useCallback((runId, requestId) => {
    if (heavyTaskRunIdRef.current !== runId || activeTaskRequestIdRef.current !== requestId) {
      return;
    }

    clearElapsedTimer();
    clearProgressFlushTimer();
    activeTaskRequestIdRef.current = '';
    queuedProgressRef.current = null;
    lastProgressAppliedAtRef.current = 0;
    setHeavyTask(createIdleHeavyTask());
  }, [clearElapsedTimer, clearProgressFlushTimer]);

  /**
   * 将主进程进度事件映射到当前任务状态
   * @param {object} progress - 主进程进度数据
   */
  const applyUsageAggregationProgress = useCallback((progress) => {
    if (!progress?.taskId || progress.taskId !== activeTaskRequestIdRef.current) {
      return;
    }

    const isTerminalProgress = progress.status === 'completed' || progress.status === 'failed';
    queuedProgressRef.current = progress;

    if (
      isTerminalProgress
      || (Date.now() - lastProgressAppliedAtRef.current) >= PROGRESS_RENDER_THROTTLE_MS
      || lastProgressAppliedAtRef.current === 0
    ) {
      flushQueuedUsageProgress();
      return;
    }

    scheduleQueuedUsageProgress();
  }, [flushQueuedUsageProgress, scheduleQueuedUsageProgress]);

  /**
   * 获取自定义日期范围数据
   * @param {string} startDate - 开始日期
   * @param {string} endDate - 结束日期
   * @param {string} taskId - 前端任务 ID
   * @returns {Promise<{success: boolean, data?: object, skipped?: boolean, error?: string}>}
   */
  const fetchCustomRangeData = useCallback(async (startDate, endDate, taskId) => {
    if (!window.electronAPI?.aggregateUsageRange) {
      return { success: true, data: null, skipped: true };
    }

    try {
      return await window.electronAPI.aggregateUsageRange({
        taskId,
        startDate,
        endDate,
        timezone: 'Asia/Shanghai'
      });
    } catch (err) {
      return { success: false, error: err.message || '请求异常' };
    }
  }, []);

  /**
   * 获取重周期数据
   * @param {'week'|'month'|'allTime'|'custom'} period - 周期
   * @param {{startDate?: string, endDate?: string}|undefined} range - 日期区间
   * @param {string} taskId - 前端任务 ID
   * @returns {Promise<{success: boolean, data?: object, skipped?: boolean, error?: string}>}
   */
  const fetchHeavyPeriodData = useCallback(async (period, range, taskId) => {
    if (period === 'custom') {
      return fetchCustomRangeData(range?.startDate, range?.endDate, taskId);
    }

    if (window.electronAPI?.aggregateUsagePeriod) {
      try {
        return await window.electronAPI.aggregateUsagePeriod({
          taskId,
          period,
          timezone: 'Asia/Shanghai'
        });
      } catch (err) {
        return { success: false, error: err.message || '请求异常' };
      }
    }

    return aggregateUsage(period);
  }, [fetchCustomRangeData]);

  /**
   * 执行重周期后台任务
   * @param {'week'|'month'|'allTime'|'custom'} period - 周期
   * @param {{startDate?: string, endDate?: string}|undefined} range - 日期区间
   * @param {{hasFallbackData?: boolean}} [options] - 执行选项
   */
  const runHeavyPeriodTask = useCallback(async (period, range, options = {}) => {
    if (activeTaskRequestIdRef.current) {
      return {
        success: false,
        busy: true,
        error: 'HEAVY_TASK_RUNNING'
      };
    }

    const task = beginHeavyTask(period, range);
    const hasFallbackData = typeof options.hasFallbackData === 'boolean'
      ? options.hasFallbackData
      : period === 'custom'
        ? Boolean(customData)
        : Boolean(periodCache[period]?.data);

    try {
      const result = await fetchHeavyPeriodData(period, range, task.requestId);

      if (activeTaskRequestIdRef.current !== task.requestId) {
        return {
          success: false,
          busy: true,
          error: 'TASK_SUPERSEDED'
        };
      }

      if (result.success && result.data) {
        if (period === 'custom') {
          setCustomData(result.data);
        } else {
          updatePeriodCache(period, buildCacheEntry(period, result.data));
        }

        setError(null);
        return result;
      }

      if (result.success && result.skipped) {
        setError(null);
        return result;
      }

      const mappedError = mapRangeErrorToMessage(result.error);
      setError(hasFallbackData
        ? `数据获取失败：${mappedError}，显示上次数据`
        : mappedError);
      return {
        ...result,
        error: mappedError
      };
    } catch (err) {
      const mappedError = mapRangeErrorToMessage(err.message);
      setError(hasFallbackData
        ? `数据获取失败：${mappedError}，显示上次数据`
        : mappedError);
      return {
        success: false,
        error: mappedError
      };
    } finally {
      finishHeavyTask(task.id, task.requestId);
    }
  }, [
    beginHeavyTask,
    customData,
    fetchHeavyPeriodData,
    finishHeavyTask,
    periodCache,
    setCustomData,
    setError,
    updatePeriodCache
  ]);

  /**
   * 判断指定周期是否已有可展示数据
   * @param {'week'|'month'|'allTime'|'custom'} period - 周期
   * @returns {boolean}
   */
  const hasVisibleDataForPeriod = useCallback((period) => {
    if (period === 'custom') {
      return Boolean(customData);
    }

    return Boolean(periodCache[period]?.data);
  }, [customData, periodCache]);

  /**
   * 判断周期按钮是否应禁用
   * 为什么要禁用：
   * - 重周期只允许单任务执行，避免用户在“累计至今”计算时又触发 7 天/30 天重算
   * - 但如果该周期已有缓存，仍允许切过去看旧数据，不阻断主流程
   * @param {'today'|'week'|'month'|'allTime'|'custom'} period - 周期
   * @returns {boolean}
   */
  const isPeriodDisabled = useCallback((period) => {
    if (period === 'today' || heavyTask.status !== 'running') {
      return false;
    }

    if (heavyTask.period === period) {
      return false;
    }

    if (period === 'custom') {
      return true;
    }

    return !hasVisibleDataForPeriod(period);
  }, [hasVisibleDataForPeriod, heavyTask]);

  /**
   * 获取禁用提示文案
   * @param {'today'|'week'|'month'|'allTime'|'custom'} period - 周期
   * @returns {string}
   */
  const getPeriodDisabledReason = useCallback((period) => {
    if (!isPeriodDisabled(period)) {
      return '';
    }

    const targetLabel = period === 'custom'
      ? '新的自定义区间'
      : HEAVY_PERIOD_LABELS[period] || '该周期';

    return `正在后台汇总${heavyTask.label}，完成前暂不计算${targetLabel}`;
  }, [heavyTask.label, isPeriodDisabled]);

  useEffect(() => {
    if (!window.electronAPI?.onUsageAggregationProgress) {
      return undefined;
    }

    const unsubscribe = window.electronAPI.onUsageAggregationProgress((progress) => {
      applyUsageAggregationProgress(progress);
    });

    return () => unsubscribe();
  }, [applyUsageAggregationProgress]);

  useEffect(() => {
    return () => {
      clearElapsedTimer();
      clearProgressFlushTimer();
      activeTaskRequestIdRef.current = '';
    };
  }, [clearElapsedTimer, clearProgressFlushTimer]);

  return {
    heavyTask,
    isPeriodDisabled,
    getPeriodDisabledReason,
    runHeavyPeriodTask,
  };
}

export {
  HEAVY_PERIOD_LABELS,
  buildPredefinedRange,
}
