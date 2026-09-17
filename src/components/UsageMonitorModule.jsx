/**
 * 用量监测模块容器组件
 *
 * 负责：
 * - 作为用量监测功能的入口容器
 * - 渲染用量监测页面
 *
 * @module components/UsageMonitorModule
 */

import UsageMonitorPage from '../pages/UsageMonitorPage';

/**
 * 用量监测模块根组件
 * @returns {JSX.Element}
 */
export default function UsageMonitorModule({isActive = true}) {
  return <UsageMonitorPage isActive={isActive} />;
}
