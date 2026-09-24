/**
 * ESLint 配置（B2-8）
 *
 * 只开能抓真 bug 的规则（未定义变量、不可达代码、重复键、Hooks 调用规则等），不管代码风格：
 * 风格交给各文件现有写法，避免一次性全仓重排淹没 git blame。
 *
 * @module eslint.config
 */

import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import react from 'eslint-plugin-react'

export default [
  { linterOptions: { reportUnusedDisableDirectives: 'off' } },
  { ignores: ['dist/**', 'release/**', 'node_modules/**', 'coverage/**', 'tests/report/**', '_disabled/**', 'templates/**', 'references/**'] },
  {
    files: ['**/*.{js,jsx,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: { 'react-hooks': reactHooks, react },
    settings: { react: { version: '19' } },
    rules: {
      ...js.configs.recommended.rules,
      'react-hooks/rules-of-hooks': 'error',
      // 核心 no-undef 不看 JSX 标签名，未定义组件要靠这条
      'react/jsx-no-undef': 'error',
      // 以下不影响运行正确性，先不拦
      'no-unused-vars': 'off',
      'no-empty': 'off',
      'no-useless-escape': 'off',
    },
  },
  {
    files: ['electron/**/*.js', 'scripts/**/*.js', '**/*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
  },
  {
    files: ['tests/**/*.{js,jsx}'],
    languageOptions: { globals: { ...globals.vitest } },
    // 测试里会用正则匹配终端颜色码
    rules: { 'no-control-regex': 'off' },
  },
]
