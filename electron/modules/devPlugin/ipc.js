/**
 * 插件管理 · 主进程接口（devPlugin:*）
 *
 * - devPlugin:read，入参可选 { tool }：不给读两边（进入页面 / 重试），给了只为这一行重读（别处改过、没确认、等在途保存）
  → { versionText, claude, codex, saving }；读取失败 error.message 是整页「读取失败」下的原因
 * - devPlugin:setEnabled，入参只认 { tool: 'claude' | 'codex', enabled: boolean }，其余字段（含任何路径）一律忽略（后-04）
 *   → 成功 data: { status: 'saved', enabled }；失败 error: { code: failed | locked | changed | uncertain, message }
 * - 写前复验用的目标身份留在主进程，不发给页面；每边只由「读了这一边」的读取更新（只重读一行时不动另一行的身份，
  页面上另一行显示的仍是更早那次读取），同一边晚到的旧读取不覆盖新的
 *
 * @module electron/modules/devPlugin/ipc
 */

const os = require('os')
const { readDevPluginState } = require('./state')
const { createDevPluginToggle } = require('./toggle')

const ok = (data) => ({ success: true, data, error: null })
const bad = (code, message) => ({ success: false, data: null, error: { code, message } })

/**
 * @param {object} options
 * @param {import('electron').IpcMain} options.ipcMain
 * @param {string} [options.homeDir] - 可信家目录；测试注入
 * @param {Record<string, string|undefined>} [options.env]
 * @param {string[]|null} [options.managedPaths] - 系统管理设置路径；测试注入，缺省走平台默认
 */
function registerDevPluginHandlers({ ipcMain, homeDir = os.homedir(), env = process.env, managedPaths = null }) {
  const toggle = createDevPluginToggle({ homeDir, env, managedPaths })
  const identity = { claude: null, codex: null }
  const known = { claude: false, codex: false }
  // 每边的读取代次：开始读时取号，读完只有号不小于已采用的才更新这一边
  let readSeq = 0
  const applied = { claude: 0, codex: 0 }

  /** @param {Array<'claude'|'codex'>} tools - 这次读取要更新身份的边 */
  async function read(tools) {
    const seq = ++readSeq
    const result = await readDevPluginState({ homeDir, env, managedPaths })
    if (!result.ok) return result
    for (const tool of tools) {
      if (seq < applied[tool]) continue
      applied[tool] = seq
      identity[tool] = result.data.identity[tool]
      known[tool] = true
    }
    return result
  }

  ipcMain.handle('devPlugin:read', async (_event, payload) => {
    const tool = payload && payload.tool
    const result = await read(tool === 'claude' || tool === 'codex' ? [tool] : ['claude', 'codex'])
    if (!result.ok) return bad(result.error.code, result.error.message)
    const { versionText, claude, codex } = result.data
    return ok({ versionText, claude, codex, saving: toggle.saving() })
  })

  ipcMain.handle('devPlugin:setEnabled', async (_event, payload) => {
    const tool = payload && payload.tool
    const enabled = payload && payload.enabled
    if ((tool !== 'claude' && tool !== 'codex') || typeof enabled !== 'boolean') {
      return bad('invalid_input', '没改成：不认识要改的工具')
    }
    // 页面总是先读再点；主进程还没读过这一边（不该发生）就不写，让页面重读
    if (!known[tool]) return bad('changed', '插件状态刚被别处改过，已重新读取')
    const result = await toggle.setEnabled({ tool, enabled, identity: { [tool]: identity[tool] } })
    if (result.ok) return ok({ status: result.status, enabled: result.enabled })
    return bad(result.status, result.message)
  })

  return { toggle }
}

module.exports = { registerDevPluginHandlers }
