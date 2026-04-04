/**
 * 水平柱状图分布组件
 *
 * 负责：
 * - 按模型分布 / 按项目分布的水平柱状图展示
 * - 每行：名称 → 柱状条 → Token 数 → 百分比
 * - 按项目分布：前 4 项单独展示，超出合并为"其他 N 个项目"
 *
 * @module pages/usage/components/DistributionBar
 */

import { formatMetricValue } from '../useUsageData';

/**
 * 单个分布柱状图卡片
 * @param {object} props
 * @param {string} props.title - 卡片标题（如"按模型分布"）
 * @param {Array<{name: string, value: number, color: string}>} props.items - 数据项
 * @param {number} [props.maxItems] - 最多展示条数（超出合并为"其他"），0=不限
 */
export default function DistributionBar({ title, items, maxItems = 0 }) {
  if (!items || items.length === 0) {
    return (
      <div className="dist-card">
        <div className="dist-header">{title}</div>
        <div className="dist-empty">暂无数据</div>
      </div>
    );
  }

  // 按 value 降序排列
  const sorted = [...items].sort((a, b) => b.value - a.value);
  const total = sorted.reduce((sum, item) => sum + item.value, 0);

  // 合并逻辑
  let displayItems = sorted;
  if (maxItems > 0 && sorted.length > maxItems) {
    const visible = sorted.slice(0, maxItems);
    const rest = sorted.slice(maxItems);
    const restValue = rest.reduce((sum, item) => sum + item.value, 0);
    displayItems = [
      ...visible,
      { name: `其他 ${rest.length} 个项目`, value: restValue, color: '#94a3b8' }
    ];
  }

  return (
    <div className="dist-card">
      <div className="dist-header">{title}</div>
      {displayItems.map((item, idx) => {
        const pct = total > 0 ? (item.value / total * 100) : 0;
        const pctRounded = Math.round(pct * 10) / 10;

        return (
          <div className="dist-item" key={item.name || idx}>
            <span className="dist-name" title={item.name}>{item.name}</span>
            <div className="dist-bar-bg">
              <div
                className="dist-bar-fill"
                style={{ width: `${pctRounded}%`, background: item.color }}
              />
            </div>
            <span className="dist-amount">{formatMetricValue(item.value)}</span>
            <span className="dist-pct">{pctRounded}%</span>
          </div>
        );
      })}
    </div>
  );
}
