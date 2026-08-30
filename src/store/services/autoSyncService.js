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
 * @param {(toolId:string, skillName:string) => Promise<boolean>} deps.isPushed - 读取工具原生启用状态
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

        for (const toolId of pushTargets) {
          // 原生目录/配置才是事实源，旧 pushStatus 只保留为历史兼容数据。
          const states = await Promise.all(changedSkillNames.map((name) => deps.isPushed(toolId, name)))
          const skillsToSync = changedSkillNames.filter((_, index) => states[index])

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
