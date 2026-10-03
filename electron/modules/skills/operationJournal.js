/**
 * 收进记录（操作日志）
 *
 * 负责：
 * - 每次收进一个 JSON 文件：动第一个文件之前就落盘，每一步记「做之前 / 做之后」的样子和进度，
 *   重启后照样读得到（定稿状态清单 C20、C9）
 * - 进程里登记正在进行的操作：记录停在进行中、但进程里没有它（强退、断电）的，就是没做完
 * - 原子写，写到一半断电不会留下半截记录
 *
 * @module electron/modules/skills/operationJournal
 */

const fs = require('fs/promises')
const path = require('path')
const crypto = require('crypto')
const { operationsDir, readJson, writeJsonAtomic } = require('./skillsDataDir')

const active = new Set()
const activeKey = (homeDir, operationId) => `${homeDir}\0${operationId}`

/** 新的操作编号：时间在前，便于按文件名排序 */
function newOperationId() {
  return `op_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}_${crypto.randomUUID().slice(0, 8)}`
}

function opPath(homeDir, operationId) {
  if (!/^op_[0-9a-z_-]+$/i.test(operationId || '')) {
    throw Object.assign(new Error('OPERATION_NOT_FOUND'), { code: 'OPERATION_NOT_FOUND' })
  }
  return path.join(operationsDir(homeDir), `${operationId}.json`)
}

/** 落盘一条记录（新建或更新） */
async function saveOperation(homeDir, op) {
  await writeJsonAtomic(opPath(homeDir, op.operationId), op)
  return op
}

/**
 * 读一条记录
 * @returns {Promise<object>}
 * @throws {Error} OPERATION_NOT_FOUND
 */
async function readOperation(homeDir, operationId) {
  const op = await readJson(opPath(homeDir, operationId), null).catch(() => null)
  if (!op) throw Object.assign(new Error('OPERATION_NOT_FOUND'), { code: 'OPERATION_NOT_FOUND' })
  return op
}

/** 删掉一条记录（没真正动过用户文件的收进不留记录） */
async function deleteOperation(homeDir, operationId) {
  await fs.rm(opPath(homeDir, operationId), { force: true })
}

/**
 * 全部记录，按时间从早到晚；坏掉的文件跳过
 * @param {string} homeDir
 * @returns {Promise<object[]>}
 */
async function listOperations(homeDir) {
  let names = []
  try {
    names = await fs.readdir(operationsDir(homeDir))
  } catch {
    return []
  }
  const ops = []
  for (const name of names.filter((item) => item.endsWith('.json')).sort()) {
    const op = await readJson(path.join(operationsDir(homeDir), name), null).catch(() => null)
    if (op?.operationId) ops.push(op)
  }
  return ops.sort((left, right) => String(left.at).localeCompare(String(right.at)) || left.operationId.localeCompare(right.operationId))
}

function markActive(homeDir, operationId) { active.add(activeKey(homeDir, operationId)) }
function markInactive(homeDir, operationId) { active.delete(activeKey(homeDir, operationId)) }
function isActive(homeDir, operationId) { return active.has(activeKey(homeDir, operationId)) }

/**
 * 记录停在没做完：明确标了 partial，或者停在进行中 / 撤回中但进程里没有它（强退、断电留下的）
 * @returns {boolean}
 */
function isPartial(homeDir, op) {
  if (op.state === 'partial') return true
  return (op.state === 'running' || op.state === 'undoing') && !isActive(homeDir, op.operationId)
}

module.exports = {
  newOperationId,
  saveOperation,
  readOperation,
  deleteOperation,
  listOperations,
  markActive,
  markInactive,
  isActive,
  isPartial,
}
