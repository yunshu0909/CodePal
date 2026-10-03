/**
 * 占位保护：工具的全局位置有没有被一份不是资产库链接的占着
 *
 * 负责：
 * - 每个工具的全局位置：Claude 是 ~/.claude/skills/<名>，Codex 是 ~/.agents/skills/<名>（链接都建在这里）
 *   和兼容目录 ~/.codex/skills/<名>
 * - 已核实指向资产库的链接不算占着；真文件夹、指向别处的链接都算（定稿状态清单 C13）
 * - 写入前的检查：占着时启用这个工具、从项目收进到这个工具都拒绝（SLOT_OCCUPIED），什么都不动
 * 只读文件系统的元信息（lstat / realpath），不读文件内容。
 *
 * @module electron/modules/skills/slotGuard
 */

const fs = require('fs/promises')
const path = require('path')

/**
 * 一个工具放这个名字的全局位置；第一个是链接要建的位置
 * @param {string} homeDir
 * @param {'claude-code'|'codex'} toolId
 * @param {string} name
 * @returns {string[]}
 */
function slotPaths(homeDir, toolId, name) {
  if (toolId === 'claude-code') return [path.join(homeDir, '.claude', 'skills', name)]
  return [path.join(homeDir, '.agents', 'skills', name), path.join(homeDir, '.codex', 'skills', name)]
}

async function realpathOrNull(target) {
  try { return await fs.realpath(target) } catch { return null }
}

/**
 * 这个位置是不是已核实指向资产库那份的链接
 * @param {string} slotPath
 * @param {string} libraryPath - 资产库里这个名字的目录
 * @returns {Promise<boolean>}
 */
async function isLibraryLink(slotPath, libraryPath) {
  let stat
  try { stat = await fs.lstat(slotPath) } catch { return false }
  if (!stat.isSymbolicLink()) return false
  const [real, libraryReal] = await Promise.all([realpathOrNull(slotPath), realpathOrNull(libraryPath)])
  return Boolean(real && libraryReal && real === libraryReal)
}

/**
 * 这个工具的全局位置被谁占着（不是资产库链接的第一个位置）
 * @param {object} params
 * @param {string} params.homeDir
 * @param {string} params.toolId
 * @param {string} params.name
 * @param {string} params.libraryPath
 * @param {string} [params.except] - 不算占着的那个位置（要收进的就是它自己）
 * @returns {Promise<string|null>} 占着的位置；没被占时为 null
 */
async function occupiedSlot({ homeDir, toolId, name, libraryPath, except }) {
  for (const slot of slotPaths(homeDir, toolId, name)) {
    if (except && slot === except) continue
    let exists = true
    try { await fs.lstat(slot) } catch { exists = false }
    if (!exists) continue
    if (await isLibraryLink(slot, libraryPath)) continue
    return slot
  }
  return null
}

/**
 * 写入前检查：被占着就拒绝
 * @throws {Error} code=SLOT_OCCUPIED，带 toolId
 */
async function assertSlotFree(params) {
  const slot = await occupiedSlot(params)
  if (slot) throw Object.assign(new Error('SLOT_OCCUPIED'), { code: 'SLOT_OCCUPIED', toolId: params.toolId, outcome: 'not-run' })
}

module.exports = { slotPaths, isLibraryLink, occupiedSlot, assertSlotFree }
