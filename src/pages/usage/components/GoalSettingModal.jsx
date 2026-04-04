/**
 * 设定 Token 目标弹窗
 *
 * 负责：
 * - 每日目标输入（数字 + 单位下拉 K/M/B，默认 M）
 * - 实时显示周目标（×7）和月目标（×30）只读
 * - 保存/取消
 *
 * @module pages/usage/components/GoalSettingModal
 */

import { useState, useEffect } from 'react';
import Modal from '../../../components/Modal/Modal';
import Button from '../../../components/Button/Button';
import { formatMetricValue } from '../useUsageData';

/**
 * 将 value + unit 转换为实际 Token 数
 * @param {number} value
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
 * 格式化 Token 数为易读字符串（用于只读展示）
 * @param {number} tokens
 * @returns {string}
 */
function formatTokenDisplay(tokens) {
  if (tokens <= 0) return '—';
  return formatMetricValue(tokens);
}

/**
 * @param {object} props
 * @param {boolean} props.open - 弹窗是否显示
 * @param {() => void} props.onClose - 关闭回调
 * @param {{value: number, unit: string} | null} props.currentGoal - 当前目标（修改时预填）
 * @param {(value: number, unit: string) => void} props.onSave - 保存回调
 */
export default function GoalSettingModal({ open, onClose, currentGoal, onSave }) {
  // 输入值（字符串，支持小数）
  const [inputValue, setInputValue] = useState('');

  // 单位
  const [unit, setUnit] = useState('M');

  // 弹窗打开时初始化
  useEffect(() => {
    if (open) {
      if (currentGoal) {
        setInputValue(String(currentGoal.value));
        setUnit(currentGoal.unit || 'M');
      } else {
        setInputValue('');
        setUnit('M');
      }
    }
  }, [open, currentGoal]);

  // 解析输入值
  const numValue = parseFloat(inputValue);
  const isValid = !isNaN(numValue) && numValue > 0;

  // 计算实际 Token 数
  const dailyTokens = isValid ? toTokenCount(numValue, unit) : 0;
  const weeklyTokens = dailyTokens * 7;
  const monthlyTokens = dailyTokens * 30;

  // 格式化提示文案
  const hintText = isValid
    ? `即每天 ${dailyTokens.toLocaleString()} Token`
    : '';

  /**
   * 限制输入：只允许数字和小数点
   */
  const handleInputChange = (e) => {
    const val = e.target.value;
    // 允许空值、数字、一个小数点
    if (val === '' || /^\d*\.?\d*$/.test(val)) {
      setInputValue(val);
    }
  };

  const handleSave = () => {
    if (!isValid) return;
    onSave(numValue, unit);
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="设定 Token 目标"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={handleSave} disabled={!isValid}>保存</Button>
        </>
      }
    >
      <div className="goal-form">
        <label className="goal-form-label">每日目标</label>
        <div className="goal-input-row">
          <input
            className="goal-input"
            type="text"
            value={inputValue}
            onChange={handleInputChange}
            placeholder="例如 0.5"
            autoFocus
          />
          <select
            className="goal-unit-select"
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
          >
            <option value="K">K</option>
            <option value="M">M</option>
            <option value="B">B</option>
          </select>
        </div>
        {hintText && <div className="goal-hint">{hintText}</div>}

        {/* 周/月目标只读展示 */}
        {isValid && (
          <div className="goal-derived">
            <div className="goal-derived-item">
              <span className="goal-derived-label">每周目标（× 7）</span>
              <span className="goal-derived-val">{formatTokenDisplay(weeklyTokens)}</span>
            </div>
            <div className="goal-derived-item">
              <span className="goal-derived-label">每月目标（× 30）</span>
              <span className="goal-derived-val">{formatTokenDisplay(monthlyTokens)}</span>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
