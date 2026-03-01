/**
 * 导入服务模块
 *
 * 负责：
 * - 全量导入与重新导入
 * - 增量导入与自动增量刷新
 * - 导入来源与推送来源状态同步
 *
 * @module store/services/importService
 */

/**
 * 创建导入服务实例
 * @param {Object} deps - 依赖集合
 * @returns {{
 *   importSkills: Function,
 *   reimportSkills: Function,
 *   incrementalImport: Function,
 *   autoIncrementalRefresh: Function,
 *   getLastImportedToolIds: Function
 * }}
 */
export function createImportService(deps) {
  // 临时存储导入时选中的工具ID（用于初始化推送目标）
  let lastImportedToolIds = []

  // 自动增量刷新任务引用，避免定时器并发执行重复导入
  let autoIncrementalRefreshTask = null

  /**
   * 从选中的工具导入技能到中央仓库
   * 如果技能已存在则强制覆盖
   * @param {string[]} selectedToolIds - 选中的工具 ID 列表
   * @param {string[]} selectedCustomPathIds - 选中的自定义路径 ID 列表（可选）
   * @returns {Promise<{success: boolean, copiedCount: number, errors: Array|null}>}
   */
  async function importSkills(selectedToolIds, selectedCustomPathIds = []) {
    // 包含预设工具和自定义路径ID，用于判断推送目标初始化规则
    lastImportedToolIds = [...selectedToolIds, ...selectedCustomPathIds]

    const repoPath = await deps.getRepoPath()
    await deps.ensureDir(repoPath)

    let copiedCount = 0
    const errors = []

    const config = await deps.getConfig()
    if (!config.pushStatus) {
      config.pushStatus = {}
    }
    // 导入成功后将本次来源持久化，供自动增量刷新复用
    config.importSources = Array.from(
      new Set([...selectedToolIds, ...selectedCustomPathIds])
    )

    // 处理每个预设工具来源
    for (const toolId of selectedToolIds) {
      const tool = deps.toolDefinitions.find((t) => t.id === toolId)
      if (!tool) continue

      const scanResult = await deps.scanToolDirectory(tool.path)
      if (!scanResult.success) {
        errors.push(`${tool.name}: ${scanResult.error}`)
        continue
      }

      for (const skill of scanResult.skills) {
        const sourcePath = deps.getToolSkillPath(tool.path, skill.name)
        const targetPath = await deps.getCentralSkillPath(skill.name, repoPath)

        const copyResult = await deps.copySkill(sourcePath, targetPath, { force: true })

        if (copyResult.success) {
          copiedCount++

          if (!config.pushStatus[toolId]) {
            config.pushStatus[toolId] = []
          }
          if (!config.pushStatus[toolId].includes(skill.name)) {
            config.pushStatus[toolId].push(skill.name)
          }
        } else {
          errors.push(`${skill.name}: ${copyResult.error}`)
        }
      }
    }

    // 处理每个自定义路径来源
    if (selectedCustomPathIds.length > 0) {
      const customPaths = config.customPaths || []
      for (const customPathId of selectedCustomPathIds) {
        const customPath = customPaths.find((cp) => cp.id === customPathId)
        if (!customPath) continue

        const scanResult = await deps.scanCustomPath(customPath.path)
        if (!scanResult.success) {
          errors.push(`${customPath.path}: ${scanResult.error}`)
          continue
        }

        for (const [toolId, count] of Object.entries(scanResult.skills)) {
          if (count === 0) continue

          const tool = deps.toolDefinitions.find((t) => t.id === toolId)
          if (!tool) continue

          const customToolPath = deps.buildCustomToolPath(customPath.path, tool.path)
          const toolScanResult = await deps.scanToolDirectory(customToolPath)

          if (!toolScanResult.success) continue

          for (const skill of toolScanResult.skills) {
            const sourcePath = deps.getToolSkillPath(customToolPath, skill.name)
            const targetPath = await deps.getCentralSkillPath(skill.name, repoPath)

            const copyResult = await deps.copySkill(sourcePath, targetPath, { force: true })

            if (copyResult.success) {
              copiedCount++

              const sourceKey = `custom-${customPathId}-${toolId}`
              if (!config.pushStatus[sourceKey]) {
                config.pushStatus[sourceKey] = []
              }
              if (!config.pushStatus[sourceKey].includes(skill.name)) {
                config.pushStatus[sourceKey].push(skill.name)
              }
            } else {
              errors.push(`${skill.name}: ${copyResult.error}`)
            }
          }
        }
      }
    }

    await deps.saveConfig(config)
    await deps.setFirstEntryAfterImport(true)

    return {
      success: errors.length === 0 || copiedCount > 0,
      copiedCount,
      errors: errors.length > 0 ? errors : null,
    }
  }

  /**
   * 重新导入：清空中央仓库并从工具重新导入
   * @param {string[]} selectedToolIds - 选中的工具 ID 列表
   * @param {string[]} selectedCustomPathIds - 选中的自定义路径 ID 列表（可选）
   * @returns {Promise<{success: boolean, copiedCount: number, errors: Array|null}>}
   */
  async function reimportSkills(selectedToolIds, selectedCustomPathIds = []) {
    const repoPath = await deps.getRepoPath()
    const currentSkills = await deps.getCentralSkills()

    for (const skill of currentSkills) {
      const skillPath = await deps.getCentralSkillPath(skill.name, repoPath)
      await deps.deleteSkill(skillPath)
    }

    const config = await deps.getConfig()
    const newConfig = {
      version: '0.4',
      repoPath: config.repoPath || deps.DEFAULT_REPO_PATH,
      customPaths: config.customPaths || [],
      pushStatus: {},
      pushTargets: config.pushTargets || [],
      importSources: config.importSources || [],
      firstEntryAfterImport: false,
    }
    await deps.saveConfig(newConfig)

    return importSkills(selectedToolIds, selectedCustomPathIds)
  }

  /**
   * 增量导入 - 仅新增不覆盖
   * @param {string[]} customPathIds - 要导入的自定义路径ID列表
   * @returns {Promise<{success: boolean, added: number, skipped: number, errors: Array|null}>}
   */
  async function incrementalImport(customPathIds) {
    const existingSkills = await deps.getCentralSkills()
    const existingSkillNames = new Set(existingSkills.map((skill) => skill.name))

    const repoPath = await deps.getRepoPath()
    await deps.ensureDir(repoPath)

    let added = 0
    let skipped = 0
    const errors = []

    const config = await deps.getConfig()
    if (!config.pushStatus) {
      config.pushStatus = {}
    }

    for (const customPathId of customPathIds) {
      const customPath = config.customPaths?.find((cp) => cp.id === customPathId)
      if (!customPath) {
        errors.push(`${customPathId}: PATH_NOT_FOUND`)
        continue
      }

      const scanResult = await deps.scanCustomPath(customPath.path)
      if (!scanResult.success) {
        errors.push(`${customPath.path}: ${scanResult.error}`)
        continue
      }

      for (const [toolId, count] of Object.entries(scanResult.skills)) {
        if (count === 0) continue

        const tool = deps.toolDefinitions.find((t) => t.id === toolId)
        if (!tool) continue

        const customToolPath = deps.buildCustomToolPath(customPath.path, tool.path)
        const toolScanResult = await deps.scanToolDirectory(customToolPath)

        if (!toolScanResult.success) continue

        for (const skill of toolScanResult.skills) {
          if (existingSkillNames.has(skill.name)) {
            skipped++
            continue
          }

          const sourcePath = deps.getToolSkillPath(customToolPath, skill.name)
          const targetPath = await deps.getCentralSkillPath(skill.name, repoPath)

          const copyResult = await deps.copySkill(sourcePath, targetPath, { force: false })

          if (copyResult.success) {
            added++
            existingSkillNames.add(skill.name)

            const sourceKey = `custom-${customPathId}-${toolId}`
            if (!config.pushStatus[sourceKey]) {
              config.pushStatus[sourceKey] = []
            }
            if (!config.pushStatus[sourceKey].includes(skill.name)) {
              config.pushStatus[sourceKey].push(skill.name)
            }
          } else {
            errors.push(`${skill.name}: ${copyResult.error}`)
          }
        }
      }
    }

    await deps.saveConfig(config)

    return {
      success: errors.length === 0 || added > 0,
      added,
      skipped,
      errors: errors.length > 0 ? errors : null,
    }
  }

  /**
   * 自动增量刷新导入来源（仅新增，不覆盖，不删除）
   * @returns {Promise<{success: boolean, added: number, skipped: number, scannedSources: number, errors: Array|null}>}
   */
  async function autoIncrementalRefresh() {
    if (autoIncrementalRefreshTask) {
      return autoIncrementalRefreshTask
    }

    const runAutoIncrementalRefresh = async () => {
      const config = await deps.getConfig()
      if (!config.pushStatus) {
        config.pushStatus = {}
      }

      const configuredSources = Array.isArray(config.importSources) ? config.importSources : []
      const customPathList = Array.isArray(config.customPaths) ? config.customPaths : []
      const customPathIdSet = new Set(customPathList.map((customPath) => customPath.id))

      const presetSourceSet = new Set()
      const customSourceSet = new Set()
      for (const sourceId of configuredSources) {
        if (deps.toolDefinitions.some((tool) => tool.id === sourceId)) {
          presetSourceSet.add(sourceId)
          continue
        }
        if (typeof sourceId === 'string' && sourceId.startsWith('custom-') && customPathIdSet.has(sourceId)) {
          customSourceSet.add(sourceId)
        }
      }
      const presetSourceIds = Array.from(presetSourceSet)
      const customSourceIds = Array.from(customSourceSet)

      // 没有可用来源时直接返回，避免无意义扫描
      if (presetSourceIds.length === 0 && customSourceIds.length === 0) {
        return {
          success: true,
          added: 0,
          skipped: 0,
          scannedSources: 0,
          errors: null,
        }
      }

      const existingSkills = await deps.getCentralSkills()
      const existingSkillNames = new Set(existingSkills.map((skill) => skill.name))

      const repoPath = await deps.getRepoPath()
      await deps.ensureDir(repoPath)

      let added = 0
      let updated = 0
      let skipped = 0
      let scannedSources = 0
      const errors = []
      // 多来源冲突解决：记录每个待更新技能的最佳候选（mtime 最新的赢）
      const updateCandidates = {}

      // 1) 处理预设工具来源（例如 ~/.claude/skills）
      for (const toolId of presetSourceIds) {
        const tool = deps.toolDefinitions.find((toolDefinition) => toolDefinition.id === toolId)
        if (!tool) continue
        scannedSources++

        const scanResult = await deps.scanToolDirectory(tool.path)
        if (!scanResult.success) {
          errors.push(`${tool.name}: ${scanResult.error}`)
          continue
        }

        for (const skill of scanResult.skills) {
          if (existingSkillNames.has(skill.name)) {
            // 已存在：比较内容 hash，有变化才标记为更新候选
            if (deps.compareSkillContent) {
              const sourcePath = deps.getToolSkillPath(tool.path, skill.name)
              const targetPath = await deps.getCentralSkillPath(skill.name, repoPath)
              const cmp = await deps.compareSkillContent(sourcePath, targetPath)
              if (cmp.success && cmp.isDifferent) {
                // mtime 最新的来源赢
                if (!updateCandidates[skill.name] || cmp.sourceMtime > updateCandidates[skill.name].mtime) {
                  updateCandidates[skill.name] = { sourcePath, mtime: cmp.sourceMtime }
                }
              } else {
                skipped++
              }
            } else {
              skipped++
            }
            continue
          }

          const sourcePath = deps.getToolSkillPath(tool.path, skill.name)
          const targetPath = await deps.getCentralSkillPath(skill.name, repoPath)
          const copyResult = await deps.copySkill(sourcePath, targetPath, { force: false })

          if (!copyResult.success) {
            errors.push(`${skill.name}: ${copyResult.error}`)
            continue
          }

          added++
          existingSkillNames.add(skill.name)

          if (!config.pushStatus[toolId]) {
            config.pushStatus[toolId] = []
          }
          if (!config.pushStatus[toolId].includes(skill.name)) {
            config.pushStatus[toolId].push(skill.name)
          }
        }
      }

      // 2) 处理自定义来源（例如 ~/team-skills/.codex/skills）
      for (const customPathId of customSourceIds) {
        const customPath = customPathList.find((pathItem) => pathItem.id === customPathId)
        if (!customPath) continue
        scannedSources++

        const scanResult = await deps.scanCustomPath(customPath.path)
        if (!scanResult.success) {
          errors.push(`${customPath.path}: ${scanResult.error}`)
          continue
        }

        for (const [toolId, count] of Object.entries(scanResult.skills)) {
          if (count === 0) continue

          const tool = deps.toolDefinitions.find((toolDefinition) => toolDefinition.id === toolId)
          if (!tool) continue

          const customToolPath = deps.buildCustomToolPath(customPath.path, tool.path)
          const toolScanResult = await deps.scanToolDirectory(customToolPath)
          if (!toolScanResult.success) continue

          for (const skill of toolScanResult.skills) {
            if (existingSkillNames.has(skill.name)) {
              // 已存在：比较内容 hash，有变化才标记为更新候选
              if (deps.compareSkillContent) {
                const sourcePath = deps.getToolSkillPath(customToolPath, skill.name)
                const targetPath = await deps.getCentralSkillPath(skill.name, repoPath)
                const cmp = await deps.compareSkillContent(sourcePath, targetPath)
                if (cmp.success && cmp.isDifferent) {
                  if (!updateCandidates[skill.name] || cmp.sourceMtime > updateCandidates[skill.name].mtime) {
                    updateCandidates[skill.name] = { sourcePath, mtime: cmp.sourceMtime }
                  }
                } else {
                  skipped++
                }
              } else {
                skipped++
              }
              continue
            }

            const sourcePath = deps.getToolSkillPath(customToolPath, skill.name)
            const targetPath = await deps.getCentralSkillPath(skill.name, repoPath)
            const copyResult = await deps.copySkill(sourcePath, targetPath, { force: false })

            if (!copyResult.success) {
              errors.push(`${skill.name}: ${copyResult.error}`)
              continue
            }

            added++
            existingSkillNames.add(skill.name)

            const sourceKey = `custom-${customPathId}-${toolId}`
            if (!config.pushStatus[sourceKey]) {
              config.pushStatus[sourceKey] = []
            }
            if (!config.pushStatus[sourceKey].includes(skill.name)) {
              config.pushStatus[sourceKey].push(skill.name)
            }
          }
        }
      }

      // 批量应用更新候选（多来源冲突已通过 mtime 解决）
      for (const [skillName, candidate] of Object.entries(updateCandidates)) {
        const targetPath = await deps.getCentralSkillPath(skillName, repoPath)
        const copyResult = await deps.copySkill(candidate.sourcePath, targetPath, { force: true })
        if (copyResult.success) {
          updated++
        } else {
          errors.push(`update ${skillName}: ${copyResult.error}`)
        }
      }

      await deps.saveConfig(config)

      // 新增或更新后清空推送状态缓存，避免状态展示读取旧值
      if (added > 0 || updated > 0) {
        deps.clearPushStatusCache()
      }

      return {
        success: errors.length === 0 || added > 0 || updated > 0,
        added,
        updated,
        skipped,
        scannedSources,
        errors: errors.length > 0 ? errors : null,
      }
    }

    autoIncrementalRefreshTask = runAutoIncrementalRefresh().finally(() => {
      autoIncrementalRefreshTask = null
    })
    return autoIncrementalRefreshTask
  }

  /**
   * 获取上次导入时选中的工具ID（用于初始化推送目标）
   * @returns {string[]}
   */
  function getLastImportedToolIds() {
    return [...lastImportedToolIds]
  }

  return {
    importSkills,
    reimportSkills,
    incrementalImport,
    autoIncrementalRefresh,
    getLastImportedToolIds,
  }
}
