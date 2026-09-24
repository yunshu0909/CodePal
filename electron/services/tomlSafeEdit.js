/**
 * TOML 保格式编辑
 *
 * 负责：
 * - 用词法扫描找出顶层表头与键值行的精确位置（跳过字符串、多行字符串、数组、内联表、注释）
 * - 只替换目标文字区间，未改动的字节（注释、换行、空白、引号）原样保留
 * - 改完重新解析，确认语义上只变了预期内容；做不到就拒绝，不回退成整份重写
 *
 * 语义事实由 smol-toml（TOML 1.0）解析；本模块只负责「在原文里找到它、只改那一段」。
 * （@iarna/toml 只支持 TOML 0.5，会把 Codex 能读的合法 1.0 写法判成非法，所以不用它）
 * 扫描器假定输入已通过解析（合法 TOML），所以只需正确处理合法写法。
 *
 * @module electron/services/tomlSafeEdit
 */

const { parse: parseTomlText } = require('smol-toml')

/**
 * 生成带 code 的错误
 * @param {string} code - 错误码
 * @returns {Error}
 */
function codedError(code) {
  return Object.assign(new Error(code), { code })
}

/**
 * 取对象自有的键（含 __proto__ 这类特殊名字的自有键）
 * @param {object} value
 * @returns {string[]}
 */
function ownKeys(value) {
  return Reflect.ownKeys(value).filter((key) => typeof key === 'string').sort()
}

/**
 * 保留类型的深比较：日期只和日期比、表只和表比，不做会互相碰撞的转写
 * @param {*} a
 * @param {*} b
 * @returns {boolean}
 */
function sameSemantics(a, b) {
  if (Object.is(a, b)) return true
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false
  if (a instanceof Date || b instanceof Date) {
    if (!(a instanceof Date && b instanceof Date) || a.constructor !== b.constructor) return false
    // 日期的类别（日期 / 时间 / 本地 / 带时区）和精确到毫秒的值都要一致；String() 会丢毫秒和类别
    const kind = (d) => ['isDateTime', 'isLocal', 'isDate', 'isTime'].map((m) => (typeof d[m] === 'function' ? d[m]() : null)).join(',')
    return kind(a) === kind(b) && Object.is(a.getTime(), b.getTime()) && String(a) === String(b)
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) return a.length === b.length && a.every((item, index) => sameSemantics(item, b[index]))
  const keysA = ownKeys(a)
  const keysB = ownKeys(b)
  return keysA.length === keysB.length && keysA.every((key, index) => key === keysB[index] && sameSemantics(a[key], b[key]))
}

/**
 * 复制一份可改的结构：表和数组逐层新建，叶子值（含日期）共用；用无原型对象保存，__proto__ 也只是普通键
 * @param {*} value
 * @returns {*}
 */
function cloneTree(value) {
  if (Array.isArray(value)) return value.map(cloneTree)
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out = Object.create(null)
    for (const key of ownKeys(value)) Object.defineProperty(out, key, { value: cloneTree(value[key]), enumerable: true, writable: true, configurable: true })
    return out
  }
  return value
}

/**
 * 解析 TOML，失败时统一成 invalidCode
 * @param {string} text - 原文
 * @param {string} invalidCode - 解析失败时的错误码
 * @returns {object}
 */
function parseToml(text, invalidCode) {
  try {
    // 整数一律读成 BigInt：64 位大整数不丢精度，也能和 1.0 这类浮点数区分开
    return parseTomlText(String(text || ''), { integersAsBigInt: true })
  } catch {
    throw codedError(invalidCode)
  }
}

/**
 * 从 index 起跳过一个字符串字面量，返回字符串之后的位置
 * @param {string} text
 * @param {number} index - 指向开头引号
 * @returns {number}
 */
function skipString(text, index) {
  const quote = text[index]
  const multi = text.startsWith(quote.repeat(3), index)
  const escapes = quote === '"'
  let i = index + (multi ? 3 : 1)
  while (i < text.length) {
    if (escapes && text[i] === '\\') { i += 2; continue }
    if (multi) {
      if (text.startsWith(quote.repeat(3), i)) {
        // 多行字符串允许以 1–2 个引号结尾再接三引号，如 """a"""" → 取最后的三引号
        let end = i + 3
        while (text[end] === quote && end < i + 5) end++
        return end
      }
    } else if (text[i] === quote) {
      return i + 1
    }
    i++
  }
  return text.length
}

/**
 * 跳到当前行末（换行之后）
 * @param {string} text
 * @param {number} index
 * @returns {number}
 */
function nextLine(text, index) {
  const newline = text.indexOf('\n', index)
  return newline < 0 ? text.length : newline + 1
}

/**
 * 读一个（可能带点、带引号的）键，直到 terminator
 * @param {string} text
 * @param {number} index - 键的起点
 * @param {string} terminator - '=' / ']' / ']]'
 * @returns {{parts: string[], end: number}} end 指向 terminator 之后
 */
function readKey(text, index, terminator) {
  const parts = []
  let i = index
  for (;;) {
    while (text[i] === ' ' || text[i] === '\t') i++
    if (text[i] === '"' || text[i] === "'") {
      const end = skipString(text, i)
      const raw = text.slice(i, end)
      parts.push(text[i] === '"' ? parseToml(`k = ${raw}`, 'TOML_UNSUPPORTED').k : raw.slice(1, -1))
      i = end
    } else {
      const start = i
      while (i < text.length && /[A-Za-z0-9_-]/.test(text[i])) i++
      if (i === start) throw codedError('TOML_UNSUPPORTED')
      parts.push(text.slice(start, i))
    }
    while (text[i] === ' ' || text[i] === '\t') i++
    if (text[i] === '.') { i++; continue }
    if (!text.startsWith(terminator, i)) throw codedError('TOML_UNSUPPORTED')
    return { parts, end: i + terminator.length }
  }
}

/**
 * 扫描一个值的范围：数组 / 内联表可以跨行，其中的字符串和注释都要跳过
 * @param {string} text
 * @param {number} index - 值的起点
 * @returns {number} 值末尾（不含行尾空白与注释）
 */
function scanValue(text, index) {
  let depth = 0
  let i = index
  let end = index
  while (i < text.length) {
    const c = text[i]
    if (c === '"' || c === "'") { i = skipString(text, i); end = i; continue }
    if (c === '#') {
      if (depth === 0) return end
      i = nextLine(text, i)
      continue
    }
    if (c === '\n' || (c === '\r' && text[i + 1] === '\n')) {
      if (depth === 0) return end
      i++
      continue
    }
    if (c === '[' || c === '{') depth++
    if (c === ']' || c === '}') depth--
    i++
    if (c !== ' ' && c !== '\t' && c !== '\r') end = i
  }
  return end
}

/**
 * 扫描整份文档的顶层结构
 * @param {string} text - 合法 TOML 原文
 * @returns {Array<{type:'header', parts:string[], array:boolean, lineStart:number, lineEnd:number}|{type:'kv', parts:string[], lineStart:number, valueStart:number, valueEnd:number, lineEnd:number}>}
 */
function scanDocument(text) {
  const items = []
  let i = 0
  while (i < text.length) {
    const lineStart = i
    while (text[i] === ' ' || text[i] === '\t') i++
    const c = text[i]
    if (i >= text.length) break
    if (c === '\n' || c === '\r' || c === '#') { i = nextLine(text, i); continue }
    if (c === '[') {
      const array = text[i + 1] === '['
      const { parts, end } = readKey(text, i + (array ? 2 : 1), array ? ']]' : ']')
      i = nextLine(text, end)
      items.push({ type: 'header', parts, array, lineStart, lineEnd: i })
      continue
    }
    const { parts, end } = readKey(text, i, '=')
    let valueStart = end
    while (text[valueStart] === ' ' || text[valueStart] === '\t') valueStart++
    const valueEnd = scanValue(text, valueStart)
    i = nextLine(text, valueEnd)
    items.push({ type: 'kv', parts, lineStart, valueStart, valueEnd, lineEnd: i })
  }
  return items
}

/**
 * 判断两个键路径是否相同
 * @param {string[]} a
 * @param {string[]} b
 * @returns {boolean}
 */
function samePath(a, b) {
  return a.length === b.length && a.every((part, index) => part === b[index])
}

/**
 * 找出某个「表数组」（如 [[skills.config]]）每一项在原文中的范围
 * @param {string} text
 * @param {string[]} tablePath - 如 ['skills', 'config']
 * @returns {Array<{header: object, keys: object[], end: number}>}
 */
function locateArrayTables(text, tablePath) {
  const items = scanDocument(text)
  const blocks = []
  let current = null
  for (const item of items) {
    if (item.type === 'header') {
      if (current) current.end = item.lineStart
      current = item.array && samePath(item.parts, tablePath) ? { header: item, keys: [], end: text.length } : null
      if (current) blocks.push(current)
    } else if (current) {
      current.keys.push(item)
    }
  }
  return blocks
}

/**
 * 把字符串写成 TOML 基本字符串
 * @param {string} value
 * @returns {string}
 */
function tomlString(value) {
  return JSON.stringify(String(value))
}

/**
 * 在「表数组」里设置某一项的布尔字段；没有这一项就在文末追加
 *
 * 步骤：解析原文 → 按 match 找到第几项 → 在原文里定位同一项 → 只改 / 插一行 → 重新解析，
 * 确认除了这一个字段（或追加的这一项）以外语义完全不变。
 *
 * @param {string} text - 原文（可为空）
 * @param {object} spec
 * @param {string[]} spec.tablePath - 如 ['skills', 'config']
 * @param {(entry: object) => boolean} spec.match - 判断哪一项是目标
 * @param {string} spec.field - 如 'enabled'
 * @param {boolean} spec.value - 目标值
 * @param {object} spec.newEntry - 找不到目标时追加的完整项（字段顺序即写出顺序，值只支持字符串 / 布尔）
 * @param {string} [spec.invalidCode='TOML_INVALID']
 * @param {string} [spec.unsupportedCode='TOML_UNSUPPORTED']
 * @returns {{text: string, changed: boolean}}
 */
function setArrayTableBoolean(text, spec) {
  const source = String(text || '')
  const invalidCode = spec.invalidCode || 'TOML_INVALID'
  const unsupportedCode = spec.unsupportedCode || 'TOML_UNSUPPORTED'
  const doc = parseToml(source, invalidCode)

  let container = doc
  for (const part of spec.tablePath) container = container?.[part]
  if (container !== undefined && !Array.isArray(container)) throw codedError(unsupportedCode)
  const entries = container || []
  const index = entries.findIndex((entry) => spec.match(entry))

  let blocks
  try {
    blocks = locateArrayTables(source, spec.tablePath)
  } catch {
    throw codedError(unsupportedCode)
  }
  // 条数对不上说明这个数组不是全用 [[...]] 写的（比如内联定义），无法安全定位
  if (blocks.length !== entries.length) throw codedError(unsupportedCode)

  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const expected = cloneTree(doc)
  let next

  if (index >= 0) {
    if (entries[index][spec.field] === spec.value) return { text: source, changed: false }
    const block = blocks[index]
    const fieldLine = block.keys.find((item) => samePath(item.parts, [spec.field]))
    if (fieldLine) {
      next = source.slice(0, fieldLine.valueStart) + String(spec.value) + source.slice(fieldLine.valueEnd)
    } else {
      // 插在该项最后一个键之后（仍在这一项里），不落到后面的表
      const anchor = block.keys.at(-1)?.lineEnd ?? block.header.lineEnd
      const prefix = source.slice(0, anchor)
      const joiner = prefix.endsWith('\n') ? '' : eol
      next = `${prefix}${joiner}${spec.field} = ${spec.value}${eol}${source.slice(anchor)}`
    }
    let target = expected
    for (const part of spec.tablePath) target = target[part]
    target[index][spec.field] = spec.value
  } else {
    const lines = Object.entries(spec.newEntry).map(([key, value]) => {
      if (typeof value === 'boolean') return `${key} = ${value}`
      if (typeof value === 'string') return `${key} = ${tomlString(value)}`
      throw codedError(unsupportedCode)
    })
    const base = source.length && !source.endsWith('\n') ? `${source}${eol}` : source
    const gap = base.length ? eol : ''
    next = `${base}${gap}[[${spec.tablePath.join('.')}]]${eol}${lines.join(eol)}${eol}`
    let parent = expected
    for (const part of spec.tablePath.slice(0, -1)) parent = parent[part] ??= Object.create(null)
    const leaf = spec.tablePath.at(-1)
    parent[leaf] = [...(parent[leaf] || []), cloneTree({ ...spec.newEntry })]
  }

  const reparsed = parseToml(next, unsupportedCode)
  if (!sameSemantics(reparsed, expected)) throw codedError(unsupportedCode)
  return { text: next, changed: next !== source }
}

module.exports = {
  parseToml,
  scanDocument,
  locateArrayTables,
  setArrayTableBoolean,
}
