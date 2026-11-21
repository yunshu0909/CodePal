/**
 * Skills 页「上次的列表和次数」（#101）
 *
 * 负责：
 * - 重开 CodePal 后 Skills 页先显示上次关应用前读到的快照和近 30 天次数，后台读完再原地换成最新的
 * - 只是 CodePal 自己的缓存：放在 CodePal 数据目录 skills/last-view/，删了下次读完自动重建；不写用户的 Skill 配置
 * - 两份文件各自原子写（临时文件 → 落盘 → 改名），同一文件的写排队、只写最新那份；写失败保留原文件
 * - 读到坏的（不是 JSON、格式号不对、页面要用的字段不对）当作没有；不删它（删和正在写的新文件会撞车），
 *   下次读完存新的一份时原子替换掉
 * - 次数只存每个 Skill 的摘要数字和读取时间；调用明细（含会话路径、要绑当次批次）不存
 *
 * @module electron/modules/skills/lastViewStore
 */

const fs = require('fs/promises')
const path = require('path')
const crypto = require('crypto')
const { skillsDataDir } = require('./skillsDataDir')

const FORMAT = 1
// 资产库再大也到不了这里；超过就不存，免得一份缓存拖慢启动
const MAX_BYTES = 8 * 1024 * 1024
const SUMMARY_FIELDS = ['name', 'assetId', 'kind', 'total', 'confirmedTotal', 'claude', 'codex', 'unrecognized',
  'lastUsed', 'lastUsedAt', 'lastRead', 'completeness', 'availability', 'uncertaintyScope']

/** @param {string} homeDir @returns {string} 这份缓存的目录 */
function lastViewDir(homeDir) {
  return path.join(skillsDataDir(homeDir), 'last-view')
}

function fileOf(homeDir, kind) {
  return path.join(lastViewDir(homeDir), `${kind}.json`)
}

/**
 * 原子写：私有临时文件写完落盘再改名，最后同步目录；任何一步失败都删临时文件、保留原文件。
 * @param {string} file
 * @param {string} text
 * @returns {Promise<void>}
 */
async function writeAtomic(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${crypto.randomUUID()}.tmp`
  let handle
  try {
    handle = await fs.open(temp, 'wx', 0o600)
    await handle.writeFile(text)
    await handle.sync()
    await handle.close()
    handle = null
    await fs.rename(temp, file)
    const directory = await fs.open(path.dirname(file), 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  } finally {
    if (handle) await handle.close().catch(() => {})
    await fs.rm(temp, { force: true }).catch(() => {})
  }
}

// 每个文件一条写队列：正在写时来的新值只留最新一份，写完接着写它
const queues = new Map()

/**
 * 排队写一份；返回的 Promise 在这次（或替代它的更新的一次）写完后结束，从不拒绝。
 * @param {string} file
 * @param {object} value
 * @returns {Promise<boolean>} 是否真的写进去了
 */
function enqueue(file, value) {
  let text
  try {
    text = `${JSON.stringify(value)}\n`
  } catch {
    return Promise.resolve(false)
  }
  if (Buffer.byteLength(text) > MAX_BYTES) return Promise.resolve(false)
  let queue = queues.get(file)
  if (!queue) {
    queue = { running: null, next: null, waiters: [] }
    queues.set(file, queue)
  }
  queue.next = text
  const done = new Promise((resolve) => queue.waiters.push(resolve))
  if (!queue.running) {
    queue.running = (async () => {
      let ok = false
      while (queue.next !== null) {
        const current = queue.next
        const waiters = queue.waiters
        queue.next = null
        queue.waiters = []
        ok = await writeAtomic(file, current).then(() => true, () => false)
        waiters.forEach((resolve) => resolve(ok))
      }
      queue.running = null
      if (queues.get(file) === queue && queue.next === null) queues.delete(file)
    })()
  }
  return done
}

/**
 * 等手上所有排队的写都做完（退出前、测试清理临时目录前用）。
 * @returns {Promise<void>}
 */
async function whenLastViewIdle() {
  while (queues.size) await Promise.all([...queues.values()].map((queue) => queue.running))
}

// 写到一半被强行退出会留下临时文件：读的时候顺手删掉一分钟前的（刚开始写的不动）
const ORPHAN_MS = 60 * 1000
async function removeOrphans(directory) {
  let names
  try {
    names = await fs.readdir(directory)
  } catch {
    return
  }
  await Promise.all(names.filter((name) => name.endsWith('.tmp')).map(async (name) => {
    const file = path.join(directory, name)
    const stat = await fs.stat(file).catch(() => null)
    if (stat && Date.now() - stat.mtimeMs > ORPHAN_MS) await fs.rm(file, { force: true }).catch(() => {})
  }))
}

/**
 * 读一份；不存在返回 null；坏了删掉返回 null（权限等读不了的也当作没有，不挡页面）。
 * @param {string} file
 * @param {(value: object) => boolean} valid
 * @returns {Promise<object|null>}
 */
async function readOne(file, valid) {
  let text
  try {
    text = await fs.readFile(file, 'utf8')
  } catch {
    return null
  }
  try {
    const value = JSON.parse(text)
    return value && value.format === FORMAT && valid(value) ? value : null
  } catch {
    return null
  }
}

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const named = (item) => isObject(item) && typeof item.name === 'string' && item.name.length > 0
const optional = (value, check) => value === undefined || value === null || check(value)
// 页面直接拿来用的字段逐个看：每个 Skill 要有名字，列表类字段是数组、工具状态是对象；次数要是数字
const validSkill = (skill) => named(skill) &&
  ['origins', 'locations', 'plugins'].every((field) => optional(skill[field], Array.isArray)) &&
  optional(skill.tools, isObject)
const validSnapshot = (snapshot) => isObject(snapshot) && Array.isArray(snapshot.skills) && snapshot.skills.every(validSkill) &&
  optional(snapshot.tools, isObject) && optional(snapshot.errors, Array.isArray) &&
  optional(snapshot.operations, Array.isArray) && optional(snapshot.ignored, Array.isArray) &&
  optional(snapshot.inbox, (inbox) => isObject(inbox) && optional(inbox.items, Array.isArray))
const validUsage = (data) => isObject(data) && Array.isArray(data.skills) &&
  data.skills.every((skill) => named(skill) && Number.isFinite(skill.total))

/**
 * 存上次的快照（读快照、写操作带回快照之后调）。
 * @param {string} homeDir
 * @param {{repoPath: string, snapshot: object}} entry - repoPath 是主进程解析的资产库，用来区分不同资产库
 * @returns {Promise<boolean>}
 */
function saveLastSnapshot(homeDir, { repoPath, snapshot }) {
  if (typeof repoPath !== 'string' || !repoPath || !validSnapshot(snapshot)) return Promise.resolve(false)
  return enqueue(fileOf(homeDir, 'snapshot'), { format: FORMAT, savedAt: new Date().toISOString(), repoPath, snapshot })
}

/**
 * 只留次数摘要：每个 Skill 的数字和读取时间；批次号不留（重开后那一批已经不在了）。
 * @param {object} data - aggregateUsage 的结果
 * @returns {object}
 */
function summarizeUsage(data) {
  const skills = (Array.isArray(data?.skills) ? data.skills : []).map((skill) =>
    Object.fromEntries(SUMMARY_FIELDS.filter((field) => skill?.[field] !== undefined).map((field) => [field, skill[field]])))
  const sources = isObject(data?.sources) ? data.sources : isObject(data?.scanMeta?.sources) ? data.scanMeta.sources : null
  return {
    window: data?.window ?? null,
    startTime: data?.startTime ?? null,
    endTime: data?.endTime ?? null,
    skills,
    sources,
    scanMeta: { sources, lastScannedAt: data?.scanMeta?.lastScannedAt ?? data?.endTime ?? null },
  }
}

/**
 * 存上次的次数摘要。
 * @param {string} homeDir
 * @param {{cacheKey: string, windowDays: number, data: object}} entry - cacheKey 是页面算的身份键，只用来比对
 * @returns {Promise<boolean>}
 */
function saveLastUsage(homeDir, { cacheKey, windowDays, data }) {
  if (typeof cacheKey !== 'string' || !cacheKey || !isObject(data)) return Promise.resolve(false)
  const summary = summarizeUsage(data)
  if (!validUsage(summary)) return Promise.resolve(false)
  return enqueue(fileOf(homeDir, 'usage'), { format: FORMAT, savedAt: new Date().toISOString(), cacheKey, windowDays, data: summary })
}

/**
 * 读上次的快照和次数；哪份没有或坏了那份就是 null。只读，坏文件除外（删掉）。
 * @param {string} homeDir
 * @returns {Promise<{snapshot: object|null, usage: object|null}>}
 */
async function readLastView(homeDir) {
  await removeOrphans(lastViewDir(homeDir))
  const [snapshot, usage] = await Promise.all([
    readOne(fileOf(homeDir, 'snapshot'), (value) => typeof value.repoPath === 'string' && value.repoPath.length > 0 && validSnapshot(value.snapshot)),
    readOne(fileOf(homeDir, 'usage'), (value) => typeof value.cacheKey === 'string' && value.cacheKey.length > 0 && validUsage(value.data)),
  ])
  return {
    snapshot: snapshot ? { repoPath: snapshot.repoPath, savedAt: snapshot.savedAt, data: snapshot.snapshot } : null,
    usage: usage ? { cacheKey: usage.cacheKey, windowDays: usage.windowDays, savedAt: usage.savedAt, data: usage.data } : null,
  }
}

module.exports = { lastViewDir, saveLastSnapshot, saveLastUsage, readLastView, summarizeUsage, whenLastViewIdle, MAX_BYTES }
