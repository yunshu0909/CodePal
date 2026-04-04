/**
 * 用量目标管理 Hook
 *
 * 负责：
 * - 从 localStorage 读写每日 Token 目标
 * - 自动计算周目标（×7）和月目标（×30）
 * - 管理"暂不设定"状态
 *
 * @module pages/usage/useUsageGoal
 */

import { useState, useCallback, useMemo } from 'react';

const STORAGE_KEY = 'codepal_usage_goal';
const DISMISSED_KEY = 'codepal_usage_goal_dismissed';

/**
 * 从 localStorage 读取目标
 * @returns {{value: number, unit: string} | null}
 */
function readGoal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.value === 'number' && parsed.value > 0) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 写入目标到 localStorage
 * @param {number} value - 数值
 * @param {string} unit - 单位 K/M/B
 */
function writeGoal(value, unit) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ value, unit }));
}

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
 * @returns {object}
 */
export default function useUsageGoal() {
  // 目标原始值（用户输入的数字 + 单位）
  const [goal, setGoal] = useState(() => readGoal());

  // "暂不设定"是否已点击
  const [dismissed, setDismissed] = useState(() => {
    return localStorage.getItem(DISMISSED_KEY) === 'true';
  });

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
    writeGoal(value, unit);
    setGoal({ value, unit });
    // 设定目标后取消 dismissed 状态
    setDismissed(false);
    localStorage.removeItem(DISMISSED_KEY);
  }, []);

  /**
   * 暂不设定
   */
  const dismissGoal = useCallback(() => {
    setDismissed(true);
    localStorage.setItem(DISMISSED_KEY, 'true');
  }, []);

  return {
    // 目标状态
    hasGoal,
    dismissed,
    goal,
    dailyTarget,
    weeklyTarget,
    monthlyTarget,

    // 操作
    saveGoal,
    dismissGoal,
  };
}
