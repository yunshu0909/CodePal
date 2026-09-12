/**
 * DSH zstd 多帧容器解压
 *
 * 负责：
 * - 走查 zstd 拼接容器的帧边界（DSH 会话日志为支持追加写，逐批各成一帧）
 * - 逐帧解压并拼接为完整内容
 * - 容忍追加写造成的末尾残帧（丢弃残帧，保留此前完整内容）
 *
 * 为什么不能用 Node 原生 API（本机 Electron 40.2.1 / Node 24.11.1 实测）：
 * - `zlib.zstdDecompressSync(buf)` 只解第一帧并静默截断（303,832 字节的日志只得到 216 字节）
 * - `zlib.createZstdDecompress()` 流式读取在第二帧处直接报错 `Unknown frame descriptor`
 * 因此必须自行按帧头与 block 头走查边界。本模块不依赖任何外部二进制。
 *
 * @module electron/services/zstdFrames
 */

import { zstdDecompressSync } from 'node:zlib'

/** zstd 帧魔数（小端） */
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Block_Type：RLE 块的压缩侧只占 1 字节 */
const BLOCK_TYPE_RLE = 1

/**
 * 从 offset 起走查一个完整 zstd 帧，返回该帧结束偏移
 *
 * 帧结构：magic(4) → Frame_Header_Descriptor(1) → [Window_Descriptor] →
 * [Dictionary_ID] → [Frame_Content_Size] → blocks… → [checksum(4)]
 * 每个 block 的 3 字节头里，`Block_Size` 即该块在压缩流中的字节数（RLE 除外），
 * 因此可以逐块跳过，无需解码。
 *
 * @param {Buffer} buffer - 完整字节缓冲
 * @param {number} offset - 帧起始偏移
 * @returns {number} 帧结束偏移（不含）；无法在不越界的前提下走完时返回 -1
 */
function findFrameEnd(buffer, offset) {
  if (offset + 4 > buffer.length) return -1
  if (!buffer.subarray(offset, offset + 4).equals(MAGIC)) return -1

  let cursor = offset + 4
  if (cursor >= buffer.length) return -1

  const descriptor = buffer[cursor]
  cursor += 1

  const contentSizeFlag = descriptor >> 6
  const singleSegment = (descriptor >> 5) & 1
  const checksumFlag = (descriptor >> 2) & 1
  const dictionaryFlag = descriptor & 0x03

  // 非单段帧带 Window_Descriptor
  if (!singleSegment) cursor += 1

  // Dictionary_ID 字段长度由标志决定
  if (dictionaryFlag === 1) cursor += 1
  else if (dictionaryFlag === 2) cursor += 2
  else if (dictionaryFlag === 3) cursor += 4

  // Frame_Content_Size 字段长度由标志与单段位共同决定
  const contentSizeBytes = contentSizeFlag === 0
    ? (singleSegment ? 1 : 0)
    : (contentSizeFlag === 1 ? 2 : (contentSizeFlag === 2 ? 4 : 8))
  cursor += contentSizeBytes

  if (cursor > buffer.length) return -1

  for (;;) {
    if (cursor + 3 > buffer.length) return -1

    const header = buffer[cursor] | (buffer[cursor + 1] << 8) | (buffer[cursor + 2] << 16)
    cursor += 3

    const isLastBlock = (header & 1) === 1
    const blockType = (header >> 1) & 0x03
    const blockSize = header >> 3

    cursor += blockType === BLOCK_TYPE_RLE ? 1 : blockSize

    if (isLastBlock) break
    if (cursor > buffer.length) return -1
  }

  if (checksumFlag === 1) cursor += 4

  return cursor > buffer.length ? -1 : cursor
}

/**
 * 走查拼接容器中的所有完整帧
 * @param {Buffer} buffer - 完整字节缓冲
 * @returns {{frames: Array<{start: number, end: number}>, tailOffset: number, torn: boolean}} 帧区间、残帧起始偏移、是否存在残帧
 */
export function splitZstdFrames(buffer) {
  const frames = []

  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { frames, tailOffset: 0, torn: false }
  }

  let offset = 0
  let torn = false

  while (offset < buffer.length) {
    const end = findFrameEnd(buffer, offset)
    if (end <= offset) {
      torn = true
      break
    }
    frames.push({ start: offset, end })
    offset = end
  }

  return { frames, tailOffset: offset, torn }
}

/**
 * 逐帧产出解压结果
 *
 * 内存友好的主入口：一次只解一帧、用完即弃。整份容器一次解开会把几十 MB 会话正文
 * 同时压进内存（实测 76 个日志累计 70 MB），在 Electron 主进程里会触发原生层崩溃。
 *
 * @param {Buffer} buffer - 完整字节缓冲
 * @returns {Generator<Buffer>} 各帧解压内容
 */
export function* iterateZstdFrames(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return

  const { frames } = splitZstdFrames(buffer)

  for (const frame of frames) {
    try {
      yield zstdDecompressSync(buffer.subarray(frame.start, frame.end))
    } catch {
      // 完整帧却解压失败：停止并保留此前已产出的帧
      return
    }
  }
}

/**
 * 只解压第一帧
 *
 * 用于读取会话 header 这类只存在于文件开头的信息（createdAt / cwd），
 * 避免为一个探测动作解压整份会话正文。
 *
 * @param {Buffer} buffer - 完整字节缓冲
 * @returns {Buffer} 第一帧内容；无有效帧时为空缓冲
 */
export function decompressFirstFrame(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return Buffer.alloc(0)

  const { frames } = splitZstdFrames(buffer)
  if (frames.length === 0) return Buffer.alloc(0)

  try {
    return zstdDecompressSync(buffer.subarray(frames[0].start, frames[0].end))
  } catch {
    return Buffer.alloc(0)
  }
}

/**
 * 解压拼接容器为完整字节内容，容忍末尾残帧
 * @param {Buffer} buffer - 完整字节缓冲
 * @returns {{buffer: Buffer, frames: number, tornBytes: number}} 解压结果、成功帧数、残帧字节数
 */
export function decompressZstdFrames(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { buffer: Buffer.alloc(0), frames: 0, tornBytes: 0 }
  }

  const parts = []
  let offset = 0

  while (offset < buffer.length) {
    const end = findFrameEnd(buffer, offset)
    if (end <= offset) break

    let decoded
    try {
      decoded = zstdDecompressSync(buffer.subarray(offset, end))
    } catch {
      // 完整帧却解压失败：按残帧处理，保留此前已成功的部分
      break
    }

    parts.push(decoded)
    offset = end
  }

  return {
    buffer: Buffer.concat(parts),
    frames: parts.length,
    tornBytes: buffer.length - offset,
  }
}
