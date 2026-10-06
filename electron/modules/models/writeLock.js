/**
 * 配置目录的写入锁（后-12、B-002）：同一个配置目录只允许一个 CodePal 写
 *
 * - 锁文件 .write.lock，内容是持有者 pid；第一次要写时排他创建，之后一直持有，stop 时删掉
 * - 创建用「先写好临时文件、再硬链接成锁文件」：链接是排他且一步完成的，别人看到的锁文件一定已有完整内容，
 *   不会把刚建好、还没写完的锁误当成坏锁
 * - 锁文件已在：持有者就是本进程（同一进程里另一个实例）照常写；持有者还活着 → 这次保存失败；
 *   持有者已不在（崩溃留下的）或锁文件坏了 → 接管
 * - 接管一次只允许一个进程做：每个要接管的进程先放一份只属于自己的接管标记 `.write-lock-takeover.<pid>`，
 *   再看有没有别的活着的进程的标记，有就让开（这次保存失败）。两边都是「先放标记、再看别人」，至少一方
 *   能看到另一方，所以不会两个同时接管；拿到接管资格后再读一次锁文件，确认仍是那份旧锁才删掉重建，
 *   不会删掉别人刚建好的新锁
 *
 * @module electron/modules/models/writeLock
 */
const fs = require('fs')
const path = require('path')

const LOCK_FILE = '.write.lock'
const TAKEOVER_PREFIX = '.write-lock-takeover.'
const LOCK_BUSY_MESSAGE = '另一个 CodePal 正在写这份配置，关掉它后重试'

function busy() {
  const error = new Error(LOCK_BUSY_MESSAGE)
  error.code = 'LOCK_BUSY'
  return error
}

/** @param {number} pid @returns {boolean} 这个进程还在（没权限发信号也算在） */
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/** @returns {number|null|undefined} 持有者 pid；锁文件坏了为 null；没有锁文件为 undefined */
function ownerOf(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Number.isInteger(value?.pid) ? value.pid : null
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    return null
  }
}

/**
 * @param {string} dir 主进程解析的配置目录
 * @param {{pid?: number}} [options] pid 只给测试注入
 * @returns {{acquire: Function, release: Function}}
 * acquire 拿不到时抛 code=LOCK_BUSY；release 只删自己持有的锁。
 */
function createWriteLock(dir, { pid = process.pid } = {}) {
  const file = path.join(dir, LOCK_FILE)
  const marker = path.join(dir, `${TAKEOVER_PREFIX}${pid}`)
  let held = false

  /** 排他创建一份内容完整的锁文件；已有锁文件返回 false */
  function create() {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const temp = path.join(dir, `${LOCK_FILE}.${pid}.tmp`)
    fs.writeFileSync(temp, JSON.stringify({ pid, startedAt: new Date().toISOString() }), { mode: 0o600 })
    try {
      fs.linkSync(temp, file)
      return true
    } catch (error) {
      if (error.code === 'EEXIST') return false
      throw error
    } finally {
      fs.rmSync(temp, { force: true })
    }
  }

  const otherTakers = () =>
    fs
      .readdirSync(dir)
      .filter((name) => name.startsWith(TAKEOVER_PREFIX))
      .map((name) => Number(name.slice(TAKEOVER_PREFIX.length)))
      .some((other) => other !== pid && alive(other))

  /** 接管崩溃留下的锁或坏锁：同一时刻只有一个进程能做，且只删确认过仍是旧锁的那份 */
  function takeOver() {
    fs.writeFileSync(marker, String(pid), { mode: 0o600 })
    try {
      if (otherTakers()) throw busy()
      const owner = ownerOf(file)
      if (owner === pid) return true
      if (owner !== undefined && owner !== null && alive(owner)) throw busy()
      if (owner !== undefined) fs.rmSync(file, { force: true })
      return create()
    } finally {
      fs.rmSync(marker, { force: true })
    }
  }

  function acquire() {
    if (held && ownerOf(file) === pid) return
    held = false
    if (create()) {
      held = true
      return
    }
    const owner = ownerOf(file)
    if (owner === pid) {
      held = true
      return
    }
    if (owner !== undefined && owner !== null && alive(owner)) throw busy()
    if (!takeOver()) throw busy()
    held = true
  }

  function release() {
    if (!held) return
    held = false
    if (ownerOf(file) === pid) fs.rmSync(file, { force: true })
  }

  return { acquire, release }
}

module.exports = { LOCK_FILE, LOCK_BUSY_MESSAGE, createWriteLock }
