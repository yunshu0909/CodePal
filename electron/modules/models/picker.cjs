/**
 * 第三方模型接入 · 在终端里用：codepal 选择程序
 *
 * 负责：
 * - 由总入口 ~/.local/bin/codepal 用 CodePal 自带的 Node 运行（ELECTRON_RUN_AS_NODE=1）；CodePal 关着也能用
 * - 列出测过能用的模型（后-01，commands.readyModels），↑↓ / j k 移动、到头循环，回车选中，Esc / Ctrl-C 取消（后-04）
 * - 界面画在标准错误；选中后把单模型命令的绝对路径写到标准输出、退出 0，由总入口 exec 成它（后-03）
 * - 光标默认停在上次选的那个；上次的选择记在模型目录 picker-last.json，记不进去也照样打开（后-02、后-03-例3）
 * - 不在交互终端（总入口传 CODEPAL_PICKER_TTY=0）：可选模型打到标准错误，退出 2，标准输出不写（后-07）
 * - 列宽按显示宽度算；比终端高时只显示一屏、随光标滚动；任何退出都先恢复终端（后-18）
 * - 选中、取消或命令刚被移除时，先把两行说明和列表擦掉再打那一句（定稿 T2、T4：列表消失）
 * - 退出码：0 选中；1 没有能用的模型 / 配置读不出 / 选中的命令刚被移除；2 非交互；130 取消
 *
 * @module electron/modules/models/picker
 */

const fs = require('fs')
const path = require('path')
const store = require('./store')
const commands = require('./commands')

const LAST_FILE = 'picker-last.json'
const out = process.stderr
const HEAD = '选择要用的模型，打开 Claude Code（↑↓ 选择 · 回车打开 · Esc 取消）'
const NOTE = '列表里只有在 CodePal 测过能用的模型'
const DIM = (s) => `\x1b[2m${s}\x1b[0m`
const AVAILABLE = '● 可用'

/**
 * 一行列表的样子：选中行整行反显；没选中的行「● 可用」是绿色（定稿 T1）。
 * 颜色在截短之后加，显示宽度按不带颜色的文字算
 * @param {string} line - 已按显示宽度截短的一行
 * @param {boolean} selected
 * @returns {string}
 */
function rowOut(line, selected) {
  if (selected) return `\x1b[7m${line}\x1b[0m`
  return line.endsWith(AVAILABLE) ? `${line.slice(0, -AVAILABLE.length)}\x1b[32m${AVAILABLE}\x1b[39m` : line
}
// 单按 Esc 与方向键开头的 ESC 分开：ESC 后这么久没有跟着别的字节才算单按 Esc（后-04）
const ESC_WAIT_MS = 50

/** 显示宽度：中文、全角算两格 */
function width(text) {
  let n = 0
  for (const ch of String(text)) {
    const c = ch.codePointAt(0)
    const wide = (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3)
      || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6)
    n += wide ? 2 : 1
  }
  return n
}
const pad = (text, w) => text + ' '.repeat(Math.max(0, w - width(text)))

/** 按显示宽度截短（只用于重画，避免一行折成两行把上移的行数算错） */
function clip(text, w) {
  if (width(text) <= w) return text
  let s = ''
  for (const ch of text) {
    if (width(s + ch) > w - 1) break
    s += ch
  }
  return s + '…'
}

function readLast() {
  try { return JSON.parse(fs.readFileSync(path.join(store.resolveModelsHome(), LAST_FILE), 'utf8')).command || null } catch { return null }
}
function writeLast(command) {
  try { fs.writeFileSync(path.join(store.resolveModelsHome(), LAST_FILE), JSON.stringify({ command }) + '\n') } catch {}
}

/** 主流程；返回退出码，选中时先把命令写到标准输出 */
function main() {
  let items
  try {
    items = commands.readyModels()
  } catch {
    out.write('模型配置读不出，打开 CodePal「模型接入」看看\n')
    return Promise.resolve(1)
  }
  if (!items.length) {
    out.write('还没有测过能用的模型，所以列表是空的。\n打开 CodePal →「模型接入」，填好 Key，给模型点「测一下」，通过后就会出现在这里。\n')
    return Promise.resolve(1)
  }
  const nameW = Math.max(...items.map((i) => width(i.model))) + 4
  const provW = Math.max(...items.map((i) => width(i.providerName))) + 4
  const lineOf = (i) => `${pad(i.model, nameW)}${pad(i.providerName, provW)}${AVAILABLE}`
  if (process.env.CODEPAL_PICKER_TTY !== '1' || !process.stdin.isTTY) {
    out.write(items.map((i) => `${i.model}\t${i.providerName}`).join('\n') + '\n')
    return Promise.resolve(2)
  }

  const last = readLast()
  let cur = Math.max(0, items.findIndex((i) => i.command === last))
  let top = 0
  let drawn = 0
  const stdin = process.stdin

  const restore = () => {
    try { stdin.setRawMode(false) } catch {}
    stdin.pause()
    out.write('\x1b[?25h')
  }
  // 两行说明 + 一行空行
  const HEAD_LINES = 3
  /** 擦掉两行说明和列表，光标回到说明第一行的行首 */
  const erase = () => {
    if (!drawn) return
    out.write(`\x1b[${drawn + HEAD_LINES}A\r\x1b[J`)
    drawn = 0
  }
  const visibleRows = () => Math.max(1, ((out.rows || process.stdout.rows || 24) - 3))
  const draw = () => {
    const cols = out.columns || 80
    const rows = Math.min(items.length, visibleRows())
    if (cur < top) top = cur
    if (cur >= top + rows) top = cur - rows + 1
    if (drawn) out.write(`\x1b[${drawn}A`)
    for (let k = 0; k < rows; k++) {
      const i = items[top + k]
      const text = clip(`${top + k === cur ? '›' : ' '} ${lineOf(i)}`, cols - 1)
      out.write('\x1b[2K' + rowOut(text, top + k === cur) + '\n')
    }
    drawn = rows
  }

  return new Promise((resolve) => {
    let pending = ''
    let escTimer = null
    const finish = (code) => {
      clearTimeout(escTimer)
      restore()
      resolve(code)
    }
    const choose = () => {
      const it = items[cur]
      // 回车时再核对一次：命令刚被移除（或不再是 CodePal 生成的）就不打开（后-03-例4）
      if (!commands.isGenerated(readSafe(it.file))) {
        erase()
        restore()
        out.write('这个模型的命令刚被移除了，重新输入 codepal 选一个\n')
        clearTimeout(escTimer)
        resolve(1)
        return
      }
      writeLast(it.command)
      erase()
      restore()
      out.write(DIM(`→ 正在用 ${it.model}（${it.providerName}）打开 Claude Code…`) + '\n')
      process.stdout.write(it.file + '\n')
      clearTimeout(escTimer)
      resolve(0)
    }
    const UP = ['\x1b[A', '\x1bOA', 'k']
    const DOWN = ['\x1b[B', '\x1bOB', 'j']
    const move = (step) => {
      cur = (cur + step + items.length) % items.length
      draw()
    }
    const cancel = () => {
      erase()
      out.write('已取消，没有打开 Claude Code\n')
      finish(130)
    }
    /** 一个按键：↑↓（含 j / k）移动、到头循环；回车打开；Esc / Ctrl-C 取消；其他键不理 */
    const handle = (seq) => {
      if (UP.includes(seq)) move(-1)
      else if (DOWN.includes(seq)) move(1)
      else if (seq === '\r' || seq === '\n') choose()
      else if (seq === '\x03' || seq === '\x1b') cancel()
    }
    /** 从 pending 前面取一段交给 handle */
    const take = (length) => {
      const seq = pending.slice(0, length)
      pending = pending.slice(length)
      handle(seq)
    }
    const feed = () => {
      while (pending) {
        if (pending.startsWith('\x1b[') || pending.startsWith('\x1bO')) {
          if (pending.length < 3) return
          take(3)
        } else if (pending[0] === '\x1b') {
          if (pending.length === 1) {
            // 可能是方向键的开头：等一小会儿再认成 Esc
            escTimer = setTimeout(() => {
              if (pending === '\x1b') take(1)
            }, ESC_WAIT_MS)
            return
          }
          take(1)
        } else {
          take(1)
        }
      }
    }
    for (const sig of ['SIGTERM', 'SIGHUP']) process.on(sig, () => finish(130))
    process.on('uncaughtException', () => finish(1))
    // 先进入按键直读、再画列表：不然列表画出来到进入直读之间按的键会被终端回显进列表里
    stdin.setRawMode(true)
    stdin.resume()
    out.write(DIM(HEAD) + '\n' + DIM(NOTE) + '\n\n\x1b[?25l')
    draw()
    stdin.on('data', (buf) => {
      clearTimeout(escTimer)
      pending += buf.toString('utf8')
      feed()
    })
    process.stderr.on('resize', draw)
  })
}

function readSafe(file) {
  try { return fs.readFileSync(file, 'utf8') } catch { return null }
}

if (require.main === module) {
  main().then((code) => process.exit(code), () => process.exit(1))
}

module.exports = { main, width, rowOut }
