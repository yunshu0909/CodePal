/**
 * 用量目标管理 Hook
 *
 * 负责：
 * - 通过 electron-store（主进程）持久化每日 Token 目标
 * - 自动计算周目标（×7）和月目标（×30）
 * - 管理"暂不设定"状态
 *
 * @module pages/usage/useUsageGoal
 */

import { useState, useCallback, useMemo, useEffect } from 'react';

const STORE_KEY = 'usageGoal';
const DISMISSED_STORE_KEY = 'usageGoalDismissed';

/**
 * 将 value + unit 转换为实际 Token 数
 * @param {number} value - 数值
 * @param {string} unit - K/M/B
 * @returns {number}
 */
function toTokenCount(value, unit) {
  switch (unit) {
    case 'K': return value * 1000;
    case 'M': return value * 1000000;
    case 'B': return value * 1000000000;
    default: return value * 1000000;
  }
}

/**
 * 用量目标管理 Hook
 *
 * 初始化时从 electron-store 异步读取已保存的目标，
 * 保存/清除操作同步更新 React state 并异步写入 electron-store。
 *
 * @returns {object}
 */
export default function useUsageGoal() {
  // 目标原始值（用户输入的数字 + 单位）
  const [goal, setGoal] = useState(null);

  // "暂不设定"是否已点击
  const [dismissed, setDismissed] = useState(false);

  // 是否已完成初始化读取
  const [ready, setReady] = useState(false);

  // 启动时从 electron-store 异步读取
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [savedGoal, savedDismissed] = await Promise.all([
          window.electronAPI.getStore(STORE_KEY),
          window.electronAPI.getStore(DISMISSED_STORE_KEY),
        ]);
        if (cancelled) return;
        if (savedGoal && typeof savedGoal.value === 'number' && savedGoal.value > 0) {
          setGoal(savedGoal);
        }
        if (savedDismissed === true) {
          setDismissed(true);
        }
      } catch {
        // 读取失败静默处理，走空态引导即可
      }
      if (!cancelled) setReady(true);
    })();
    return () => { cancelled = true; };
  }, []);

  // 是否已设定目标
  const hasGoal = goal !== null;

  // 每日目标（Token 数）
  const dailyTarget = useMemo(() => {
    if (!goal) return 0;
    return toTokenCount(goal.value, goal.unit);
  }, [goal]);

  // 周目标 = 日 × 7
  const weeklyTarget = dailyTarget * 7;

  // 月目标 = 日 × 30
  const monthlyTarget = dailyTarget * 30;

  /**
   * 保存目标
   * @param {number} value - 数值
   * @param {string} unit - 单位 K/M/B
   */
  const saveGoal = useCallback((value, unit) => {
    const newGoal = { value, unit };
    setGoal(newGoal);
    setDismissed(false);
    // 异步写入 electron-store，不阻塞 UI
    window.electronAPI.setStore(STORE_KEY, newGoal);
    window.electronAPI.deleteStore(DISMISSED_STORE_KEY);
  }, []);

  /**
   * 暂不设定
   */
  const dismissGoal = useCallback(() => {
    setDismissed(true);
    window.electronAPI.setStore(DISMISSED_STORE_KEY, true);
  }, []);

  return {
    // 目标状态
    hasGoal,
    dismissed,
    goal,
    dailyTarget,
    weeklyTarget,
    monthlyTarget,
    ready,

    // 操作
    saveGoal,
    dismissGoal,
  };
}
