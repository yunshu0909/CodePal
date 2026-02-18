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
   * @param {string} params.startDate - 开始日期（YYYY-MM-DD）
   * @param {string} params.endDate - 结束日期（YYYY-MM-DD）
   * @param {string} params.timezone - 时区（当前仅支持 Asia/Shanghai）
   * @returns {Promise<{success: boolean, data?: object, meta?: {fromDailySummaryDays: number, recomputedDays: number, totalDays: number, failedDays: number}, error?: string}>}
   */
  aggregateUsageRange: (params) => ipcRenderer.invoke('aggregate-usage-range', params),

  // V0.7 API 配置 - 供应商切换

  /**
   * 获取当前 Claude 供应商配置
   * @returns {Promise<{success: boolean, current: string, profile: Object|null, error: string|null}>}
   * current: 'official' | 'qwen' | 'kimi' | 'aicodemirror' | 'custom'
   */
  getClaudeProvider: () => ipcRenderer.invoke('get-claude-provider'),

  /**
   * 读取供应商 API Key 的环境变量配置
   * @returns {Promise<{success: boolean, providers: Record<string, {token: string}>, envPath: string, error: string|null, errorCode: string|null}>}
   */
  getProviderEnvConfig: () => ipcRenderer.invoke('get-provider-env-config'),

  /**
   * 保存供应商 API Key 到 .env
   * @param {string} providerKey - 供应商 key ('qwen' | 'kimi' | 'aicodemirror')
   * @param {string} token - API Key
   * @returns {Promise<{success: boolean, envPath: string, error: string|null, errorCode: string|null}>}
   */
  saveProviderToken: (providerKey, token) => ipcRenderer.invoke('save-provider-token', providerKey, token),

  /**
   * 切换 Claude 供应商
   * @param {string} profileKey - 目标档位 ('official' | 'qwen' | 'kimi' | 'aicodemirror')
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
})
