/**
 * 网络诊断前端常量
 * @module pages/network/constants
 */

/** 采样间隔（毫秒） */
export const SAMPLE_INTERVAL_MS = 5000

/** 一轮检测时长（毫秒）：30 分钟 */
export const ROUND_DURATION_MS = 30 * 60 * 1000

/** 时间线最大展示点数 */
export const MAX_TIMELINE_POINTS = 30

/** 连续失败弹 Toast 的阈值 */
export const CONSECUTIVE_FAIL_TOAST_THRESHOLD = 3

/** 时间线点类型 */
export const TIMELINE_TYPE = {
  STABLE: 'stable',
  SWITCH: 'switch',
  FAIL: 'fail',
}

/** IP 监控状态 */
export const IP_STATUS = {
  DETECTING: 'detecting',
  STABLE: 'stable',
  SWITCHED: 'switched',
  FAILED: 'failed',
  OFF: 'off',
}
