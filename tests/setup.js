/**
 * Vitest 测试环境初始化
 *
 * 负责：
 * - 注册 Testing Library DOM 断言
 * - 为缺失 localStorage 方法的环境补齐内存实现
 * - 为根目录 tests 提供统一 setup 入口
 *
 * @module tests/setup
 */

import '@testing-library/jest-dom/vitest'

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
