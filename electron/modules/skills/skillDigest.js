/**
 * Skill 目录的逐文件摘要与比较
 *
 * 负责：
 * - 逐个文件算摘要（相对路径 → 内容摘要），子目录里的链接记成链接目标，不跟进
 * - 运行数据不参与比较：缓存（__pycache__、.DS_Store、.pyc）与使用反馈记录（.codepal、evolution、.jsonl）；
 *   只差这些算一样。不参与比较不等于丢弃：备份、撤回照样按完整内容处理（定稿状态清单 A9）
 * - 比较两份：多 / 少 / 改了的文件，SKILL.md 第一、脚本其次、其余按名字（A3）
 * - 正文摘要（不含运行数据）用来判断「内容变没变」；完整摘要（含运行数据）用来核对备份完整
 *
 * @module electron/modules/skills/skillDigest
 */

const fs = require('fs/promises')
const path = require('path')
const crypto = require('crypto')

const RUNTIME_DIRS = new Set(['__pycache__', '.codepal', 'evolution'])
const RUNTIME_FILES = new Set(['.DS_Store'])
const RUNTIME_EXTENSIONS = ['.pyc', '.jsonl']
const SCRIPT_EXTENSIONS = ['.py', '.sh', '.js', '.mjs', '.cjs', '.ts', '.rb']

/**
 * 这个相对路径是不是运行数据
 * @param {string} relative - posix 写法的相对路径
 * @returns {boolean}
 */
function isRuntimePath(relative) {
  const parts = relative.split('/')
  if (parts.some((part) => RUNTIME_DIRS.has(part))) return true
  const base = parts[parts.length - 1]
  if (RUNTIME_FILES.has(base)) return true
  return RUNTIME_EXTENSIONS.some((extension) => base.endsWith(extension))
}

/**
 * 逐文件读一个 Skill 目录（根可以是链接，会跟进；里面的链接不跟进）
 * @param {string} dir
 * @param {object} [deps] - readdirFn / readFileFn / lstatFn / readlinkFn 可注入
 * @returns {Promise<Map<string, string>>} 相对路径 → 摘要（文件 F:…，链接 L:目标）
 */
async function readEntries(dir, deps = {}) {
  const readdirFn = deps.readdirFn || fs.readdir
  const readFileFn = deps.readFileFn || fs.readFile
  const lstatFn = deps.lstatFn || fs.lstat
  const readlinkFn = deps.readlinkFn || fs.readlink
  const entries = new Map()
  async function walk(current, relative) {
    const items = await readdirFn(current, { withFileTypes: true })
    items.sort((left, right) => left.name.localeCompare(right.name))
    for (const item of items) {
      const absolute = path.join(current, item.name)
      const rel = relative ? `${relative}/${item.name}` : item.name
      const stat = await lstatFn(absolute)
      if (stat.isSymbolicLink()) {
        entries.set(rel, `L:${await readlinkFn(absolute)}`)
      } else if (stat.isDirectory()) {
        await walk(absolute, rel)
      } else if (stat.isFile()) {
        const content = await readFileFn(absolute)
        entries.set(rel, `F:${crypto.createHash('sha256').update(content).digest('hex')}`)
      }
    }
  }
  await walk(dir, '')
  return entries
}

function digestOf(entries, includeRuntime) {
  const hash = crypto.createHash('sha256')
  for (const key of [...entries.keys()].sort()) {
    if (!includeRuntime && isRuntimePath(key)) continue
    hash.update(`${key}\0${entries.get(key)}\0`)
  }
  return hash.digest('hex')
}

/** 正文摘要：不含运行数据 */
function contentDigest(entries) {
  return digestOf(entries, false)
}

/** 完整摘要：含运行数据 */
function fullDigest(entries) {
  return digestOf(entries, true)
}

function fileRank(relative) {
  if (relative === 'SKILL.md') return 0
  if (relative.startsWith('scripts/') || SCRIPT_EXTENSIONS.some((extension) => relative.endsWith(extension))) return 1
  return 2
}

/**
 * 差异文件的显示顺序：SKILL.md 第一、脚本其次、其余按名字
 * @param {string[]} list
 * @returns {string[]}
 */
function orderFiles(list) {
  return [...list].sort((left, right) => fileRank(left) - fileRank(right) || left.localeCompare(right))
}

/**
 * 一份和资产库比（运行数据不比）
 * @param {Map<string,string>} library - 资产库那份
 * @param {Map<string,string>} copy - 这一份
 * @returns {{relation: 'same'|'diff', added: string[], removed: string[], changed: string[]}}
 */
function compareEntries(library, copy) {
  const keep = (map) => new Map([...map].filter(([key]) => !isRuntimePath(key)))
  const left = keep(library)
  const right = keep(copy)
  const added = [...right.keys()].filter((key) => !left.has(key))
  const removed = [...left.keys()].filter((key) => !right.has(key))
  const changed = [...right.keys()].filter((key) => left.has(key) && left.get(key) !== right.get(key))
  const relation = added.length + removed.length + changed.length === 0 ? 'same' : 'diff'
  return { relation, added: orderFiles(added), removed: orderFiles(removed), changed: orderFiles(changed) }
}

module.exports = { isRuntimePath, readEntries, contentDigest, fullDigest, orderFiles, compareEntries }
