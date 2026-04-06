/**
 * Session 浏览服务
 *
 * 负责：
 * - 扫描 ~/.claude/projects/ 下的项目目录
 * - 列出每个项目的 session JSONL 文件
 * - 解析 JSONL 文件为可读的对话消息列表
 *
 * @module electron/services/sessionBrowserService
 */

const fs = require('fs/promises')
const path = require('path')
const os = require('os')
const readline = require('readline')
const { createReadStream } = require('fs')

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects')

/**
 * 从编码后的项目目录名中提取可读的项目名
 * Claude Code 编码规则：路径 / 替换为 -
 * 取最后一段作为项目名（对绝大多数项目正确）
 * @param {string} encoded - 编码后的目录名
 * @returns {string} 项目名
 */
function decodeProjectName(encoded) {
  const parts = encoded.replace(/^-/, '').split('-')
  return parts[parts.length - 1] || encoded
}

/**
 * 获取所有项目列表
 * @returns {Promise<Array<{id: string, name: string, fullPath: string, sessionCount: number}>>}
 */
async function listProjects() {
  try {
    const entries = await fs.readdir(CLAUDE_PROJECTS_DIR, { withFileTypes: true })
    const projects = []

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('.')) continue

      try {
        const projectDir = path.join(CLAUDE_PROJECTS_DIR, entry.name)
        const files = await fs.readdir(projectDir)
        const jsonlFiles = files.filter(f => f.endsWith('.jsonl'))
        const name = decodeProjectName(entry.name)

        projects.push({
          id: entry.name,
          name,
          sessionCount: jsonlFiles.length,
        })
      } catch {
        // 单个目录读取失败不影响其他项目
      }
    }

    // 按项目名排序
    projects.sort((a, b) => a.name.localeCompare(b.name))
    return projects
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

/**
 * 判断文本内容是否为系统注入的标签消息（非用户真正输入）
 * Claude Code 在某些场景（如 /resume、本地命令）下会注入系统标签作为 user 消息
 * @param {string} text - 消息文本
 * @returns {boolean}
 */
function isSystemTagMessage(text) {
  if (!text) return true
  const trimmed = text.trimStart()
  // Claude Code 注入的各类系统标签
  if (trimmed.startsWith('<local-command-')) return true
  if (trimmed.startsWith('<command-name>')) return true
  if (trimmed.startsWith('<command-message>')) return true
  if (trimmed.startsWith('<command-args>')) return true
  // Skill 加载时注入的提示
  if (trimmed.startsWith('Base directory for this skill:')) return true
  return false
}

/**
 * 获取指定项目下的 session 列表
 * 跳过系统标签消息，找真正的用户首条输入作为摘要
 * @param {string} projectId - 编码后的项目目录名
 * @returns {Promise<Array<{id: string, filename: string, firstPrompt: string, timestamp: string, lineCount: number}>>}
 */
async function listSessions(projectId) {
  const projectDir = path.join(CLAUDE_PROJECTS_DIR, projectId)

  try {
    const files = await fs.readdir(projectDir)
    const jsonlFiles = files.filter(f => f.endsWith('.jsonl'))
    const sessions = []

    for (const filename of jsonlFiles) {
      const filePath = path.join(projectDir, filename)
      const stat = await fs.stat(filePath)
      const sessionId = filename.replace('.jsonl', '')

      let firstPrompt = ''
      let timestamp = ''
      let lineCount = 0

      const fileStream = createReadStream(filePath, { encoding: 'utf-8' })
      const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity })

      try {
        for await (const line of rl) {
          lineCount++
          if (line.trim()) {
            try {
              const obj = JSON.parse(line)
              // timestamp 独立捕获，不受 firstPrompt 门控
              if (!timestamp && obj.timestamp) {
                timestamp = obj.timestamp
              }
              if (!firstPrompt && obj.type === 'user' && obj.message?.content) {
                const content = typeof obj.message.content === 'string'
                  ? obj.message.content
                  : Array.isArray(obj.message.content)
                    ? obj.message.content
                        .filter(c => c.type === 'text')
                        .map(c => c.text)
                        .join(' ')
                    : ''
                // 跳过系统注入的标签消息，继续找真正的用户输入
                if (isSystemTagMessage(content)) continue
                firstPrompt = content.slice(0, 100).replace(/\n/g, ' ')
              }
            } catch {
              // 忽略 JSON 解析错误
            }
          }
        }
      } catch {
        // 文件读取异常，跳过
      } finally {
        fileStream.destroy()
      }

      sessions.push({
        id: sessionId,
        filename,
        firstPrompt: firstPrompt || '(无消息)',
        timestamp: timestamp || stat.mtime.toISOString(),
        modifiedAt: stat.mtime.toISOString(),
        lineCount,
      })
    }

    // 按修改时间倒序（最新在前）
    sessions.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt))
    return sessions
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

/**
 * 读取并解析 session 对话内容
 * 只提取 user 和 assistant 类型的消息
 * @param {string} projectId - 项目目录名
 * @param {string} sessionId - session UUID
 * @returns {Promise<Array<{type: string, content: string, timestamp: string, model?: string}>>}
 */
async function readSession(projectId, sessionId) {
  const filePath = path.join(CLAUDE_PROJECTS_DIR, projectId, `${sessionId}.jsonl`)
  const messages = []

  const fileStream = createReadStream(filePath, { encoding: 'utf-8' })
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity })

  try {
    for await (const line of rl) {
      if (!line.trim()) continue
      try {
        const obj = JSON.parse(line)

        if (obj.type === 'user') {
          const content = typeof obj.message?.content === 'string'
            ? obj.message.content
            : Array.isArray(obj.message?.content)
              ? obj.message.content
                  .filter(c => c.type === 'text')
                  .map(c => c.text)
                  .join('\n')
              : ''
          if (content) {
            messages.push({
              type: 'user',
              content,
              timestamp: obj.timestamp || '',
            })
          }
        } else if (obj.type === 'assistant') {
          const contentItems = obj.message?.content || []
          const textParts = Array.isArray(contentItems)
            ? contentItems
                .filter(c => c.type === 'text')
                .map(c => c.text)
            : []
          const toolUses = Array.isArray(contentItems)
            ? contentItems.filter(c => c.type === 'tool_use')
            : []

          if (textParts.length > 0 || toolUses.length > 0) {
            messages.push({
              type: 'assistant',
              content: textParts.join('\n'),
              timestamp: obj.timestamp || '',
              model: obj.message?.model || '',
              toolUseCount: toolUses.length,
            })
          }
        }
      } catch {
        // 忽略无法解析的行
      }
    }
  } finally {
    fileStream.destroy()
  }

  return messages
}

/**
 * 全文搜索所有项目的 session 对话内容
 * 策略：逐行读取，先用 string.includes 粗筛（跳过 base64），命中再 JSON.parse 提取片段
 * @param {string} keyword - 搜索关键词
 * @param {number} [maxResults=50] - 最大返回结果数
 * @returns {Promise<Array<{projectId: string, projectName: string, sessionId: string, snippet: string, timestamp: string, role: string}>>}
 */
async function searchSessions(keyword, maxResults = 50) {
  if (!keyword || keyword.trim().length === 0) return []

  const lowerKeyword = keyword.toLowerCase()
  const results = []

  let projectEntries
  try {
    projectEntries = await fs.readdir(CLAUDE_PROJECTS_DIR, { withFileTypes: true })
  } catch {
    return []
  }

  for (const entry of projectEntries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    if (results.length >= maxResults) break

    const projectDir = path.join(CLAUDE_PROJECTS_DIR, entry.name)
    const projectName = decodeProjectName(entry.name)

    let files
    try {
      files = await fs.readdir(projectDir)
    } catch {
      continue
    }

    const jsonlFiles = files.filter(f => f.endsWith('.jsonl'))

    for (const filename of jsonlFiles) {
      if (results.length >= maxResults) break

      const filePath = path.join(projectDir, filename)
      const sessionId = filename.replace('.jsonl', '')
      // 每个 session 只取首条命中，避免结果爆炸
      let found = false

      const fileStream = createReadStream(filePath, { encoding: 'utf-8' })
      const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity })

      try {
        for await (const line of rl) {
          if (found) break
          // 粗筛：整行文本是否包含关键词（大小写不敏感）
          if (!line.toLowerCase().includes(lowerKeyword)) continue
          // 跳过 base64 数据行（含图片等大块编码数据）
          if (line.includes('"media_type"') && line.includes('"data"')) continue

          try {
            const obj = JSON.parse(line)
            if (obj.type !== 'user' && obj.type !== 'assistant') continue

            const contentItems = obj.message?.content
            const textContent = typeof contentItems === 'string'
              ? contentItems
              : Array.isArray(contentItems)
                ? contentItems.filter(c => c.type === 'text').map(c => c.text).join(' ')
                : ''

            if (!textContent.toLowerCase().includes(lowerKeyword)) continue

            // 提取关键词周围的片段（前后各 40 字符）
            const idx = textContent.toLowerCase().indexOf(lowerKeyword)
            const start = Math.max(0, idx - 40)
            const end = Math.min(textContent.length, idx + keyword.length + 40)
            const snippet = (start > 0 ? '...' : '') +
              textContent.slice(start, end).replace(/\n/g, ' ') +
              (end < textContent.length ? '...' : '')

            results.push({
              projectId: entry.name,
              projectName,
              sessionId,
              snippet,
              timestamp: obj.timestamp || '',
              role: obj.type,
            })
            found = true
          } catch {
            // JSON 解析失败，跳过
          }
        }
      } catch {
        // 文件读取异常，跳过
      } finally {
        fileStream.destroy()
      }
    }
  }

  return results
}

module.exports = { listProjects, listSessions, readSession, searchSessions }
