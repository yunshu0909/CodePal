/**
 * 忽略记录
 *
 * 负责：
 * - 按「工具 + 项目路径 + 位置」记住一份（键就是工具与这一份的完整路径），以后不再出现在要处理里；
 *   资产库删掉同名不会让它冒回来；项目改名或搬家按新路径算新来源，以前的忽略不带过去（定稿状态清单 A12）
 * - 只是不再提示：不动文件、不动开关
 * - 读不写：没有记录文件时返回空，不建目录
 *
 * @module electron/modules/skills/ignoreStore
 */

const crypto = require('crypto')
const { ignoresFile, readJson, writeJsonAtomic } = require('./skillsDataDir')

/**
 * 一份的忽略身份
 * @param {string} toolId
 * @param {string} absolutePath
 * @returns {string}
 */
function ignoreIdOf(toolId, absolutePath) {
  return `ign_${crypto.createHash('sha256').update(`${toolId}\0${absolutePath}`).digest('hex').slice(0, 16)}`
}

/**
 * @param {string} homeDir
 * @returns {Promise<Array<object>>} 忽略记录；文件坏了当成没有（不挡读取）
 */
async function readIgnores(homeDir) {
  try {
    const data = await readJson(ignoresFile(homeDir), { entries: [] })
    return Array.isArray(data?.entries) ? data.entries : []
  } catch {
    return []
  }
}

// 同一个记录文件的读改写排队做：不同名字同时忽略 / 取消忽略也不会互相覆盖
const queues = new Map()
function serialize(file, task) {
  const previous = queues.get(file) || Promise.resolve()
  const run = previous.then(task, task)
  queues.set(file, run.catch(() => {}))
  return run
}

/**
 * 记住一份
 * @param {string} homeDir
 * @param {{name: string, toolId: string, scope: string, projectName: string|null, projectPath: string|null, absolutePath: string, displayPath: string}} copy
 * @returns {Promise<object>} 记下的那条
 */
async function addIgnore(homeDir, copy) {
  return serialize(ignoresFile(homeDir), () => writeIgnore(homeDir, copy))
}

async function writeIgnore(homeDir, copy) {
  const entries = await readIgnores(homeDir)
  const ignoreId = ignoreIdOf(copy.toolId, copy.absolutePath)
  const entry = {
    ignoreId,
    name: copy.name,
    toolId: copy.toolId,
    scope: copy.scope,
    projectName: copy.projectName || null,
    projectPath: copy.projectPath || null,
    absolutePath: copy.absolutePath,
    displayPath: copy.displayPath,
    at: new Date().toISOString(),
  }
  const next = [...entries.filter((item) => item.ignoreId !== ignoreId), entry]
  await writeJsonAtomic(ignoresFile(homeDir), { schemaVersion: 1, entries: next })
  return entry
}

/**
 * 删掉一条
 * @param {string} homeDir
 * @param {string} ignoreId
 * @returns {Promise<object|null>} 删掉的那条；没有时为 null
 */
async function removeIgnore(homeDir, ignoreId) {
  return serialize(ignoresFile(homeDir), () => dropIgnore(homeDir, ignoreId))
}

async function dropIgnore(homeDir, ignoreId) {
  const entries = await readIgnores(homeDir)
  const found = entries.find((item) => item.ignoreId === ignoreId) || null
  if (!found) return null
  await writeJsonAtomic(ignoresFile(homeDir), { schemaVersion: 1, entries: entries.filter((item) => item.ignoreId !== ignoreId) })
  return found
}

/** 这一份是否被忽略 */
function isIgnored(ignores, toolId, absolutePath) {
  return ignores.some((item) => item.toolId === toolId && item.absolutePath === absolutePath)
}

module.exports = { ignoreIdOf, readIgnores, addIgnore, removeIgnore, isIgnored }
