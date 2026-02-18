/**
 * 路径选择输入组件
 *
 * 负责：
 * - 统一“路径输入 + 浏览按钮”交互
 * - 对外暴露受控输入能力
 *
 * @module components/PathPickerField
 */

import React from 'react'

/**
 * 路径选择输入组件
 * @param {Object} props - 组件属性
 * @param {string} props.label - 字段标签
 * @param {string} props.value - 当前路径值
 * @param {(value: string) => void} props.onChange - 路径输入变更回调
 * @param {() => void} props.onPick - 浏览按钮点击回调
 * @param {boolean} [props.disabled=false] - 是否禁用
 * @param {string} [props.inputTestId] - 路径输入框测试标识
 * @param {string} [props.pickButtonTestId] - 浏览按钮测试标识
 * @returns {JSX.Element}
 */
export default function PathPickerField({
  label,
  value,
  onChange,
  onPick,
  disabled = false,
  inputTestId,
  pickButtonTestId,
}) {
  return (
    <div className="pi-form-group">
      <label className="pi-form-label">{label}</label>
      <div className="pi-input-row">
        <input
          className="pi-input"
          type="text"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          data-testid={inputTestId}
        />
        <button
          type="button"
          className="pi-btn pi-btn-secondary pi-btn-sm"
          onClick={onPick}
          disabled={disabled}
          data-testid={pickButtonTestId}
        >
          浏览
        </button>
      </div>
    </div>
  )
}
