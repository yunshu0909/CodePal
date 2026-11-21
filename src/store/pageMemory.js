/**
 * 页面的「上次读到的」（#100）
 *
 * 切走就卸载的页面，在这里记一份上次显示的数据；切回来第一帧先用它，后台照常重读、读到了原地换。
 * - 只在本次运行的内存里，不存盘、不经过主进程；按 window.electronAPI 分开（换一个运行环境就是另一份，不串用）
 * - 只记读到的数据和选中项；「保存中」、开着的弹层、填到一半的这类一次性状态由页面自己不往里放
 *
 * @module store/pageMemory
 */

import { useEffect } from 'react'

let memories = new WeakMap()
const offlineRun = {}

/**
 * 取某一页的那一格；第一次取时是空的（value 为 undefined）
 * @param {string} page - 页名，如 'session-status'
 * @returns {{value: any}} 同一次运行里同一页总是同一个对象
 */
export function pageMemory(page) {
  const run = (typeof window !== 'undefined' && window.electronAPI) || offlineRun
  let pages = memories.get(run)
  if (!pages) {
    pages = new Map()
    memories.set(run, pages)
  }
  if (!pages.has(page)) pages.set(page, { value: undefined })
  return pages.get(page)
}

/**
 * 页面显示的数据一变就记下来；value 为 null / undefined 时不记（还没读到、或读失败清空时不把上次的冲掉）
 * @param {{value: any}} memory - pageMemory() 拿到的那一格
 * @param {any} value - 要记的数据
 */
export function useRemember(memory, value) {
  useEffect(() => {
    if (value !== null && value !== undefined) memory.value = value
  }, [memory, value])
}

/** 清掉所有页的上次结果（测试之间用） */
export function resetPageMemoryForTests() {
  memories = new WeakMap()
}
