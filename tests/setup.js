/**
 * Vitest 测试环境初始化
 *
 * 负责：
 * - 注册 Testing Library DOM 断言
 * - 为缺失 localStorage 方法的环境补齐内存实现
 * - 为根目录 tests 提供统一 setup 入口
 * - 每个用例后清掉全局 Toast
 *
 * @module tests/setup
 */

import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { resetToastForTests } from '../src/components/Toast'

// Toast 宿主挂在 body 下、跨用例常驻：每个用例后清掉，避免上一条提示留到下一个用例
afterEach(() => resetToastForTests())

/**
 * 创建内存版 Storage 实现
 * @returns {Storage}
 */
function createMemoryStorage() {
  const store = new Map()

  return {
    get length() {
      return store.size
    },
    clear() {
      store.clear()
    },
    getItem(key) {
      return store.has(key) ? store.get(key) : null
    },
    key(index) {
      return Array.from(store.keys())[index] || null
    },
    removeItem(key) {
      store.delete(key)
    },
    setItem(key, value) {
      store.set(String(key), String(value))
    }
  }
}

if (
  typeof window !== 'undefined'
  && (
    !window.localStorage
    || typeof window.localStorage.getItem !== 'function'
    || typeof window.localStorage.clear !== 'function'
  )
) {
  Object.defineProperty(window, 'localStorage', {
    value: createMemoryStorage(),
    configurable: true
  })
}
