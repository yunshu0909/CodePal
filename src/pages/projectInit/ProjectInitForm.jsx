/**
 * 新建项目 · 表单型卡
 *
 * 负责：项目名称、放在哪 + 浏览、代码文件夹、Git 分段四行；出错的那一行说明位换红字、输入框红边。
 * 在输入框里按 Enter 等于点「创建项目」（能点时，由 onSubmit 决定）。
 *
 * @module pages/projectInit/ProjectInitForm
 */

import Button from '../../components/Button/Button'
import SegmentedControl from '../../components/SegmentedControl/SegmentedControl'
import { GIT_DESCRIPTIONS, GIT_OPTIONS, NO_GIT_DESCRIPTION } from './projectInitConstants'

/**
 * 一行表单：左边名称 + 说明（出错换红字），右边控件
 * @param {{label: string, hint?: string, error?: string, warn?: string, children: React.ReactNode}} props
 */
function FormRow({ label, hint, error, warn, children }) {
  const ds = error || warn || hint
  const cls = error ? 'ds bad' : warn ? 'ds warn' : 'ds'
  return (
    <div className="np-row">
      <div className="lf">
        <div className="lb">{label}</div>
        {ds ? <div className={cls}>{ds}</div> : null}
      </div>
      <div className="pi-ctl">{children}</div>
    </div>
  )
}

/**
 * 文字输入框（np-in 文本变体），出错时 aria-invalid 触发红边
 */
function TextInput({ value, onChange, placeholder, invalid, disabled, onEnter, testId }) {
  return (
    <div className="np-in np-in--text">
      <input
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={invalid ? 'true' : undefined}
        data-testid={testId}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter') onEnter?.() }}
      />
    </div>
  )
}

/**
 * @param {Object} props - useProjectInit 返回的状态与动作
 */
export default function ProjectInitForm({ values, fieldErrors, gitAvailable, creating, setProjectName, setTargetPath, setCodeDirName, setGitMode, browse, create }) {
  return (
    <div className="np-card np-card--form pi-form">
      <FormRow label="项目名称" hint="外层文件夹的名字" error={fieldErrors.projectName}>
        <TextInput value={values.projectName} onChange={setProjectName} placeholder="必填，例如 my-app"
          invalid={Boolean(fieldErrors.projectName)} disabled={creating} onEnter={create} testId="pi-name" />
      </FormRow>
      <FormRow label="放在哪" error={fieldErrors.targetPath}>
        <TextInput value={values.targetPath} onChange={setTargetPath}
          invalid={Boolean(fieldErrors.targetPath)} disabled={creating} onEnter={create} testId="pi-path" />
        <Button size="sm" className="np-btn" onClick={browse} disabled={creating}>浏览</Button>
      </FormRow>
      <FormRow label="代码文件夹" hint="里层代码仓的名字，默认 code" error={fieldErrors.codeDirName}>
        <TextInput value={values.codeDirName} onChange={setCodeDirName}
          invalid={Boolean(fieldErrors.codeDirName)} disabled={creating} onEnter={create} testId="pi-code" />
      </FormRow>
      <FormRow label="Git" hint={gitAvailable ? GIT_DESCRIPTIONS[values.gitMode] : undefined} warn={gitAvailable ? undefined : NO_GIT_DESCRIPTION}>
        <SegmentedControl options={GIT_OPTIONS} value={values.gitMode} onChange={setGitMode}
          ariaLabel="Git" disabled={creating || !gitAvailable} />
      </FormRow>
    </div>
  )
}
