/**
 * 对话文件按行读取工具
 *
 * 负责：
 * - 读文件头部若干字节并切成完整的行（带每行起始字节偏移）
 * - 从文件尾部（或指定偏移处）倒着按块读，逐行回调，读够就停
 * - 从头到尾顺着读，逐行回调（搜索用）
 * - 统计实际读取的字节数，供测试确认大文件没有整份读
 *
 * 按字节而不是按字符切行：换行符 0x0A 在 UTF-8 里不会出现在多字节字符中间，切出来的每行都是完整的。
 *
 * @module electron/services/sessionFileReader
 */

const fsp = require('fs/promises')

const NEWLINE = 0x0a
const DEFAULT_CHUNK = 64 * 1024

const stats = { bytesRead: 0 }

/** 清零读取统计（测试用） */
function resetReaderStats() {
  stats.bytesRead = 0
}

/**
 * 读取统计
 * @returns {{bytesRead: number}}
 */
function getReaderStats() {
  return { bytesRead: stats.bytesRead }
}

/**
 * 读文件头部，返回其中完整的行
 * @param {string} filePath - 文件路径
 * @param {number} maxBytes - 最多读多少字节
 * @returns {Promise<Array<{offset: number, text: string}>>} 行（最后一行若被截断则丢弃，读到文件尾时保留）
 */
async function readHeadLines(filePath, maxBytes) {
  const fh = await fsp.open(filePath, 'r')
  try {
    const { size } = await fh.stat()
    const len = Math.min(size, maxBytes)
    const buf = Buffer.alloc(len)
    const { bytesRead } = await fh.read(buf, 0, len, 0)
    stats.bytesRead += bytesRead
    const lines = []
    let start = 0
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === NEWLINE) {
        if (i > start) lines.push({ offset: start, text: buf.subarray(start, i).toString('utf8') })
        start = i + 1
      }
    }
    // 读到了文件尾：最后一行没有换行也是完整的
    if (bytesRead === size && start < bytesRead) lines.push({ offset: start, text: buf.subarray(start, bytesRead).toString('utf8') })
    return lines
  } finally {
    await fh.close()
  }
}

/**
 * 从 before（默认文件尾）往前倒着读，逐行回调（由后往前）
 * 步骤：每次往前读一块，拼上上一块开头那段不完整的行，从后往前找换行切出完整行；回调返回 false 即停
 * @param {string} filePath - 文件路径
 * @param {{before?: number, maxBytes?: number, chunkSize?: number}} options - before 为行起始偏移；maxBytes 为最多读多少字节
 * @param {(text: string, offset: number) => (boolean|void)} onLine - 行回调，返回 false 停止
 * @returns {Promise<{earliestOffset: number|null, stopped: boolean}>} earliestOffset 为最后一次回调的那行的起始偏移
 */
async function scanBackward(filePath, { before, maxBytes = Infinity, chunkSize = DEFAULT_CHUNK } = {}, onLine) {
  const fh = await fsp.open(filePath, 'r')
  try {
    const { size } = await fh.stat()
    let pos = before == null ? size : Math.min(before, size)
    let budget = maxBytes
    let carry = Buffer.alloc(0)
    let earliestOffset = null

    while (pos > 0 && budget > 0) {
      const len = Math.min(chunkSize, pos, budget)
      pos -= len
      const buf = Buffer.alloc(len)
      await fh.read(buf, 0, len, pos)
      stats.bytesRead += len
      budget -= len
      const data = carry.length ? Buffer.concat([buf, carry]) : buf
      let lineEnd = data.length
      // 用原生 lastIndexOf 找换行：大文件上比逐字节循环快一个数量级
      for (let i = data.lastIndexOf(NEWLINE, lineEnd - 1); i >= 0; i = lineEnd > 0 ? data.lastIndexOf(NEWLINE, lineEnd - 1) : -1) {
        const lineStart = i + 1
        if (lineEnd > lineStart) {
          earliestOffset = pos + lineStart
          if (onLine(data.subarray(lineStart, lineEnd).toString('utf8'), pos + lineStart) === false) {
            return { earliestOffset, stopped: true }
          }
        }
        lineEnd = i
        if (lineEnd === 0) break
      }
      carry = data.subarray(0, lineEnd)
    }
    // 读到了文件开头：剩下的就是第一行
    if (pos === 0 && carry.length) {
      earliestOffset = 0
      if (onLine(carry.toString('utf8'), 0) === false) return { earliestOffset, stopped: true }
    }
    return { earliestOffset, stopped: false }
  } finally {
    await fh.close()
  }
}

/**
 * 从头到尾顺着读，逐行回调（由前往后）
 * @param {string} filePath - 文件路径
 * @param {(text: string, offset: number) => (boolean|void)} onLine - 行回调，返回 false 停止
 * @param {{chunkSize?: number}} [options]
 * @returns {Promise<void>}
 */
async function scanForward(filePath, onLine, { chunkSize = DEFAULT_CHUNK } = {}) {
  const fh = await fsp.open(filePath, 'r')
  try {
    let pos = 0
    let carry = Buffer.alloc(0)
    let carryOffset = 0
    for (;;) {
      const buf = Buffer.alloc(chunkSize)
      const { bytesRead } = await fh.read(buf, 0, chunkSize, pos)
      if (bytesRead === 0) break
      stats.bytesRead += bytesRead
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead)
      const base = carry.length ? carryOffset : pos
      pos += bytesRead
      let start = 0
      for (let i = data.indexOf(NEWLINE, start); i >= 0; i = data.indexOf(NEWLINE, start)) {
        if (i > start && onLine(data.subarray(start, i).toString('utf8'), base + start) === false) return
        start = i + 1
      }
      carry = data.subarray(start)
      carryOffset = base + start
    }
    if (carry.length) onLine(carry.toString('utf8'), carryOffset)
  } finally {
    await fh.close()
  }
}

module.exports = { readHeadLines, scanBackward, scanForward, resetReaderStats, getReaderStats }
