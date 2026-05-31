/**
 * API Key 输入字段
 *
 * 负责：
 * - 已配置时只读展示「已配置 + 掩码」，点「修改」才进入编辑态
 * - 未配置时直接展示输入框，引导填入
 * - 编辑 / 保存 / 取消；真实 Key 永不回显（掩码为假值）
 *
 * 空值由后端解释为「保留旧值」，因此保存按钮要求非空，留空请用「取消」。
 *
 * @module components/ApiKeyField
 */

import { useState } from 'react'
import Button from '../Button/Button'
import './ApiKeyField.css'

/**
 * API Key 字段
 * @param {Object} props
 * @param {string} props.label - 字段标签
 * @param {boolean} props.configured - 后端是否已存在该 Key
 * @param {boolean} [props.saving] - 是否正在保存该 Key
 * @param {(value: string) => Promise<boolean>} props.onSave - 保存回调，返回 false 表示失败（停留编辑态）
 * @returns {JSX.Element}
 */
export default function ApiKeyField({ label, configured, saving = false, onSave }) {
  // 是否处于输入态；未配置时强制为输入态
  const [editing, setEditing] = useState(false)
  // 输入框当前值（明文仅存在于本地输入态，不回传展示）
  const [value, setValue] = useState('')

  const isInput = editing || !configured

  /**
   * 提交新 Key，成功后清空输入并退回展示态
   */
  const handleSave = async () => {
    const ok = await onSave(value.trim())
    // 后端返回 false 表示保存失败，保持编辑态让用户重试
    if (ok !== false) {
      setValue('')
      setEditing(false)
    }
  }

  /**
   * 放弃本次编辑，退回展示态
   */
  const handleCancel = () => {
    setValue('')
    setEditing(false)
  }

  return (
    <div className={`api-key ${isInput ? 'api-key--editing' : ''}`}>
      <div className="api-key-info">
        <span className="api-key-label">{label}</span>
        {isInput ? (
          <input
            className="api-key-input"
            type="password"
            value={value}
            placeholder={configured ? '粘贴新 Key，留空请取消' : '粘贴 Key'}
            autoFocus={editing}
            disabled={saving}
            onChange={(event) => setValue(event.target.value)}
          />
        ) : (
          <span className="api-key-status">
            <span className="api-key-dot" />
            <span>已配置</span>
            <span className="api-key-mask">sk-••••••••</span>
          </span>
        )}
      </div>

      {isInput ? (
        <div className="api-key-actions">
          {configured && (
            <Button variant="ghost" size="sm" onClick={handleCancel} disabled={saving}>
              取消
            </Button>
          )}
          <Button
            variant="primary"
            size="sm"
            onClick={handleSave}
            loading={saving}
            disabled={!value.trim()}
          >
            保存
          </Button>
        </div>
      ) : (
        <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
          修改
        </Button>
      )}
    </div>
  )
}
