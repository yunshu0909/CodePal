/**
 * 预加载脚本
 *
 * 负责：
 * - 通过 contextBridge 向渲染进程暴露安全的 API
 * - 封装 IPC 通信接口
 *
 * @module electron/preload
 */

const { contextBridge, ipcRenderer } = require('electron')

/**
 * Electron API 对象
 * 通过 contextBridge 暴露给渲染进程使用
 */
contextBridge.exposeInMainWorld('electronAPI', {
  // Plan methods accept settings/actions or a server-provided cycle ID only.
  readPlan: (payload) => ipcRenderer.invoke('plan-read', payload),
  savePlan: (payload) => ipcRenderer.invoke('plan-save', payload),
  actPlan: (payload) => ipcRenderer.invoke('plan-action', payload),
  queryPlan: (payload) => ipcRenderer.invoke('plan-query', payload),
  setPlanCyclePrice: (payload) => ipcRenderer.invoke('plan-cycle-price', payload),
  refreshPlanPrice: (payload) => ipcRenderer.invoke('plan-price-refresh', payload),
  setPlanLocalPrice: (payload) => ipcRenderer.invoke('plan-price-set-local', payload),
  clearPlanLocalPrice: (payload) => ipcRenderer.invoke('plan-price-clear-local', payload),
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

  /**
   * 打开文件夹选择对话框（新建项目选位置用）
   * @returns {Promise<{success: boolean, path: string, canceled: boolean, error: string|null}>} 选择结果
   */
  selectFolder: () => ipcRenderer.invoke('select-folder'),

  // V0.6 Usage monitoring APIs

  aggregateUsageCalendar: (params) => ipcRenderer.invoke('aggregate-usage-calendar', params),
  onUsageStatisticsChanged: (callback) => {
    const listener = (_event, snapshot) => callback(snapshot)
    ipcRenderer.on('usage-statistics:changed', listener)
    return () => ipcRenderer.removeListener('usage-statistics:changed', listener)
  },
  onUsageCalendarProgress: (callback) => {
    const listener = (_event, progress) => callback(progress)
    ipcRenderer.on('usage-calendar:progress', listener)
    return () => ipcRenderer.removeListener('usage-calendar:progress', listener)
  },

  // Skill 使用次数（近 N 天 Claude+Codex 调用统计，主数字为清洗后的可用样本数）
  skillUsageAggregate: (params) => ipcRenderer.invoke('skill-usage:aggregate', params),
  skillUsageRecords: (params) => ipcRenderer.invoke('skill-usage:records', params),
  aggregateSkillUsage: (params) => ipcRenderer.invoke('aggregate-skill-usage', params),

  // Skill 运行样本（近 N 天清洗后的 usable run samples）
  listSkillRunSamples: (params) => ipcRenderer.invoke('list-skill-run-samples', params),

  // Skill 控制中心：资产库路径（主进程按配置解析）、快照读取和统一命令。写操作由主进程重读原生状态后返回。
  getSkillRepoPath: () => ipcRenderer.invoke('skill-control:get-repo-path'),
  getSkillControlSnapshot: (params) => ipcRenderer.invoke('skill-control:get-snapshot', params),
  executeSkillCommand: (params) => ipcRenderer.invoke('skill-control:execute', params),

  // V0.7 供应商切换 API 已断接线隔离（见 _disabled/api-config/），token 不再过渲染层

  // V1.9.8 外链导航防护

  /**
   * 请求在系统浏览器打开外链（渲染层唯一合法外链出口，协议白名单校验在主进程）
   * @param {string} url - 外链地址
   * @returns {Promise<{success: boolean, errorCode: string|null, error: string|null}>}
   */
  openExternalLink: (url) => ipcRenderer.invoke('open-external-link', url),

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
   * @param {string} mode - 权限模式（plan/default/acceptEdits/dontAsk/bypassPermissions/auto）
   * @returns {Promise<{success: boolean, backupPath?: string, error?: string, errorCode?: string}>}
   */
  setPermissionMode: (mode) => ipcRenderer.invoke('set-permission-mode', mode),

  /** 删除用户级权限模式，恢复 Claude 客户端默认。 */
  resetPermissionMode: () => ipcRenderer.invoke('reset-permission-mode'),

  /** 只恢复上一次权限模式修改，不覆盖其他 settings 字段。 */
  restorePermissionMode: () => ipcRenderer.invoke('restore-permission-mode'),

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

  /** 同一事务删除 model 与 effortLevel。 */
  resetModelConfig: () => ipcRenderer.invoke('reset-model-config'),

  /**
   * 获取当前生效的定价注册表（exchangeRate + models 定价表）
   * 来源优先级：userData cache（远程拉回的） > 打包 json > 硬编码兜底
   * @returns {Promise<{success: boolean, registry: object, source: string}>}
   */
  getPricingRegistry: () => ipcRenderer.invoke('pricing-registry:get'),

  // 会话状态 APIs（#41，取代 K28 状态灯）

  /**
   * 读会话状态：开关、检测到的工具、钩子是否已装、装失败原因、可见会话
   * @returns {Promise<{success: boolean, data?: object, error?: string}>}
   */
  getSessionStatus: () => ipcRenderer.invoke('session-status:get'),

  /**
   * 打开 / 关掉会话状态：打开 = 装钩子，关掉 = 删钩子并清空
   * @param {boolean} enabled
   * @returns {Promise<{success: boolean, data?: object, error?: string}>}
   */
  setSessionStatusEnabled: (enabled) => ipcRenderer.invoke('session-status:set-enabled', enabled),

  /**
   * 某一边钩子没装上时重试
   * @returns {Promise<{success: boolean, data?: object, error?: string}>}
   */
  retrySessionStatus: () => ipcRenderer.invoke('session-status:retry'),

  /**
   * 告诉主进程会话状态页是否正在前台显示（在前台时不弹通知）
   * @param {boolean} visible
   * @returns {Promise<{success: boolean}>}
   */
  setSessionStatusPageVisible: (visible) => ipcRenderer.invoke('session-status:set-page-visible', visible),

  /**
   * 订阅会话列表变化（状态文件一变就推）
   * @param {(payload: {sessions: Array<object>, total: number, error: string|null}) => void} callback
   * @returns {() => void} 取消订阅
   */
  onSessionStatusChanged: (callback) => {
    const handler = (_event, payload) => callback(payload)
    ipcRenderer.on('session-status:changed', handler)
    return () => ipcRenderer.removeListener('session-status:changed', handler)
  },

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

  // V1.2.9 应用更新提醒 APIs

  /**
   * 获取当前应用更新状态
   * @returns {Promise<{checked: boolean, checking: boolean, hasUpdate: boolean, currentVersion: string, latestVersion: string, releaseUrl: string, error: string|null, checkedAt: string|null}>}
   */
  getAppUpdateState: () => ipcRenderer.invoke('app-update:get-state'),

  /**
   * 打开新版下载页
   * @returns {Promise<{success: boolean, url: string}>}
   */
  openAppUpdatePage: () => ipcRenderer.invoke('app-update:open-release-page'),

  /**
   * 订阅「关于 CodePal」菜单项
   * @param {() => void} callback
   * @returns {() => void} 取消订阅
   */
  onShowAbout: (callback) => {
    const handler = () => callback()
    ipcRenderer.on('app:show-about', handler)
    return () => ipcRenderer.removeListener('app:show-about', handler)
  },

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

  // 网络诊断（出口 IP）APIs

  /**
   * 获取出口 IP 当前状态（上次结果、近 7 天变化记录、开关）
   * @returns {Promise<{success: boolean, data: Object}>}
   */
  getIpMonitorState: () => ipcRenderer.invoke('network:getIpMonitorState'),

  /**
   * 按需检测一次公网 IP，不启动持续监控
   * @returns {Promise<{success: boolean, data: Object|null, error: string|null}>}
   */
  probeIpOnce: () => ipcRenderer.invoke('network:probeIpOnce'),

  /**
   * 切换 IP 采样频率（页面打开=快速5秒，离开=后台60秒）
   * @param {boolean} fast
   * @returns {Promise<{success: boolean}>}
   */
  setIpMonitorFastMode: (fast) => ipcRenderer.invoke('network:setIpMonitorFastMode', fast),

  /**
   * 开启/关闭持续监控（选择由主进程持久化）
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

  // 模型接入 APIs（#26）：只传供应商 / 模型 ID，Key 只写不回读

  /**
   * 读取各家配置、Claude Code 检测结果、终端命令状态（不含 Key）
   * @returns {Promise<{success: boolean, data: Object|null, error: {code: string, message: string}|null}>}
   */
  modelsList: () => ipcRenderer.invoke('models:list'),

  /** Read available review models without credentials; changes accept model IDs only. */
  /** @returns {Promise<object>} 无凭证来源列表的统一响应；主进程同步公开清单，不接受路径参数。 */
  modelsHubList: () => ipcRenderer.invoke('models:hubList'),
  /** @param {{id:string, enabled:boolean}} payload @returns {Promise<object>} 保存结果统一响应，失败由主进程回滚。 */
  modelsHubSetEnabled: (payload) => ipcRenderer.invoke('models:hubSetEnabled', payload),
  /** @param {{id:string, effort:string}} payload @returns {Promise<object>} 保存结果统一响应；只允许实际支持档位，成功同步公开清单。 */
  modelsHubSetEffort: (payload) => ipcRenderer.invoke('models:hubSetEffort', payload),
  /** @param {{order:string[]}} payload 审核在用的整串新顺序 @returns {Promise<object>} 统一响应；只接受当前可见审核在用模型的排列。 */
  modelsHubSetOrder: (payload) => ipcRenderer.invoke('models:hubSetOrder', payload),
  /** @returns {Promise<object>} 审核规则、是否改过、默认值版本、dev 两端状态、审核配置是否写进去。 */
  modelsRulesGet: () => ipcRenderer.invoke('models:rulesGet'),
  /** @param {{key:string, value:number|boolean}} payload 改哪一项、改成什么；主进程按白名单与范围校验。 */
  modelsRulesSet: (payload) => ipcRenderer.invoke('models:rulesSet', payload),
  /** @returns {Promise<object>} 恢复默认：清空改过的规则项，不动模型。 */
  modelsRulesReset: () => ipcRenderer.invoke('models:rulesReset'),
  /** @returns {Promise<object>} 按设置重新生成给 dev 的审核配置（F13 重试）。 */
  modelsConfigRepublish: () => ipcRenderer.invoke('models:configRepublish'),

  /**
   * 保存某家的 Key；第一次保存时自动加入预设默认模型
   * @param {{providerId: string, key: string}} payload
   * @returns {Promise<{success: boolean, data: {provider: Object}|null, error: Object|null}>}
   */
  modelsSetKey: (payload) => ipcRenderer.invoke('models:setKey', payload),

  /**
   * 测一下：走和审核相同的调用路径，结束后返回这次结果
   * @param {{providerId: string, modelId: string}} payload
   * @returns {Promise<{success: boolean, data: {lastResult: Object}|null, error: Object|null}>}
   */
  modelsTest: (payload) => ipcRenderer.invoke('models:test', payload),

  /**
   * 新增模型
   * @param {{providerId: string, name: string}} payload
   * @returns {Promise<{success: boolean, data: {provider: Object}|null, error: Object|null}>}
   */
  modelsAddModel: (payload) => ipcRenderer.invoke('models:addModel', payload),

  /**
   * 改模型名或参数（改名会换 id）
   * @param {{providerId: string, modelId: string, patch: Object}} payload
   * @returns {Promise<{success: boolean, data: {model: Object}|null, error: Object|null}>}
   */
  modelsUpdateModel: (payload) => ipcRenderer.invoke('models:updateModel', payload),

  /**
   * 移除模型
   * @param {{providerId: string, modelId: string}} payload
   * @returns {Promise<{success: boolean, data: {provider: Object}|null, error: Object|null}>}
   */
  modelsRemoveModel: (payload) => ipcRenderer.invoke('models:removeModel', payload),

  /**
   * 重新检测 Claude Code（装好或升级后用）
   * @returns {Promise<{success: boolean, data: Object}>}
   */
  modelsRecheckClaude: () => ipcRenderer.invoke('models:recheckClaude'),

  /**
   * 在 ~/.local/bin 安装各模型的终端命令
   * @returns {Promise<{success: boolean, data: {installed: string[]}|null, error: Object|null}>}
   */
  modelsInstallCommands: () => ipcRenderer.invoke('models:installCommands'),

  /**
   * 监听后台调用（审核 / 终端）写回的结果
   * @param {(change: {providerId: string, modelId: string, lastResult: Object}) => void} callback
   * @returns {() => void} 取消监听函数
   */
  onModelsChanged: (callback) => {
    const handler = (_event, change) => callback(change)
    ipcRenderer.on('models:changed', handler)
    return () => ipcRenderer.removeListener('models:changed', handler)
  },

  /**
   * 监听主进程要求切页（如点系统通知后切到网络诊断）
   * @param {(moduleId: string) => void} callback
   * @returns {() => void} 取消监听函数
   */
  onNavigate: (callback) => {
    const handler = (_event, moduleId) => callback(moduleId)
    ipcRenderer.on('app:navigate', handler)
    return () => ipcRenderer.removeListener('app:navigate', handler)
  },

  /**
   * 领取窗口创建前记下的待跳转模块（领一次即清空）
   * @returns {Promise<string|null>}
   */
  consumePendingNavigation: () => ipcRenderer.invoke('app:consumePendingNavigation'),

  // 对话回顾 APIs

  /**
   * 跨项目的最近对话（按修改时间倒序）
   * @returns {Promise<{success: boolean, data: {projectsDirExists: boolean, sessions: Array}|null, error: string|null}>}
   */
  listRecentSessions: () => ipcRenderer.invoke('session:listRecent'),

  /**
   * 从尾部倒着读一页对话消息
   * @param {string} projectId - 编码后的项目目录名
   * @param {string} sessionId - 对话 id
   * @param {{limit?: number, before?: number}} [options] - before 为上一页返回的 cursor
   * @returns {Promise<{success: boolean, data: {messages: Array, hasMore: boolean, cursor: number}|null, error: string|null}>}
   */
  readSession: (projectId, sessionId, options) => ipcRenderer.invoke('session:readSession', projectId, sessionId, options),

  /**
   * 在当前范围里搜对话正文
   * @param {string} keyword - 关键词
   * @param {{projectPath?: string|null, includeAuto?: boolean}} [options]
   * @returns {Promise<{success: boolean, data: Array|null, error: string|null}>}
   */
  searchSessions: (keyword, options) => ipcRenderer.invoke('session:search', keyword, options),

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
