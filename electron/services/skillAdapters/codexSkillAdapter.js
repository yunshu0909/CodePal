/**
 * Codex Skill adapter
 *
 * 负责：
 * - 扫官方个人目录、兼容目录与受保护的 system 来源（位置、内容摘要、两份检测靠它）
 * - 开关状态以 Codex 官方接口 skills/list 为准；写只经 skills/config/write，参数是 SKILL.md 的绝对路径
 * - 写完再读一次核对：不一致就写回原状态并再核对；写回核对通过报 NOT_EFFECTIVE，否则报 STATE_UNKNOWN
 * - 旧版 CodePal 用文件夹路径写的「关」Codex 不认：打开 Skills 页时按原意补关（先备份，全成功才算，失败恢复）
 * - 没装 Codex / 接口起不来时不再自己改 config.toml 文字，Codex 标为不可用
 * - 写入（含补关的备份与恢复）都在 Codex 配置负责人的同一把锁里，和会话状态等写入串行
 *
 * @module electron/services/skillAdapters/codexSkillAdapter
 */

const fs = require('fs/promises')
const path = require('path')
const {
  scanSkillRoot,
  deployManagedSkill,
  removeToolCopies,
  expandHome,
} = require('../skillControlService')
const { parseToml } = require('../tomlSafeEdit')
const { withConfigLock } = require('../codexConfigOwner')
const { getCodexSkillApi, resolveForCodex } = require('../codexSkillApi')

function codedError(code, cause) {
  return Object.assign(new Error(code, cause ? { cause } : undefined), { code })
}

/**
 * 按 TOML 语义读出 [[skills.config]]（只读，补关时找旧写法用）
 * @param {string} tomlText - config.toml 原文
 * @returns {Array<{path?: string, name?: string, enabled: boolean}>} 缺省 enabled 视为启用
 * @throws {Error} code=CODEX_CONFIG_INVALID 原文不是合法 TOML
 */
function parseSkillConfig(tomlText) {
  const doc = parseToml(tomlText, 'CODEX_CONFIG_INVALID')
  const entries = doc?.skills?.config
  if (!Array.isArray(entries)) return []
  return entries
    .filter((entry) => entry && (typeof entry.path === 'string' || typeof entry.name === 'string'))
    .map((entry) => ({
      ...(typeof entry.path === 'string' ? { path: entry.path } : {}),
      ...(typeof entry.name === 'string' ? { name: entry.name } : {}),
      enabled: entry.enabled !== false,
    }))
}

async function readText(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return ''
    throw error
  }
}

function flattenScan(scan, origin, mutable, extra = {}) {
  return [...scan.skills.values()].map((skill) => ({ ...skill, origin, mutable, ...extra }))
}

const skillMdOf = (skillDir) => path.join(skillDir, 'SKILL.md')

/**
 * 在 skills/list 的结果里找一个 Skill（Codex 报告的是解析软链接后的 SKILL.md 路径）
 * @param {Array} listed
 * @param {string} skillMdPath
 * @returns {object|undefined}
 */
function findListed(listed, skillMdPath) {
  const target = resolveForCodex(skillMdPath)
  return listed.find((skill) => skill.path === target)
}

/**
 * 发现 Codex 独立 Skill；开关以官方接口为准。Plugin 子 Skill 由各工具官方管理，不进 Skill 控制中心。
 * - names 给了就只读这几个名字
 * - skipApi：只为选来源时不调接口（开关状态不需要）
 * - 刚写完的核对已经列过一次（deps.codexListMemo）就直接用，不为刷新再调一次接口
 * 返回里带 listed（接口列出的全部，读不出为 null），给要处理清单的装载状态用。
 */
async function discoverCodexSkills({ homeDir, names = null, skipApi = false }, deps = {}) {
  const officialRoot = path.join(homeDir, '.agents', 'skills')
  const legacyRoot = path.join(homeDir, '.codex', 'skills')
  const systemRoot = path.join(legacyRoot, '.system')
  const [official, legacy, system] = await Promise.all([
    scanSkillRoot(officialRoot, deps, names),
    scanSkillRoot(legacyRoot, deps, names),
    scanSkillRoot(systemRoot, deps, names),
  ])
  const errors = []
  for (const [origin, scan] of [['user', official], ['legacy', legacy], ['system', system]]) {
    if (!scan.available) errors.push({ origin, code: scan.error })
  }
  const sources = [
    ...flattenScan(official, 'user', true),
    ...flattenScan(legacy, 'legacy', true).filter((item) => item.name !== '.system'),
    ...flattenScan(system, 'system', false),
  ]
  if (skipApi) return { toolId: 'codex', sources, errors, pluginSkills: [] }
  let listed = deps.codexListMemo?.take?.() || null
  try {
    if (!listed) listed = await getCodexSkillApi(deps).list({ homeDir })
  } catch (error) {
    // 没装 Codex：整个工具不可用；接口起不来：开关状态读不出
    const code = error?.code === 'CODEX_NOT_FOUND' ? 'CODEX_NOT_FOUND' : 'CODEX_API_FAILED'
    errors.push({ origin: code === 'CODEX_NOT_FOUND' ? 'tool' : 'config', code })
  }
  // 插件带的 Skill 不进列表；只记下「哪个插件带了同名的」，给详情的隶属插件一行用（名字形如 插件:Skill，pluginId 形如 插件@市场）
  const pluginSkills = (listed || [])
    .filter((skill) => skill.pluginId && skill.enabled !== false)
    .map((skill) => ({ name: String(skill.name).split(':').pop(), plugin: String(skill.pluginId).split('@')[0] }))
  if (listed) {
    for (const source of sources) {
      const hit = findListed(listed, skillMdOf(source.absolutePath))
      // Codex 没列出来的（比如同名的旧目录那份被新目录那份盖住）按 Codex 默认视为开着
      source.configEnabled = hit ? hit.enabled : true
    }
  }
  return { toolId: 'codex', sources, errors, pluginSkills, listed }
}

/**
 * 经官方接口把一个 Skill 设成目标状态，并按 Codex 自己的判断核对
 * @param {object} params
 * @param {string} params.homeDir
 * @param {string} params.skillMdPath - SKILL.md 绝对路径
 * @param {boolean} params.enabled
 * @param {object} deps
 * @throws {Error} NOT_EFFECTIVE（没生效、已写回原状态并核对）/ STATE_UNKNOWN（写回不成或读不出）/ 接口本身的错误
 */
async function setAndVerify({ homeDir, skillMdPath, enabled }, deps) {
  const api = getCodexSkillApi(deps)
  // 先读原状态：读不出就不写，什么都没改
  const before = findListed(await api.list({ homeDir }), skillMdPath)
  // Codex 没列出这一份（例如同名两份、Codex 只认另一份）：写了也核对不了，直接失败，什么都不写
  if (!before) throw codedError('NOT_IN_CODEX')
  const previous = before.enabled
  await withConfigLock(() => api.write({ homeDir, skillMdPath, enabled }))
  let after
  try {
    const afterList = await api.list({ homeDir })
    after = findListed(afterList, skillMdPath)
    // 留给写完后的刷新用：刚核对过的这份列表就是最新状态，不再为刷新另调一次接口
    deps.codexListMemo?.set?.(afterList)
  } catch (error) {
    throw codedError('STATE_UNKNOWN', error)
  }
  if (after && after.enabled === enabled) return { enabled }
  // 没生效：写回原状态，写回核对通过才能说「已保留原状态」
  try {
    await withConfigLock(() => api.write({ homeDir, skillMdPath, enabled: previous }))
    const again = findListed(await api.list({ homeDir }), skillMdPath)
    if (again && again.enabled === previous) throw codedError('NOT_EFFECTIVE')
  } catch (error) {
    if (error?.code === 'NOT_EFFECTIVE') throw error
    throw codedError('STATE_UNKNOWN', error)
  }
  throw codedError('STATE_UNKNOWN')
}

async function lstatOrNull(targetPath) {
  try {
    return await fs.lstat(targetPath)
  } catch {
    return null
  }
}

/** 执行 Codex 个人来源写操作。 */
async function applyCodexCommand(params, deps = {}) {
  const officialPath = path.join(params.homeDir, '.agents', 'skills', params.skillName)
  const legacyPath = path.join(params.homeDir, '.codex', 'skills', params.skillName)
  if (params.action === 'enable') {
    // 原来就有的那份不替换；只有这次新部署的，接口失败时撤掉
    const existed = Boolean(await lstatOrNull(officialPath))
    let deployed = { success: true, enabled: true, state: 'synced', mode: 'existing' }
    if (!existed) {
      const deploy = deps.deployFn || deployManagedSkill
      deployed = await deploy({ repoPath: params.repoPath, targetPath: officialPath, skillName: params.skillName }, deps)
    }
    try {
      await setAndVerify({ homeDir: params.homeDir, skillMdPath: skillMdOf(officialPath), enabled: true }, deps)
    } catch (error) {
      if (!existed) await (deps.rmFn || fs.rm)(officialPath, { recursive: true, force: true }).catch(() => {})
      throw error
    }
    return deployed
  }
  if (params.action === 'remove-tool') return removeToolCopies([officialPath, legacyPath], deps)
  if (params.action === 'set-enabled' || params.action === 'disable') {
    const enabled = params.action === 'disable' ? false : Boolean(params.enabled)
    const skillDir = params.source?.absolutePath || officialPath
    await setAndVerify({ homeDir: params.homeDir, skillMdPath: skillMdOf(skillDir), enabled }, deps)
    return { success: true, enabled, state: enabled ? 'synced' : 'disabled' }
  }
  throw codedError('ACTION_NOT_SUPPORTED')
}

/**
 * 补关旧写法：旧版 CodePal 把「关」写成文件夹路径，Codex 不认。
 * 只处理「旧写法关着、Codex 实际开着、没有新写法记录」的；先备份 config.toml，全部写完并核对才算，任何一步失败恢复备份。
 * @param {object} params
 * @param {string} params.homeDir
 * @param {object} deps - codexSkillApi / copyFileFn / nowFn 可注入
 * @returns {Promise<{status: 'none'|'migrated'|'failed', migrated: number, error?: string}>}
 */
async function migrateLegacyCodexDisables({ homeDir }, deps = {}) {
  const configPath = path.join(homeDir, '.codex', 'config.toml')
  let original
  let entries
  try {
    original = await readText(configPath)
    entries = parseSkillConfig(original)
  } catch (error) {
    return { status: 'failed', migrated: 0, error: error?.code || 'READ_FAILED' }
  }
  const legacyOff = entries.filter((entry) => entry.path && entry.enabled === false && path.basename(entry.path) !== 'SKILL.md')
  if (legacyOff.length === 0) return { status: 'none', migrated: 0 }

  const api = getCodexSkillApi(deps)
  let listed
  try {
    listed = await api.list({ homeDir })
  } catch (error) {
    return { status: 'failed', migrated: 0, error: error?.code || 'CODEX_API_FAILED' }
  }
  // 已经有新写法记录（不论开关）的，说明用户后来在 Codex 里动过它，不碰
  const modern = new Set(entries
    .filter((entry) => entry.path && path.basename(entry.path) === 'SKILL.md')
    .map((entry) => resolveForCodex(expandHome(entry.path, homeDir))))
  const todo = legacyOff
    .map((entry) => skillMdOf(expandHome(entry.path, homeDir)))
    .filter((skillMd) => !modern.has(resolveForCodex(skillMd)))
    .filter((skillMd) => findListed(listed, skillMd)?.enabled === true)
  if (todo.length === 0) return { status: 'none', migrated: 0 }

  const stamp = (deps.nowFn ? deps.nowFn() : new Date()).toISOString().replace(/[:.]/g, '-')
  const backupPath = `${configPath}.codepal-legacy-skill-${stamp}.bak`
  // 备份、逐条写、核对、失败恢复都在同一把锁里：中途不会有别的 CodePal 写入插进来
  const outcome = await withConfigLock(async () => {
    try {
      await (deps.copyFileFn || fs.copyFile)(configPath, backupPath)
    } catch {
      return { status: 'failed', migrated: 0, error: 'BACKUP_FAILED' }
    }
    // 恢复后文件和备份逐字相同时，这份备份已没有用处，删掉；否则留着给手动回滚（失败每次打开都会重试，不删会越积越多）
    const restore = async () => {
      try {
        await fs.copyFile(backupPath, configPath)
        const [current, saved] = await Promise.all([readText(configPath), readText(backupPath)])
        if (current === saved) await fs.unlink(backupPath)
      } catch {
        // 恢复失败时备份原样留着
      }
    }
    try {
      for (const skillMdPath of todo) await api.write({ homeDir, skillMdPath, enabled: false })
      const after = await api.list({ homeDir })
      if (todo.some((skillMd) => findListed(after, skillMd)?.enabled !== false)) {
        await restore()
        return { status: 'failed', migrated: 0, error: 'NOT_EFFECTIVE' }
      }
    } catch (error) {
      await restore()
      return { status: 'failed', migrated: 0, error: error?.code || 'CODEX_API_FAILED' }
    }
    return null
  })
  if (outcome) return outcome
  return { status: 'migrated', migrated: todo.length, backupPath }
}

module.exports = { parseSkillConfig, discoverCodexSkills, applyCodexCommand, migrateLegacyCodexDisables }
