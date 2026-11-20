/**
 * 第三方模型接入 · 后台模式标准错误过滤
 *
 * 负责：
 * - 去掉 Claude Code 对「这次启动 CodePal 配的模型名」打的诊断行
 *   `[claude-code:unrecognized_model] {"model":"<模型名>",...}`（问题池 #90）
 * - 其余字节原样、按原顺序透传，不做编码转换；别的模型名的同类行照常透传，免得藏住调用方自己配错的名字
 *
 * 为什么不在设置里声明模型名：官方给的办法（modelOverrides / modelPicker.behavesAs）会让 Claude Code
 * 把这个名字当成某个 Claude 模型，连发给模型的系统提示都会改（2026-11-20 用 2.1.325 抓包实测）。
 * 这行本身只是给脚本看的提示，官方文档写明可以按这个开头匹配；请求照样按原名发出。
 *
 * 分块：管道里一行可能拆成几块到达。行首内容还可能是这次模型名那行时先攒着（最多 MAX_HELD 字节）：
 * 还没收全前缀时看是否和前缀逐字一致；收全前缀后，一旦已经读到一个完整的 "model" 值且不是这次的模型名，
 * 就立即透传，不等换行。整行到齐后按 JSON 解析判断，所以多空格、字段换顺序等等价写法也认得出。
 *
 * @module electron/modules/models/stderrFilter
 */

const UNRECOGNIZED_MODEL_PREFIX = '[claude-code:unrecognized_model]'
const PREFIX_BYTES = Buffer.from(UNRECOGNIZED_MODEL_PREFIX, 'utf8')
const NEWLINE = 0x0a
const CARRIAGE_RETURN = 0x0d
// 诊断行只有一两百字节；攒到这么多还没换行就不再当它是诊断行，原样放行
const MAX_HELD = 64 * 1024
// 已收到的正文里第一个完整的 "model" 字符串值
const MODEL_VALUE_RE = /"model"\s*:\s*("(?:[^"\\]|\\.)*")/

/**
 * 建一个过滤器
 * @param {object} p
 * @param {string} p.modelName - 这次启动 CodePal 配的模型名（与 Claude Code 打出的 model 字段逐字比较）
 * @param {(bytes: Buffer) => void} p.write - 过滤后的原始字节交给谁
 * @returns {{push: (chunk: Buffer) => void, end: () => void}} push 每块原始输出；end 在子进程结束后调一次，交出攒着的尾巴
 */
function createStderrFilter({ modelName, write }) {
  let pending = Buffer.alloc(0)
  let atLineStart = true

  /** 行首这段还没换行的内容，再收到一些后还可能是要去掉的那行 */
  const mayBeTarget = (head) => {
    if (head.length > MAX_HELD) return false
    const n = Math.min(head.length, PREFIX_BYTES.length)
    if (!head.subarray(0, n).equals(PREFIX_BYTES.subarray(0, n))) return false
    if (head.length <= PREFIX_BYTES.length) return true
    const seen = MODEL_VALUE_RE.exec(head.subarray(PREFIX_BYTES.length).toString('utf8'))
    if (!seen) return true
    try {
      return JSON.parse(seen[1]) === modelName
    } catch {
      return true
    }
  }

  /** 这一整行（不含换行）是不是要去掉的那行；超长的一律不算，和分块方式无关 */
  const isTarget = (line) => {
    const body = line.length && line[line.length - 1] === CARRIAGE_RETURN ? line.subarray(0, -1) : line
    if (body.length > MAX_HELD || body.length < PREFIX_BYTES.length) return false
    if (!body.subarray(0, PREFIX_BYTES.length).equals(PREFIX_BYTES)) return false
    try {
      const fields = JSON.parse(body.subarray(PREFIX_BYTES.length).toString('utf8'))
      return fields !== null && typeof fields === 'object' && fields.model === modelName
    } catch {
      return false
    }
  }

  function consume(chunk) {
    const buf = pending.length ? Buffer.concat([pending, chunk]) : chunk
    pending = Buffer.alloc(0)
    const out = []
    let i = 0
    while (i < buf.length) {
      const nl = buf.indexOf(NEWLINE, i)
      if (!atLineStart) {
        if (nl === -1) { out.push(buf.subarray(i)); break }
        out.push(buf.subarray(i, nl + 1))
        i = nl + 1
        atLineStart = true
        continue
      }
      if (nl === -1) {
        const head = buf.subarray(i)
        if (mayBeTarget(head)) pending = Buffer.from(head)
        else { out.push(head); atLineStart = false }
        break
      }
      if (!isTarget(buf.subarray(i, nl))) out.push(buf.subarray(i, nl + 1))
      i = nl + 1
    }
    if (out.length) write(Buffer.concat(out))
  }

  return {
    push: consume,
    end: () => {
      const rest = pending
      pending = Buffer.alloc(0)
      if (rest.length && !isTarget(rest)) write(rest)
    },
  }
}

module.exports = { UNRECOGNIZED_MODEL_PREFIX, createStderrFilter }
