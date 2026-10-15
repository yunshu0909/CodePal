/**
 * 插件管理 · 开关写入（后-05、后-09〜后-14、后-24、后-25）
 *
 * - Claude Code：只经现有 Claude 设置唯一写入口（mutateClaudeSettingsFile：排队、备份、原子写、回读）
 *   把 enabledPlugins["dev-workflow@skills-dir"] 写成 true / false，其余内容不动
 * - Codex：只经 Codex 配置负责人（同一把锁、复验、原子写）改 dev-workflow 插件节里 enabled 这一行
 * - 写前在写入口的队列里重新核对目标身份（插件目录实际指向、manifest name、插件节与来源、管理设置），
 *   变了就不写，报「别处改过」；文件里已是目标值直接算成功、不写
 * - 提交点之前失败 = 没改成，文件保持原样；提交点之后回读读不出或对不上 = 没确认，不撤回、不重写
 * - 同一边同时只有一次保存：保存中再点共用同一次写入（只写一次），saving() 供重新进入页面时查询在途
 *
 * @module electron/modules/devPlugin/toggle
 */

const fs = require('fs/promises')
const path = require('path')
const claudeSettings = require('../../services/claudeSettingsService')
const codexOwner = require('../../services/codexConfigOwner')
const { setTableBoolean, parseToml } = require('../../services/tomlSafeEdit')
const { readClaudeSide, readCodexSide, claudeRootMoved, CLAUDE_KEY, SETTINGS_LABEL, CONFIG_LABEL } = require('./state')

const TOOLS = ['claude', 'codex']
const CHANGED = '插件状态刚被别处改过，已重新读取'
const LOCKED = '没改成：这一项被系统管理设置锁定'
const failedText = (label) => `没改成：${label} 写不进去`
const uncertainText = (label) => `保存结果没确认：${label}，重新打开这页看实际状态`

const saved = (enabled) => ({ ok: true, status: 'saved', enabled })
const failed = (label) => ({ ok: false, status: 'failed', message: failedText(label) })
const changed = () => ({ ok: false, status: 'changed', message: CHANGED })
const uncertain = (label) => ({ ok: false, status: 'uncertain', message: uncertainText(label) })

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 读取时记下的身份和现在的是否同一个插件（后-24） */
function sameIdentity(expected, actual) {
  if (!expected || !actual) return false
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)])
  return [...keys].every((key) => expected[key] === actual[key]) && actual.name === 'dev-workflow'
}

/**
 * @param {object} options
 * @param {string} options.homeDir - 可信家目录
 * @param {Record<string, string|undefined>} [options.env]
 * @param {string[]|null} [options.managedPaths] - 系统管理设置路径；缺省走平台默认
 * @param {object} [options.deps] - 仅测试用：mutateClaudeSettingsFile / onClaudeMutate / codexCommitDeps / readFile
 * @returns {{setEnabled: (request: {tool: string, enabled: boolean, identity: object}) => Promise<object>, saving: () => {claude: boolean, codex: boolean}}}
 */
function createDevPluginToggle({ homeDir, env = process.env, managedPaths = null, deps = {} }) {
  const settingsPath = path.join(homeDir, '.claude/settings.json')
  const configPath = path.join(homeDir, '.codex/config.toml')
  const mutate = deps.mutateClaudeSettingsFile || claudeSettings.mutateClaudeSettingsFile
  const inflight = { claude: null, codex: null }

  /** Claude Code：复验和改值都写在写入口的 mutator 里，读、判断、写是同一个排队任务 */
  async function saveClaude(enabled, identity) {
    if (await claudeRootMoved(homeDir, env)) return changed()
    let refusal = null
    const refuse = (kind) => {
      refusal = kind
      return { ok: false, errorCode: 'DEV_PLUGIN_REFUSED' }
    }
    const result = await mutate(async ({ data, kind, managedUnknown, isManagedField }) => {
      if (deps.onClaudeMutate) await deps.onClaudeMutate()
      // 管理设置读不出时不写（B-002）；重读会把整页落到读取失败并写明原因
      if (managedUnknown) return refuse('changed')
      if (isManagedField(`enabledPlugins.${CLAUDE_KEY}`)) return refuse('locked')
      let now
      try {
        now = await readClaudeSide({ homeDir, env, managedPaths })
      } catch {
        return refuse('changed')
      }
      if (!now.installed || !sameIdentity(identity && identity.claude, now.identity)) return refuse('changed')
      if (kind === 'corrupt') return refuse('changed')
      const plugins = data.enabledPlugins
      if (plugins !== undefined && !isPlainObject(plugins)) return refuse('changed')
      const current = plugins === undefined ? undefined : plugins[CLAUDE_KEY]
      if (current !== undefined && typeof current !== 'boolean') return refuse('changed')
      // 没写算开：要开时不预先写入默认值（后-20）
      if ((current === undefined ? true : current) === enabled) return { ok: true, noop: true }
      return { ok: true, next: { ...data, enabledPlugins: { ...(plugins || {}), [CLAUDE_KEY]: enabled } }, create: kind === 'missing' }
    }, { filePath: settingsPath, managedPaths, backupSuffix: 'dev-plugin' })

    if (refusal === 'locked') return { ok: false, status: 'locked', message: LOCKED }
    if (refusal === 'changed') return changed()
    if (result.success) return saved(enabled)
    if (result.committed) return uncertain(SETTINGS_LABEL)
    if (result.errorCode === 'SETTINGS_CONFLICT' || result.errorCode === 'SETTINGS_ALREADY_EXISTS') return changed()
    return failed(SETTINGS_LABEL)
  }

  /** Codex：复验、改那一行、提交、回读都在 Codex 配置负责人的同一把锁里 */
  function saveCodex(enabled, identity) {
    return codexOwner.withConfigLock(async () => {
      let now
      try {
        now = await readCodexSide({ homeDir })
      } catch {
        return changed()
      }
      if (!now.installed || !sameIdentity(identity && identity.codex, now.identity)) return changed()
      if (now.enabled === enabled) return saved(enabled)
      const key = now.identity.key

      let committed
      try {
        committed = await codexOwner.commitConfigUnlocked(configPath, (text) => {
          // 提交前拍照拿到的原文里这一节必须还在，否则 setTableBoolean 会在文末新建一节
          const doc = parseToml(text, 'CODEX_CONFIG_CONFLICT')
          if (!isPlainObject(doc.plugins) || !isPlainObject(doc.plugins[key])) {
            throw Object.assign(new Error('CODEX_CONFIG_CONFLICT'), { code: 'CODEX_CONFIG_CONFLICT' })
          }
          return setTableBoolean(text, { tablePath: ['plugins', key], field: 'enabled', value: enabled })
        }, deps.codexCommitDeps || {})
      } catch (error) {
        if (error && error.code === 'CODEX_CONFIG_CONFLICT') return changed()
        return failed(CONFIG_LABEL)
      }
      if (!committed.changed) return saved(enabled)

      // 提交点之后：收备份、回读任何一步出错或对不上都只报没确认，不撤回别人的内容、不自动重写（后-25）
      try {
        await codexOwner.finalizeBackup(committed)
        const readback = await (deps.readFile || fs.readFile)(committed.before.target, 'utf8')
        return readback === committed.text ? saved(enabled) : uncertain(CONFIG_LABEL)
      } catch {
        return uncertain(CONFIG_LABEL)
      }
    })
  }

  /**
   * 打开或关闭一边；同一边保存中再调用，共用正在进行的那一次
   * @param {{tool: 'claude'|'codex', enabled: boolean, identity: object}} request - identity 来自最近一次读取
   * @returns {Promise<{ok: boolean, status: 'saved'|'failed'|'locked'|'changed'|'uncertain', enabled?: boolean, message?: string}>}
   */
  function setEnabled({ tool, enabled, identity } = {}) {
    if (!TOOLS.includes(tool) || typeof enabled !== 'boolean') {
      return Promise.resolve({ ok: false, status: 'failed', message: '没改成：不认识要改的工具' })
    }
    if (inflight[tool]) return inflight[tool]
    // 走到这里的异常说不清文件有没有被改（Codex 提交点之前的失败在 saveCodex 里已按没改成返回），只报没确认
    const run = (tool === 'claude' ? saveClaude(enabled, identity) : saveCodex(enabled, identity))
      .catch(() => uncertain(tool === 'claude' ? SETTINGS_LABEL : CONFIG_LABEL))
    inflight[tool] = run.finally(() => { inflight[tool] = null })
    return inflight[tool]
  }

  /** 两边各自是否有保存在途 */
  function saving() {
    return { claude: inflight.claude !== null, codex: inflight.codex !== null }
  }

  return { setEnabled, saving }
}

module.exports = { createDevPluginToggle }
