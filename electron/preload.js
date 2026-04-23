/**
 * 预加载脚本
 *
 * 负责：
 * - 通过 contextBridge 向渲染进程暴露安全的 API
 * - 封装 IPC 通信接口
 * - 提供文件系统操作和配置管理的方法
 *
 * @module electron/preload
 */

const { contextBridge, ipcRenderer } = require('electron')

/**
 * Electron API 对象
 * 通过 contextBridge 暴露给渲染进程使用
 */
contextBridge.exposeInMainWorld('electronAPI', {
  // Legacy store APIs (for backward compatibility)

  /**
   * 获取存储值（兼容旧版本）
   * @param {string} key - 存储键名
   * @returns {Promise<any>} 存储的值
   */
  getStore: (key) => ipcRenderer.invoke('get-store', key),

  /**
   * 设置存储值（兼容旧版本）
   * @param {string} key - 存储键名
   * @param {any} value - 要存储的值
   * @returns {Promise<boolean>} 是否成功
   */
  setStore: (key, value) => ipcRenderer.invoke('set-store', key, value),

  /**
   * 删除存储值（兼容旧版本）
   * @param {string} key - 存储键名
   * @returns {Promise<boolean>} 是否成功
   */
  deleteStore: (key) => ipcRenderer.invoke('delete-store', key),

  // File system APIs (V0.2)

  /**
   * 扫描工具目录获取技能列表
   * @param {string} toolPath - 工具目录路径
   * @returns {Promise<{success: boolean, skills: Array, error: string|null}>} 扫描结果
   */
  scanToolDirectory: (toolPath) => ipcRenderer.invoke('scan-tool-directory', toolPath),

  /**
   * 读取技能信息（从 SKILL.md）
   * @param {string} skillPath - 技能文件夹路径
   * @returns {Promise<{success: boolean, name: string, desc: string, error: string|null}>} 技能信息
   */
  readSkillInfo: (skillPath) => ipcRenderer.invoke('read-skill-info', skillPath),

  /**
   * 复制技能文件夹（用于导入和推送）
   * @param {string} sourcePath - 源路径
   * @param {string} targetPath - 目标路径
   * @param {Object} options - 复制选项
   * @returns {Promise<{success: boolean, error: string|null}>} 复制结果
   */
  copySkill: (sourcePath, targetPath, options) => ipcRenderer.invoke('copy-skill', sourcePath, targetPath, options),

  /**
   * 删除技能文件夹（用于取消推送）
   * @param {string} skillPath - 要删除的技能路径
   * @returns {Promise<{success: boolean, error: string|null}>} 删除结果
   */
  deleteSkill: (skillPath) => ipcRenderer.invoke('delete-skill', skillPath),

  /**
   * 确保目录存在（不存在则创建）
   * @param {string} dirPath - 目录路径
   * @returns {Promise<{success: boolean, error: string|null}>} 操作结果
   */
  ensureDir: (dirPath) => ipcRenderer.invoke('ensure-dir', dirPath),

  /**
   * 检查路径是否存在
   * @param {string} checkPath - 要检查的路径
   * @returns {Promise<{success: boolean, exists: boolean, error: string|null}>} 检查结果
   */
  pathExists: (checkPath) => ipcRenderer.invoke('path-exists', checkPath),

  /**
   * 读取配置文件（.config.json）
   * @param {string} configPath - 配置文件路径
   * @returns {Promise<{success: boolean, data: Object, error: string|null}>} 配置数据
   */
  readConfig: (configPath) => ipcRenderer.invoke('read-config', configPath),

  /**
   * 写入配置文件（.config.json）
   * @param {string} configPath - 配置文件路径
   * @param {Object} data - 要写入的配置数据
   * @returns {Promise<{success: boolean, error: string|null}>} 写入结果
   */
  writeConfig: (configPath, data) => ipcRenderer.invoke('write-config', configPath, data),

  // V0.3 Import page APIs

  /**
   * 打开文件夹选择对话框
   * @returns {Promise<{success: boolean, path: string, canceled: boolean, error: string|null}>} 选择结果
   */
  selectFolder: () => ipcRenderer.invoke('select-folder'),

  /**
   * 扫描预设工具的 skills
   * 返回4个固定工具（Claude Code、CodeX、Cursor、Trae）的技能数量
   * @returns {Promise<{success: boolean, tools: Array, error: string|null}>} 扫描结果
   */
  scanPresetTools: () => ipcRenderer.invoke('scan-preset-tools'),

  /**
   * 扫描自定义路径下的 skills 分布
   * 扫描 .claude/skills/、.codex/skills/、.cursor/skills/、.trae/skills/ 子目录
   * @param {string} customPath - 自定义路径
   * @returns {Promise<{success: boolean, skills: Object, error: string|null}>} 扫描结果
   * skills 格式: { claude: 5, codex: 3, ... }
   */
  scanCustomPath: (customPath) => ipcRenderer.invoke('scan-custom-path', customPath),

  /**
   * 检查路径是否已存在于自定义路径列表中
   * @param {string} checkPath - 要检查的路径
   * @param {string[]} existingPaths - 现有路径列表
   * @returns {Promise<{success: boolean, exists: boolean, error: string|null}>} 检查结果
   */
  checkPathExists: (checkPath, existingPaths) => ipcRenderer.invoke('check-path-exists', checkPath, existingPaths),

  /**
   * 更改中央仓库位置
   * @param {string} newPath - 新仓库路径
   * @param {string} currentPath - 当前仓库路径（用于数据迁移）
   * @returns {Promise<{success: boolean, path: string, error: string|null}>} 更改结果
   */
  changeRepoPath: (newPath, currentPath) => ipcRenderer.invoke('change-repo-path', newPath, currentPath),

  /**
   * 执行导入操作
   * 将选中的来源 skills 去重合并到中央仓库
   * @param {Object} params - 导入参数
   * @param {string[]} params.presetTools - 选中的预设工具ID列表
   * @param {Array<{path: string, skills: Object}>} params.customPaths - 选中的自定义路径列表
   * @param {string} params.repoPath - 中央仓库路径
   * @returns {Promise<{success: boolean, importedCount: number, errors: Array, error: string|null}>} 导入结果
   */
  importSkills: (params) => ipcRenderer.invoke('import-skills', params),

  // V0.4 Manage page APIs

  /**
   * 获取中央仓库所有技能
   * 扫描中央仓库目录，返回所有包含 SKILL.md 的技能文件夹
   * @param {string} repoPath - 中央仓库路径
   * @returns {Promise<{success: boolean, skills: Array, error: string|null}>} 技能列表
   */
  getCentralSkills: (repoPath) => ipcRenderer.invoke('get-central-skills', repoPath),

  /**
   * 获取工具的推送状态
   * 检查每个工具目录中是否存在指定的技能
   * @param {string[]} skillNames - 技能名称列表
   * @returns {Promise<{success: boolean, status: Object, error: string|null}>} 推送状态
   */
  getToolStatus: (skillNames) => ipcRenderer.invoke('get-tool-status', skillNames),

  /**
   * 推送技能到工具
   * 将中央仓库中的技能复制到指定工具的 skills 目录
   * @param {Object} params - 推送参数
   * @param {string} params.repoPath - 中央仓库路径
   * @param {string[]} params.skillNames - 要推送的技能名称列表
   * @param {string[]} params.toolIds - 目标工具 ID 列表
   * @returns {Promise<{success: boolean, results: Array, error: string|null}>} 推送结果
   */
  pushSkills: (params) => ipcRenderer.invoke('push-skills', params),

  /**
   * 停用技能（从工具目录删除）
   * 从指定工具的 skills 目录中删除技能
   * @param {Object} params - 停用参数
   * @param {string[]} params.skillNames - 要停用的技能名称列表
   * @param {string[]} params.toolIds - 目标工具 ID 列表
   * @returns {Promise<{success: boolean, results: Array, error: string|null}>} 停用结果
   */
  unpushSkills: (params) => ipcRenderer.invoke('unpush-skills', params),

  /**
   * 增量导入 - 仅新增不覆盖
   * 从自定义路径扫描技能，仅导入中央仓库中不存在的技能
   * @param {Object} params - 导入参数
   * @param {string[]} params.customPathIds - 自定义路径 ID 列表
   * @param {string} params.repoPath - 中央仓库路径
   * @returns {Promise<{success: boolean, added: number, skipped: number, errors: string[]}>} 导入结果
   */
  incrementalImport: (params) => ipcRenderer.invoke('incremental-import', params),

  // V0.6 Usage monitoring APIs

  /**
   * 扫描日志文件
   * 扫描指定目录下的 .jsonl 日志文件
   * @param {Object} params - 扫描参数
   * @param {string} params.basePath - 基础目录路径
   * @param {string} params.pattern - 文件匹配模式
   * @param {string} params.start - 开始时间（ISO 字符串）
   * @param {string} params.end - 结束时间（ISO 字符串）
   * @returns {Promise<{success: boolean, files: Array, error: string|null}>} 扫描结果
   */
  scanLogFiles: (params) => ipcRenderer.invoke('scan-log-files', params),

  /**
   * 聚合自定义日期范围用量
   * @param {Object} params - 聚合参数
   * @param {string} [params.taskId] - 前端任务 ID，用于关联进度事件
   * @param {string} params.startDate - 开始日期（YYYY-MM-DD）
   * @param {string} params.endDate - 结束日期（YYYY-MM-DD）
   * @param {string} params.timezone - 时区（当前仅支持 Asia/Shanghai）
   * @returns {Promise<{success: boolean, data?: object, meta?: {fromDailySummaryDays: number, cachedDays: number, recomputedDays: number, totalDays: number, failedDays: number}, error?: string}>}
   */
  aggregateUsageRange: (params) => ipcRenderer.invoke('aggregate-usage-range', params),

  /**
   * 聚合预设周期用量
   * @param {Object} params - 聚合参数
   * @param {string} [params.taskId] - 前端任务 ID，用于关联进度事件
   * @param {'today'|'week'|'month'|'allTime'} params.period - 预设周期
   * @param {string} params.timezone - 时区（当前仅支持 Asia/Shanghai）
   * @returns {Promise<{success: boolean, data?: object, meta?: object, error?: string}>}
   */
  aggregateUsagePeriod: (params) => ipcRenderer.invoke('aggregate-usage-period', params),

  // V0.7 API 配置 - 供应商切换

  /**
   * 获取当前 Claude 供应商配置
   * @returns {Promise<{success: boolean, current: string, profile: Object|null, error: string|null}>}
   * current: providerId | 'custom'
   */
  getClaudeProvider: () => ipcRenderer.invoke('get-claude-provider'),

  /**
   * 获取可用供应商列表（内置 + 自定义）
   * 示例调用：
   * const result = await window.electronAPI.listProviderDefinitions()
   *
   * 示例返回（成功）：
   * {
   *   success: true,
   *   providers: [
   *     {
   *       id: 'official',
   *       name: 'Claude Official',
   *       url: 'https://www.anthropic.com/claude-code',
   *       uiUrl: 'https://www.anthropic.com/claude-code',
   *       baseUrl: '',
   *       tokenEnvKey: null,
   *       baseUrlEnvKey: null,
   *       model: 'opus',
   *       settingsEnv: {},
   *       icon: 'A',
   *       color: '#6b5ce7',
   *       supportsToken: false,
   *       source: 'builtin'
   *     }
   *   ],
   *   registryPath: '/path/to/.provider-manifests.json',
   *   error: null,
   *   errorCode: null
   * }
   *
   * @returns {Promise<{success: boolean, providers: Array<{id: string, name: string, url: string, uiUrl: string, baseUrl: string, tokenEnvKey: string|null, baseUrlEnvKey: string|null, model: string, settingsEnv: Record<string, string>, icon: string, color: string, supportsToken: boolean, source: string}>, registryPath: string, error: string|null, errorCode: string|null}>}
   */
  listProviderDefinitions: () => ipcRenderer.invoke('list-provider-definitions'),

  /**
   * 注册供应商 manifest（MCP 形状，本地入口）
   * 示例调用：
   * await window.electronAPI.registerProviderManifest({
   *   id: 'neo-proxy',
   *   name: 'NeoProxy Gateway',
   *   baseUrl: 'https://api.neoproxy.dev/anthropic',
   *   tokenEnvKey: 'NEO_PROXY_API_KEY',
   *   model: 'opus',
   *   settingsEnv: { ANTHROPIC_MODEL: 'neoproxy-opus' },
   *   icon: 'N',
   *   color: '#2563eb'
   * })
   *
   * 示例返回（失败）：
   * {
   *   success: false,
   *   provider: null,
   *   error: 'settingsEnv key 不在白名单内: OPENAI_API_KEY',
   *   errorCode: 'UNSAFE_SETTINGS_ENV_KEY'
   * }
   *
   * @param {{id: string, name: string, baseUrl: string, tokenEnvKey: string, baseUrlEnvKey?: string, model?: string, settingsEnv?: Record<string, string>, icon?: string, color?: string, uiUrl?: string}} manifest - 渠道定义
   * @returns {Promise<{success: boolean, provider: Object|null, registryPath: string, error: string|null, errorCode: string|null}>}
   */
  registerProviderManifest: (manifest) => ipcRenderer.invoke('register-provider-manifest', manifest),

  /**
   * 读取供应商 API Key 的环境变量配置
   * @returns {Promise<{success: boolean, providers: Record<string, {token: string}>, envPath: string, error: string|null, errorCode: string|null}>}
   */
  getProviderEnvConfig: () => ipcRenderer.invoke('get-provider-env-config'),

  /**
   * 保存供应商 API Key 到 .env
   * @param {string} providerKey - 供应商 key（动态 providerId）
   * @param {string} token - API Key
   * @returns {Promise<{success: boolean, envPath: string, error: string|null, errorCode: string|null}>}
   */
  saveProviderToken: (providerKey, token) => ipcRenderer.invoke('save-provider-token', providerKey, token),

  /**
   * 切换 Claude 供应商
   * @param {string} profileKey - 目标档位（动态 providerId）
   * @returns {Promise<{success: boolean, backupPath: string|null, error: string|null}>}
   */
  switchClaudeProvider: (profileKey) => ipcRenderer.invoke('switch-claude-provider', profileKey),

  // V0.9 项目初始化 APIs

  /**
   * 新建项目创建前校验
   * @param {Object} params - 校验参数
   * @param {string} params.projectName - 项目名称
   * @param {string} params.targetPath - 目标路径
   * @param {'root'|'code'|'none'} [params.gitMode] - Git 模式
   * @param {string[]|Object} [params.templates] - 模板选择
   * @param {boolean} [params.overwrite] - 是否覆盖已有文件
   * @returns {Promise<{success: boolean, valid: boolean, error: string|null, data: Object}>}
   */
  validateProjectInit: (params) => ipcRenderer.invoke('project-init-validate', params),

  /**
   * 执行新建项目初始化
   * @param {Object} params - 执行参数（与 validateProjectInit 相同）
   * @returns {Promise<{success: boolean, error: string|null, data: Object}>}
   */
  executeProjectInit: (params) => ipcRenderer.invoke('project-init-execute', params),

  /**
   * 检测 Git 是否可用
   * @returns {Promise<{success: boolean, data: {available: boolean, version: string|null}}>}
   */
  checkGitAvailable: () => ipcRenderer.invoke('project-init-check-git'),

  // V0.12 权限模式（启动模式）APIs

  /**
   * 获取权限模式配置
   * @returns {Promise<{success: boolean, mode?: string, isConfigured?: boolean, isKnownMode?: boolean, modeName?: string, error?: string, errorCode?: string}>}
   */
  getPermissionModeConfig: () => ipcRenderer.invoke('get-permission-mode-config'),

  /**
   * 设置权限模式
   * @param {string} mode - 权限模式（plan/default/acceptEdits/bypassPermissions）
   * @returns {Promise<{success: boolean, backupPath?: string, error?: string, errorCode?: string}>}
   */
  setPermissionMode: (mode) => ipcRenderer.invoke('set-permission-mode', mode),

  // V0.16 模型配置与推理等级 APIs

  /**
   * 获取模型配置（model + effortLevel）
   * @returns {Promise<{success: boolean, model?: string|null, effortLevel?: string|null, isModelConfigured?: boolean, isEffortConfigured?: boolean, error?: string, errorCode?: string}>}
   */
  getModelConfig: () => ipcRenderer.invoke('get-model-config'),

  /**
   * 设置模型配置（model 或 effortLevel）
   * @param {string} field - 字段名（model 或 effortLevel）
   * @param {string} value - 字段值
   * @returns {Promise<{success: boolean, backupPath?: string|null, error?: string, errorCode?: string}>}
   */
  setModelConfig: (field, value) => ipcRenderer.invoke('set-model-config', field, value),

  /**
   * 获取当前生效的模型注册表（models + effortLevels）
   * 来源优先级：userData cache（远程拉回的） > 打包 json > 硬编码兜底
   * @returns {Promise<{success: boolean, registry: object, source: string}>}
   */
  getModelRegistry: () => ipcRenderer.invoke('model-registry:get'),

  /**
   * 获取当前生效的定价注册表（exchangeRate + models 定价表）
   * 来源优先级：userData cache（远程拉回的） > 打包 json > 硬编码兜底
   * @returns {Promise<{success: boolean, registry: object, source: string}>}
   */
  getPricingRegistry: () => ipcRenderer.invoke('pricing-registry:get'),

  // Claude Code 会员额度状态 APIs

  /**
   * 获取 Claude Code 会员额度状态接入情况与最新快照
   * @returns {Promise<{success: boolean, claudeInstalled?: boolean, integrationState?: string, message?: string, config?: object, snapshot?: object|null, error?: string, errorCode?: string}>}
   */
  getClaudeUsageStatusState: () => ipcRenderer.invoke('claude-usage-status:get-state'),

  /**
   * 自动安装或修复 Claude Code 会员额度状态能力
   * @param {{force?: boolean}} [options] - 安装选项
   * @returns {Promise<object>}
   */
  ensureClaudeUsageStatusInstalled: (options) => ipcRenderer.invoke('claude-usage-status:ensure-installed', options),

  /**
   * 保存 Claude Code 会员额度状态显示配置
   * @param {{displayMode?: string, fiveHourThreshold?: number, sevenDayThreshold?: number}} config - 显示配置
   * @returns {Promise<object>}
   */
  saveClaudeUsageStatusConfig: (config) => ipcRenderer.invoke('claude-usage-status:save-config', config),

  /**
   * 获取 Claude Code 会员额度 7d 周期满载率历史（v1.4.1）
   * @returns {Promise<{success: boolean, exists: boolean, currentCycle: object|null, completedCycles: Array}>}
   */
  getClaudeUsageHistory: () => ipcRenderer.invoke('claude-usage-status:get-history'),

  // V0.14 双向自动同步 APIs

  /**
   * 比较两个技能目录的 SKILL.md 内容 hash
   * @param {Object} params - { sourcePath, targetPath }
   * @returns {Promise<{success: boolean, isDifferent: boolean, sourceMtime: number}>}
   */
  compareSkillContent: (params) => ipcRenderer.invoke('compare-skill-content', params),

  /**
   * 监听中央仓库变更事件（主进程 → 渲染进程）
   * @param {(skillNames: string[]) => void} callback - 变更回调
   * @returns {() => void} 取消监听函数
   */
  onCentralRepoChanged: (callback) => {
    const handler = (_event, skillNames) => callback(skillNames)
    ipcRenderer.on('central-repo-changed', handler)
    return () => ipcRenderer.removeListener('central-repo-changed', handler)
  },

  /**
   * 获取同步锁（方向 2 写入前调用，屏蔽方向 1 的 watcher）
   * @returns {Promise<{success: boolean}>}
   */
  acquireSyncLock: () => ipcRenderer.invoke('acquire-sync-lock'),

  /**
   * 释放同步锁（方向 2 写入后调用，主进程延迟 1s 解锁）
   * @returns {Promise<{success: boolean}>}
   */
  releaseSyncLock: () => ipcRenderer.invoke('release-sync-lock'),

  /**
   * 重启中央仓库文件监听（仓库路径变更时调用）
   * @param {string} newRepoPath - 新仓库路径
   * @returns {Promise<{success: boolean}>}
   */
  restartRepoWatcher: (newRepoPath) => ipcRenderer.invoke('restart-repo-watcher', newRepoPath),

  // V1.2.9 应用更新提醒 APIs

  /**
   * 获取当前应用更新状态
   * @returns {Promise<{checked: boolean, checking: boolean, hasUpdate: boolean, currentVersion: string, latestVersion: string, releaseUrl: string, error: string|null, checkedAt: string|null}>}
   */
  getAppUpdateState: () => ipcRenderer.invoke('app-update:get-state'),

  /**
   * 手动检查是否存在新版
   * @returns {Promise<{checked: boolean, checking: boolean, hasUpdate: boolean, currentVersion: string, latestVersion: string, releaseUrl: string, error: string|null, checkedAt: string|null}>}
   */
  checkAppUpdate: () => ipcRenderer.invoke('app-update:check'),

  /**
   * 打开新版下载页
   * @returns {Promise<{success: boolean, url: string}>}
   */
  openAppUpdatePage: () => ipcRenderer.invoke('app-update:open-release-page'),

  /**
   * 监听主进程推送的应用更新状态
   * @param {(state: Object) => void} callback - 状态更新回调
   * @returns {() => void}
   */
  onAppUpdateState: (callback) => {
    const handler = (_event, state) => callback(state)
    ipcRenderer.on('app-update:state', handler)
    return () => ipcRenderer.removeListener('app-update:state', handler)
  },

  /**
   * 监听用量聚合真实进度
   * @param {(progress: Object) => void} callback - 进度回调
   * @returns {() => void}
   */
  onUsageAggregationProgress: (callback) => {
    const handler = (_event, progress) => callback(progress)
    ipcRenderer.on('usage-aggregate:progress', handler)
    return () => ipcRenderer.removeListener('usage-aggregate:progress', handler)
  },

  // V0.11 MCP 管理 APIs

  /**
   * MCP 管理 API
   */
  mcp: {
    /**
     * 扫描两个工具的配置文件，返回 MCP 列表和工具安装状态
     * @returns {Promise<{success: boolean, mcpList: Array, toolsInstalled: Object, error: string|null}>}
     */
    scanConfigs: () => ipcRenderer.invoke('mcp:scanConfigs'),

    /**
     * 启用/停用指定 MCP 到指定工具
     * @param {string} mcpId - MCP 标识符（名称）
     * @param {string} tool - 目标工具（claude/codex）
     * @param {boolean} enable - 是否启用
     * @returns {Promise<{success: boolean, error: string|null}>}
     */
    toggleMcp: (mcpId, tool, enable) => ipcRenderer.invoke('mcp:toggleMcp', mcpId, tool, enable),

    /**
     * 检查 Claude Code 和 Codex 是否安装
     * @returns {Promise<{success: boolean, toolsInstalled: Object, error: string|null}>}
     */
    checkToolsInstalled: () => ipcRenderer.invoke('mcp:checkToolsInstalled')
  },

  // V1.2.4 网络诊断 APIs

  /**
   * 获取 IP 监控当前状态（含历史时间线）
   * @returns {Promise<{success: boolean, data: Object}>}
   */
  getIpMonitorState: () => ipcRenderer.invoke('network:getIpMonitorState'),

  /**
   * 切换 IP 采样频率（页面打开=快速5秒，离开=后台30秒）
   * @param {boolean} fast
   * @returns {Promise<{success: boolean}>}
   */
  setIpMonitorFastMode: (fast) => ipcRenderer.invoke('network:setIpMonitorFastMode', fast),

  /**
   * 暂停/恢复 IP 监控
   * @param {boolean} enabled
   * @returns {Promise<{success: boolean, data: Object}>}
   */
  toggleIpMonitor: (enabled) => ipcRenderer.invoke('network:toggleIpMonitor', enabled),

  /**
   * 监听 IP 监控状态实时更新（主进程推送）
   * @param {(state: Object) => void} callback
   * @returns {() => void} 取消监听函数
   */
  onIpStateUpdate: (callback) => {
    const handler = (_event, state) => callback(state)
    ipcRenderer.on('network:ipStateUpdate', handler)
    return () => ipcRenderer.removeListener('network:ipStateUpdate', handler)
  },

  /**
   * 并行检测所有 API 端点连通性（OpenAI + Anthropic）
   * @returns {Promise<{success: boolean, data: Array, error: string|null}>}
   */
  probeEndpoints: () => ipcRenderer.invoke('network:probeEndpoints'),

  // Session 浏览 APIs

  /**
   * 获取所有项目列表
   * @returns {Promise<{success: boolean, data: Array, error: string|null}>}
   */
  listSessionProjects: () => ipcRenderer.invoke('session:listProjects'),

  /**
   * 获取指定项目的 session 列表
   * @param {string} projectId - 编码后的项目目录名
   * @returns {Promise<{success: boolean, data: Array, error: string|null}>}
   */
  listSessions: (projectId) => ipcRenderer.invoke('session:listSessions', projectId),

  /**
   * 读取 session 对话内容
   * @param {string} projectId - 项目目录名
   * @param {string} sessionId - session UUID
   * @returns {Promise<{success: boolean, data: Array, error: string|null}>}
   */
  readSession: (projectId, sessionId) => ipcRenderer.invoke('session:readSession', projectId, sessionId),

  /**
   * 全文搜索对话内容
   * @param {string} keyword - 搜索关键词
   * @returns {Promise<{success: boolean, data: Array, error: string|null}>}
   */
  searchSessions: (keyword) => ipcRenderer.invoke('session:search', keyword),

  /**
   * 删除指定 session
   * @param {string} projectId - 项目目录名
   * @param {string} sessionId - session UUID
   * @returns {Promise<{success: boolean, error: string|null}>}
   */
  deleteSession: (projectId, sessionId) => ipcRenderer.invoke('session:delete', projectId, sessionId),

  // v1.4.5 启动历史对话 APIs

  /**
   * 读取 session 的原工作目录（cwd），并检测该目录是否仍存在
   * @param {{projectId: string, sessionId: string}} payload
   * @returns {Promise<{success: boolean, cwd?: string|null, cwdExists?: boolean, error?: string}>}
   */
  readSessionCwd: (payload) => ipcRenderer.invoke('session-resume:read-cwd', payload),

  /**
   * 在 macOS Terminal 新窗口中启动 Claude Code 并恢复此 session
   * @param {{cwd: string, uuid: string}} payload
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  launchSessionInTerminal: (payload) => ipcRenderer.invoke('session-resume:launch-in-terminal', payload),

  // v1.5.0 Codex 账户切换 APIs

  /**
   * 命名空间式接口，避免污染顶层 electronAPI
   */
  codexAccount: {
    list: () => ipcRenderer.invoke('codex-account:list'),
    save: (name) => ipcRenderer.invoke('codex-account:save', { name }),
    switch: (targetName) => ipcRenderer.invoke('codex-account:switch', { targetName }),
    rename: (oldName, newName) =>
      ipcRenderer.invoke('codex-account:rename', { oldName, newName }),
    delete: (name) => ipcRenderer.invoke('codex-account:delete', { name }),
    detectStorage: () => ipcRenderer.invoke('codex-account:detect-storage'),
    openCodex: () => ipcRenderer.invoke('codex-account:open-codex'),
    /**
     * 订阅"新账户检测"推送
     * @param {(payload: object) => void} handler
     * @returns {() => void} unsubscribe
     */
    onNewAccountDetected(handler) {
      const wrapped = (_event, payload) => handler(payload)
      ipcRenderer.on('codex-account:new-account-detected', wrapped)
      return () => ipcRenderer.removeListener('codex-account:new-account-detected', wrapped)
    },
  },

  // 文档查阅 APIs

  /**
   * 打开文件夹选择对话框
   * @returns {Promise<{success: boolean, data: string|null, error: string|null}>}
   */
  docSelectFolder: () => ipcRenderer.invoke('doc:selectFolder'),

  /**
   * 添加文件夹（校验 + 扫描 + 持久化）
   * @param {string} folderPath
   * @returns {Promise<{success: boolean, data?: object, error?: string, errorCode?: string}>}
   */
  docAddFolder: (folderPath) => ipcRenderer.invoke('doc:addFolder', folderPath),

  /**
   * 移除文件夹
   * @param {string} folderPath
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  docRemoveFolder: (folderPath) => ipcRenderer.invoke('doc:removeFolder', folderPath),

  /**
   * 获取已保存的文件夹列表（含路径校验）
   * @returns {Promise<{success: boolean, data: Array, error: string|null}>}
   */
  docListFolders: () => ipcRenderer.invoke('doc:listFolders'),

  /**
   * 列出文件夹下的所有 .md 文件
   * @param {string} folderPath
   * @returns {Promise<{success: boolean, data: Array, error: string|null}>}
   */
  docListFiles: (folderPath) => ipcRenderer.invoke('doc:listFiles', folderPath),

  /**
   * 读取 .md 文件内容
   * @param {string} filePath
   * @returns {Promise<{success: boolean, data: {content: string, size: number}, error: string|null}>}
   */
  docReadFile: (filePath) => ipcRenderer.invoke('doc:readFile', filePath),
})
