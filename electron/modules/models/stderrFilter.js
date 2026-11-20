/**
 * 第三方模型接入 · 后台模式标准错误过滤
 *
 * 负责：
 * - 去掉 Claude Code 对「这次启动 CodePal 配的模型名」打的诊断行
 *   `[claude-code:unrecognized_model] {"model":"<模型名>",...}`（问题池 #90）
 * - 其余内容原样、按原顺序透传；别的模型名的同类行照常透传，免得藏住调用方自己配错的名字
 *
 * 为什么不在设置里声明模型名：官方给的办法（modelOverrides / modelPicker.behavesAs）会让 Claude Code
 * 把这个名字当成某个 Claude 模型，连发给模型的系统提示都会改（2026-11-20 用 2.1.325 抓包实测）。
 * 这行本身只是给脚本看的提示，官方文档写明可以按这个开头匹配；请求照样按原名发出。
 *
 * 分块：管道里一行可能拆成几块到达。只有行首的内容还可能是这行时才先攒着，其余立即透传，不额外等待。
 * 输入是已解码的文字：调用方给流设 utf8 编码，多字节字符跨块由流自己拼好。
 *
 * @module electron/modules/models/stderrFilter
 */

const UNRECOGNIZED_MODEL_PREFIX = '[claude-code:unrecognized_model]'

/** 这一行（不含换行）是不是 Claude Code 对 modelName 打的诊断行 */
function isConfiguredModelLine(line, modelName) {
  if (!line.startsWith(UNRECOGNIZED_MODEL_PREFIX)) return false
  try {
    return JSON.parse(line.slice(UNRECOGNIZED_MODEL_PREFIX.length)).model === modelName
  } catch {
    return false
  }
}

/** 行首这段内容再收到一些后还可能变成诊断行 */
function mayBecomePrefixed(head) {
  return UNRECOGNIZED_MODEL_PREFIX.startsWith(head) || head.startsWith(UNRECOGNIZED_MODEL_PREFIX)
}

/**
 * 建一个过滤器
 * @param {object} p
 * @param {string} p.modelName - 这次启动 CodePal 配的模型名（与 Claude Code 打出的 model 字段逐字比较）
 * @param {(text: string) => void} p.write - 过滤后的内容交给谁
 * @returns {{push: (text: string) => void, end: () => void}} push 每块输出；end 在子进程结束后调一次，交出攒着的尾巴
 */
function createStderrFilter({ modelName, write }) {
  let pending = ''
  let atLineStart = true

  const lineOf = (text) => text.replace(/\r$/, '')

  function consume(text) {
    let buf = pending + text
    pending = ''
    let out = ''
    while (buf) {
      const nl = buf.indexOf('\n')
      if (!atLineStart) {
        if (nl === -1) { out += buf; break }
        out += buf.slice(0, nl + 1)
        buf = buf.slice(nl + 1)
        atLineStart = true
        continue
      }
      if (nl === -1) {
        if (mayBecomePrefixed(buf)) pending = buf
        else { out += buf; atLineStart = false }
        break
      }
      if (!isConfiguredModelLine(lineOf(buf.slice(0, nl)), modelName)) out += buf.slice(0, nl + 1)
      buf = buf.slice(nl + 1)
    }
    if (out) write(out)
  }

  return {
    push: consume,
    end: () => {
      const rest = pending
      pending = ''
      if (rest && !isConfiguredModelLine(lineOf(rest), modelName)) write(rest)
    },
  }
}

module.exports = { UNRECOGNIZED_MODEL_PREFIX, createStderrFilter }
