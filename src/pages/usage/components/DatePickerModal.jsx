/**
 * 自定义日期选择下拉组件
 *
 * 负责：
 * - 日期范围输入（开始/结束）
 * - 输入校验与错误提示
 * - 确认/取消操作
 *
 * @module pages/usage/components/DatePickerModal
 */

/**
 * 日期选择下拉面板
 * @param {Object} props
 * @param {{startDate: string, endDate: string}} props.dateRange - 当前日期范围
 * @param {(range: {startDate: string, endDate: string}) => void} props.onDateRangeChange - 日期变更回调
 * @param {string|null} props.error - 校验错误信息
 * @param {(error: string|null) => void} props.onErrorChange - 错误状态变更回调
 * @param {string} props.maxDate - 可选最大日期
 * @param {{left: number, top: number}} props.position - 下拉面板位置
 * @param {() => void} props.onConfirm - 确认回调
 * @param {() => void} props.onCancel - 取消回调
 * @returns {JSX.Element}
 */
export default function DatePickerModal({
  dateRange,
  onDateRangeChange,
  error,
  onErrorChange,
  maxDate,
  position,
  onConfirm,
  onCancel,
}) {
  return (
    <div
      className="date-picker-dropdown"
      style={{ left: `${position.left}px`, top: `${position.top}px` }}
    >
      {/* 日期输入区域：左右两个输入框 + 中间分隔符 */}
      <div className="date-inputs">
        <div className="date-input-wrapper">
          <div className="date-input-label">开始日期</div>
          <input
            type="date"
            className="date-input"
            value={dateRange.startDate}
            max={maxDate}
            onChange={(e) => {
              onDateRangeChange({
                ...dateRange,
                startDate: e.target.value
              });
              // 用户修改时清除错误提示
              if (error) onErrorChange(null);
            }}
          />
        </div>
        <div className="date-separator">~</div>
        <div className="date-input-wrapper">
          <div className="date-input-label">结束日期</div>
          <input
            type="date"
            className="date-input"
            value={dateRange.endDate}
            max={maxDate}
            onChange={(e) => {
              onDateRangeChange({
                ...dateRange,
                endDate: e.target.value
              });
              // 用户修改时清除错误提示
              if (error) onErrorChange(null);
            }}
          />
        </div>
      </div>
      {/* 错误提示 */}
      {error && (
        <div className="date-picker-error">
          <span>⚠️ {error}</span>
        </div>
      )}
      {/* 操作按钮区 */}
      <div className="date-picker-actions">
        <button className="btn btn--secondary" onClick={onCancel}>
          取消
        </button>
        <button className="btn btn--primary" onClick={onConfirm}>
          确定
        </button>
      </div>
    </div>
  );
}
