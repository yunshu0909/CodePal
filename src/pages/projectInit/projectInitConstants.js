/**
 * 新建项目页面常量
 *
 * 负责：
 * - 表单默认值
 * - Git 三档的名字与说明（说明跟着选中的档换）
 * - 实时校验的防抖时长
 *
 * 会生成什么（目录树）不在这里：由 shared/projectInitManifest.mjs 统一给出。
 *
 * @module pages/projectInit/projectInitConstants
 */

export const DEFAULT_TARGET_PATH = '~/Documents/projects/'

/** 停止输入多久后做一次实时校验 */
export const VALIDATE_DEBOUNCE_MS = 300

export const GIT_OPTIONS = [
  { value: 'dual', label: '双层' },
  { value: 'code', label: '只给代码建仓' },
  { value: 'none', label: '跳过' },
]

export const GIT_DESCRIPTIONS = {
  dual: '外层一个私人仓、代码一个仓，互不包含',
  code: '只有代码文件夹是 Git 仓，外层不建仓',
  none: '先不建仓，以后自己 git init',
}

export const NO_GIT_DESCRIPTION = '本机没装 Git，只能先跳过'
