/**
 * V0.4 回归测试初始化
 *
 * 负责：
 * - 启用 React 测试环境的 act 校验
 * - 为裸 localStorage 提供内存 polyfill（App.jsx 初始化即读 localStorage）
 *
 * @module auto-test/v04/setup
 */

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// jsdom 仅把 localStorage 挂在 window 上，而 App.jsx 用裸 localStorage；
// 在 Node 22+ 下裸 localStorage 解析到未启用的原生实现 → undefined，
// 导致渲染 <App/> 时 getInitialActiveModule 读 localStorage 直接抛错。
// 这里补一个内存版 localStorage，保证回归用例能正常挂载组件。
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map()
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
    key: (index) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size
    },
  }
}
