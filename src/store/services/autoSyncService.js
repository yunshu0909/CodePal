/**
 * 自动同步服务（方向 1：中央仓库→工具）
 *
 * 负责：
 * - 接收中央仓库文件变更通知
 * - 将变更的技能自动推送到已启用的工具目录
 * - 并发控制（串行等待）
 *
 * @module store/services/autoSyncService
 */

/**
 * 创建自动同步服务实例
 * @param {Object} deps - 依赖集合
 * @param {() => Promise<string[]>} deps.getPushTargets - 获取启用的推送目标
 * @param {() => Promise<Object>} deps.getConfig - 获取配置
 * @param {(toolId: string, skillNames: string[]) => Promise<Object>} deps.pushSkills - 推送技能
 * @param {() => void} deps.clearPushStatusCache - 清除推送状态缓存
 * @returns {{ handleCentralRepoChanged: Function }}
 */
export function createAutoSyncService(deps) {
  // 串行控制：同一时刻只允许一个同步任务
  let activeSyncTask = null

  /**
   * 处理中央仓库变更，将变更的技能推送到已启用的工具
   * @param {string[]} changedSkillNames - 变更的技能名称列表
   * @returns {Promise<{syncedCount: number, errors: string[]}>}
   */
  async function handleCentralRepoChanged(changedSkillNames) {
    // 等待上一个任务完成，避免并发推送
    if (activeSyncTask) {
      await activeSyncTask.catch(() => {})
    }

    const runSync = async () => {
      let syncedCount = 0
      const errors = []

      try {
        const pushTargets = await deps.getPushTargets()
        if (!pushTargets || pushTargets.length === 0) {
          return { syncedCount: 0, errors: [] }
        }

        const config = await deps.getConfig()
        const pushStatus = config.pushStatus || {}

        for (const toolId of pushTargets) {
          // 找变更技能与该工具已推送技能的交集
          const pushedSkills = pushStatus[toolId] || []
          const skillsToSync = changedSkillNames.filter(
            (name) => pushedSkills.includes(name)
          )

          if (skillsToSync.length === 0) continue

          try {
            const result = await deps.pushSkills(toolId, skillsToSync)
            if (result.success) {
              syncedCount += skillsToSync.length
            } else {
              errors.push(`${toolId}: ${result.error || 'PUSH_FAILED'}`)
            }
          } catch (error) {
            errors.push(`${toolId}: ${error.message}`)
          }
        }

        // 有同步操作时清除推送缓存，保证状态展示一致
        if (syncedCount > 0) {
          deps.clearPushStatusCache()
        }
      } catch (error) {
        errors.push(`auto-sync: ${error.message}`)
      }

      return { syncedCount, errors }
    }

    activeSyncTask = runSync().finally(() => {
      activeSyncTask = null
    })

    return activeSyncTask
  }

  return {
    handleCentralRepoChanged,
  }
}
