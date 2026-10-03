/**
 * Skills 要处理的数据目录
 *
 * 负责：
 * - 备份、忽略记录、收进记录都放在 CodePal 自己的数据目录 ~/Library/Application Support/CodePal/skills/，
 *   不在任何 Skill 扫描范围里（定稿状态清单 C10）
 * - 只给路径，不建目录：读快照不写任何东西，第一次真正写入时才由写入方建
 * - 原子写 JSON：先写临时文件再改名，写到一半断电不会留下半截文件
 *
 * @module electron/modules/skills/skillsDataDir
 */

const fs = require('fs/promises')
const path = require('path')
const crypto = require('crypto')

/**
 * @param {string} homeDir
 * @returns {string} 数据目录
 */
function skillsDataDir(homeDir) {
  return path.join(homeDir, 'Library', 'Application Support', 'CodePal', 'skills')
}

/** 收进记录目录：每次收进一个 <operationId>.json */
function operationsDir(homeDir) {
  return path.join(skillsDataDir(homeDir), 'ops')
}

/** 一次收进的备份目录 */
function backupDir(homeDir, operationId) {
  return path.join(skillsDataDir(homeDir), 'backups', operationId)
}

/** 忽略记录文件 */
function ignoresFile(homeDir) {
  return path.join(skillsDataDir(homeDir), 'ignores.json')
}

/**
 * 原子写一个 JSON 文件（父目录不存在就建，权限只给自己）
 * @param {string} filePath
 * @param {object} value
 * @returns {Promise<void>}
 */
async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const temp = `${filePath}.${crypto.randomUUID()}.tmp`
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await fs.rename(temp, filePath)
}

/**
 * 读一个 JSON 文件；不存在返回 fallback，坏了抛错（调用方决定怎么办）
 * @param {string} filePath
 * @param {any} fallback
 * @returns {Promise<any>}
 */
async function readJson(filePath, fallback) {
  let text
  try {
    text = await fs.readFile(filePath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    throw error
  }
  return JSON.parse(text)
}

module.exports = { skillsDataDir, operationsDir, backupDir, ignoresFile, writeJsonAtomic, readJson }
