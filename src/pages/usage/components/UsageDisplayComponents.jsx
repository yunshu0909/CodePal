/**
 * 用量监测展示组件模块
 *
 * 负责：
 * - 渲染模型占比饼图
 * - 渲染模型占比分布图例
 * - 渲染模型用量明细表格
 *
 * @module pages/usage/components/UsageDisplayComponents
 */

import { formatNumber } from '../../../store/usageAggregator';

/**
 * 饼图组件
 * @param {Object} props - 组件属性
 * @param {Array} props.distribution - 分布数据
 * @param {string} props.total - 格式化后的总值
 * @returns {JSX.Element}
 */
export function PieChart({ distribution, total }) {
  const CIRCUMFERENCE = 251.2; // 2 * PI * 40

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
 * @param {Object} props - 组件属性
 * @param {Array} props.distribution - 分布数据
 * @returns {JSX.Element}
 */
export function Legend({ distribution }) {
  if (!distribution || distribution.length === 0) {
    return <div className="legend" />;
  }

  return (
    <div className="legend">
      {distribution.map((item) => (
        <div key={item.key} className="legend-item">
          <div className="legend-dot" style={{ backgroundColor: item.color }} />
          <span>{item.name} {item.displayPercent || `${item.percent}%`}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * 明细表格组件
 * @param {Object} props - 组件属性
 * @param {Array} props.models - 模型数据列表
 * @returns {JSX.Element}
 */
export function DetailTable({ models }) {
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
