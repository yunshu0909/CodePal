/* @vitest-environment node */
/**
 * DSH zstd 多帧容器测试（TC-13 / AC-13）
 *
 * 为什么需要这个模块：
 * DSH 的会话日志是**多帧拼接**的 zstd 容器（为支持追加写）。Node 没有可用的多帧 API：
 * - zlib.zstdDecompressSync(buf) 只解第一帧并静默截断
 * - zlib.createZstdDecompress() 流式读取在第二个帧处直接报错 Unknown frame descriptor
 * 因此必须自行走查帧边界，再逐帧解压。
 *
 * 本测试用**构造的多帧容器**做 fixture（把若干段独立压缩后首尾相接），
 * 不读取真实 ~/.dsh，保证脱网可运行。
 *
 * @module tests/dshZstdFrames
 */

import { describe, it, expect } from 'vitest'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { decompressFirstFrame, decompressZstdFrames, iterateZstdFrames, splitZstdFrames } from '../electron/services/zstdFrames.mjs'

/** 构造一个真多帧 zstd 容器：每段独立压缩后拼接 */
function makeMultiFrame(chunks) {
  return Buffer.concat(chunks.map((text) => zstdCompressSync(Buffer.from(text, 'utf-8'))))
}

const CHUNKS = ['{"seq":1,"payload":"alpha"}\n', '{"seq":2,"payload":"beta"}\n', '{"seq":3,"payload":"gamma"}\n', '{"seq":4,"payload":"delta"}\n', '{"seq":5,"payload":"epsilon"}\n']

describe('TC-13 zstd 多帧解压', () => {
  it('把多帧容器完整解压，结果等于各帧原始内容拼接', () => {
    const multi = makeMultiFrame(CHUNKS)
    const result = decompressZstdFrames(multi)

    expect(result.frames).toBe(CHUNKS.length)
    expect(result.buffer.toString('utf-8')).toBe(CHUNKS.join(''))
    expect(result.tornBytes).toBe(0)
  })

  it('明确优于"只解首帧"的错误做法（回归护栏）', () => {
    const multi = makeMultiFrame(CHUNKS)
    const firstFrameOnly = zstdDecompressSync(multi)

    // 原生 API 只给出第一帧，这是本模块存在的理由
    expect(firstFrameOnly.toString('utf-8')).toBe(CHUNKS[0])
    // 本模块必须给出全部内容，且严格长于首帧
    const result = decompressZstdFrames(multi)
    expect(result.buffer.length).toBeGreaterThan(firstFrameOnly.length)
    expect(result.buffer.equals(firstFrameOnly)).toBe(false)
  })

  it('splitZstdFrames 切出的帧数与帧区间自洽', () => {
    const multi = makeMultiFrame(CHUNKS)
    const { frames, tailOffset, torn } = splitZstdFrames(multi)

    expect(frames).toHaveLength(CHUNKS.length)
    expect(frames[0].start).toBe(0)
    expect(frames[frames.length - 1].end).toBe(multi.length)
    expect(tailOffset).toBe(multi.length)
    expect(torn).toBe(false)
    // 区间必须首尾相接、不重叠
    for (let i = 1; i < frames.length; i += 1) {
      expect(frames[i].start).toBe(frames[i - 1].end)
    }
  })

  it('追加写造成的末尾残帧被丢弃，且不抛异常', () => {
    const multi = makeMultiFrame(CHUNKS)
    const tornBuffer = Buffer.concat([multi, zstdCompressSync(Buffer.from('{"seq":6,"payload":"zeta"}\n')).subarray(0, 7)])

    const result = decompressZstdFrames(tornBuffer)

    expect(result.tornBytes).toBeGreaterThan(0)
    expect(result.frames).toBe(CHUNKS.length)
    expect(result.buffer.toString('utf-8')).toBe(CHUNKS.join(''))
  })

  it('非 zstd 数据返回空结果而不抛异常', () => {
    const result = decompressZstdFrames(Buffer.from('this is not zstd at all', 'utf-8'))

    expect(result.frames).toBe(0)
    expect(result.buffer).toHaveLength(0)
    expect(result.tornBytes).toBeGreaterThan(0)
  })

  it('空输入返回空结果', () => {
    const result = decompressZstdFrames(Buffer.alloc(0))

    expect(result.frames).toBe(0)
    expect(result.buffer).toHaveLength(0)
    expect(result.tornBytes).toBe(0)
  })

  it('iterateZstdFrames 逐帧产出，拼接结果与一次性解压一致', () => {
    // 扫描主路径依赖逐帧消费把峰值内存压到单帧级别；
    // 这里钉住"逐帧产出 == 一次性解压"，防止将来退回整文件解压。
    const multi = makeMultiFrame(CHUNKS)

    const perFrame = Array.from(iterateZstdFrames(multi), (frame) => frame.toString('utf-8'))

    expect(perFrame).toEqual(CHUNKS)
    expect(perFrame.join('')).toBe(decompressZstdFrames(multi).buffer.toString('utf-8'))
  })

  it('iterateZstdFrames 遇到末尾残帧时保留此前完整帧', () => {
    const multi = makeMultiFrame(CHUNKS)
    const tornBuffer = Buffer.concat([multi, zstdCompressSync(Buffer.from('{"seq":6}\n')).subarray(0, 5)])

    expect(Array.from(iterateZstdFrames(tornBuffer), (frame) => frame.toString('utf-8'))).toEqual(CHUNKS)
  })

  it('decompressFirstFrame 只给首帧（探测起点用，不解压全文）', () => {
    const multi = makeMultiFrame(CHUNKS)

    expect(decompressFirstFrame(multi).toString('utf-8')).toBe(CHUNKS[0])
  })
})
