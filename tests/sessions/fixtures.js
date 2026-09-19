/**
 * 对话回顾测试用的构造数据
 *
 * 负责：
 * - 在系统临时目录里生成 Claude Code 风格的 projects/<项目>/<sessionId>.jsonl
 * - 提供各类行的构造函数（提问、回答、工具调用、标题、最后一句提问、压缩、系统消息）
 * - 不读、不写真实的 ~/.claude
 *
 * @module tests/sessions/fixtures
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let seq = 0
const ts = () => new Date(Date.UTC(2026, 8, 19, 6, 0, seq++)).toISOString()

/** 构造行：每个函数返回一个 JSON 对象，写文件时一行一个 */
export const L = {
  mode: () => ({ type: 'mode', mode: 'default' }),
  user: (text, extra = {}) => ({ type: 'user', timestamp: ts(), message: { role: 'user', content: text }, ...extra }),
  userBlocks: (blocks, extra = {}) => ({ type: 'user', timestamp: ts(), message: { role: 'user', content: blocks }, ...extra }),
  toolResult: () => ({ type: 'user', timestamp: ts(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }),
  answer: (text, tools = []) => ({
    type: 'assistant',
    timestamp: ts(),
    message: {
      role: 'assistant',
      content: [
        ...(text ? [{ type: 'text', text }] : []),
        ...tools.map(([name, input], i) => ({ type: 'tool_use', id: `tu${i}`, name, input })),
      ],
    },
  }),
  aiTitle: (aiTitle) => ({ type: 'ai-title', aiTitle }),
  lastPrompt: (lastPrompt) => ({ type: 'last-prompt', lastPrompt }),
  compact: () => ({ type: 'user', timestamp: ts(), isCompactSummary: true, message: { role: 'user', content: 'This session is being continued from a previous conversation...' } }),
  meta: (text) => ({ type: 'user', timestamp: ts(), isMeta: true, message: { role: 'user', content: text } }),
  system: () => ({ type: 'system', subtype: 'info', content: 'x' }),
}

/** 会话头：cwd / gitBranch / entrypoint 附在第一条 user 行上（与真实文件一致：每行都带） */
export function stamp(lines, { cwd, branch = 'main', entrypoint = 'cli' } = {}) {
  return lines.map((line) => (line.type === 'user' || line.type === 'assistant'
    ? { ...line, cwd, gitBranch: branch, ...(entrypoint ? { entrypoint } : {}) }
    : line))
}

/**
 * 建一个临时 projects 目录
 * @returns {{ dir: string, write: Function, cleanup: Function }}
 */
export function makeProjectsDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codepal-sessions-'))
  return {
    dir,
    /**
     * 写一个对话文件
     * @param {string} projectId - 编码后的项目目录名
     * @param {string} sessionId - 对话 id
     * @param {Array<object|string>} lines - 行（对象会 JSON 化；字符串原样写，用来造坏行或填充）
     * @param {Date} [mtime] - 文件修改时间
     * @returns {string} 文件路径
     */
    write(projectId, sessionId, lines, mtime) {
      const pdir = path.join(dir, projectId)
      fs.mkdirSync(pdir, { recursive: true })
      const file = path.join(pdir, `${sessionId}.jsonl`)
      fs.writeFileSync(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n')
      if (mtime) fs.utimesSync(file, mtime, mtime)
      return file
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** 大段填充行：一行约 size 字节的 progress 行，用来把文件撑大 */
export function filler(size) {
  return JSON.stringify({ type: 'progress', data: 'x'.repeat(size) })
}
