# CLAUDE.md

本文档为 Claude Code (claude.ai/code) 提供操作本代码仓库的指引。

## 注释规范

### 必须写注释的地方

| 位置 | 格式 | 要求 |
|------|------|------|
| 文件顶部 | `/** */` | 模块名称 + 职责描述（bullet points）+ `@module` |
| 导出函数 | `/** */` | 功能描述 + `@param` + `@returns`，复杂函数加执行步骤 |
| 复杂逻辑 | `//` | 说明"为什么"，而非"做什么" |
| React useState | `//` | 每个 state 的用途 |

### 注释力度

**文件头示例**：
```javascript
/**
 * 数据存储模块
 *
 * 负责：
 * - 扫描工具目录获取技能
 * - 中央仓库的导入/导出
 * - 推送状态管理
 *
 * @module store/data
 */
```

**函数示例**：
```javascript
/**
 * 从工具导入技能到中央仓库
 * @param {string[]} toolIds - 工具 ID 列表
 * @returns {Promise<{success: boolean, copiedCount: number}>}
 */
async importSkills(toolIds) {
  // 1. 确保目录存在
  // 2. 扫描并复制技能
  // 3. 更新配置
}
```

**行内示例**：
```javascript
// 静默处理：用户可能手动删除了文件
if (error === 'SOURCE_NOT_FOUND') {
  count++ // 已删除视为成功
}
```

### 不写废话

❌ `// 设置 x 为 1` `// 遍历数组` `// 如果成功`

✅ `// 统计成功导入的技能数` `// 倒序遍历避免索引错乱` `// 部分成功也算成功`


## 设计任务读取规则

- 当任务涉及 UI/视觉设计（如页面改版、组件样式、布局规范、设计稿还原）时，先读取：`design-system.html`
- 当任务不涉及 UI/设计（如业务逻辑、接口、构建、脚本、测试、文档）时，不需要读取该设计规范文件
- 读取时优先按需定位相关章节，避免无关内容占用上下文
