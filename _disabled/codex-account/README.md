# 【已停用】Codex 账户管理模块

> **状态**：停用（2026-06-07 下线）｜**原因**：自用价值不大，停止维护。
> 整个 Codex 多账户切换功能被整体隔离到此目录，**不参与构建、不参与默认测试、运行时完全不加载**。代码原样保留，随时可恢复。

## 这是什么

Codex 账户管理（多账户切换 + 自动重启 Codex + 凭证保活 + 5h/7d 倒计时 + 重命名/删除）。
经历 V1.5.0（首发）→ V1.6.x（重启加固 + 凭证保活）→ V1.7（重写 + symlink farm + 调度器）三代演进。

下线方式：**断开 16 个接线点 + 把全部 `codex*` 实现整体搬进本目录**。因为本目录在 `src/`、`electron/`、`templates/`、`mcp/` 之外，electron-builder 的 `files` 通配符不会打包它；前端文件没人 import，Vite 也会自动 tree-shake 掉。所以功能彻底关闭、后台不再跑监听/续签。

## 目录内容（69 个文件）

```
_disabled/codex-account/
├── src/pages/                       # 前端：页面 + 组件 + hooks + css（原 src/pages/）
│   ├── CodexAccountPage.jsx         #   V1.6 旧 UI
│   ├── CodexAccountPageV17.jsx      #   V1.7 新 UI
│   └── codex-account/               #   路由 / 卡片 / 弹窗 / hooks / 时间格式 / 样式
├── electron/
│   ├── handlers/                    # registerCodexAccountHandlers(.V17).js
│   └── services/                    # codex*.js（17 个）+ cloudSyncDetector.js
└── tests/                           # 仅 Codex 的测试套件（原 自动化测试/）
    ├── V1.5.0/  V1.6.2/  V1.7/
```

> ⚠️ 搬动后这些文件里指向 app 外部的相对 import（如 `../../components/Button`、`../services/共享util`）会断——**这不影响任何东西**，因为没人加载它们；恢复时把文件搬回原位，相对路径自然复原。测试里的深层相对路径（`../../../../electron/...`）同理，恢复后需校准或随搬回位置自愈。

## 如何恢复

### 第一步：文件搬回原位

| 从（本目录内） | 搬回到（skill-manager/） |
|---|---|
| `src/pages/CodexAccountPage.jsx`、`CodexAccountPageV17.jsx` | `src/pages/` |
| `src/pages/codex-account/` | `src/pages/codex-account/` |
| `electron/handlers/registerCodexAccountHandlers(.V17).js` | `electron/handlers/` |
| `electron/services/codex*.js`、`cloudSyncDetector.js` | `electron/services/` |
| `tests/V1.5.0`、`tests/V1.6.2`、`tests/V1.7` | `自动化测试/` |

### 第二步：接回 16 个接线点（全部曾经存在，git 历史里有完整原文，`git log --follow` 可查）

**前端**
1. `src/App.jsx` — 重新 import `CodexAccountPage` / `CodexAccountPageV17` / `CodexAccountRouter`
2. `src/App.jsx` — `VALID_ACTIVE_MODULES` 加回 `'codex-accounts'`
3. `src/App.jsx` — 加回 `{activeModule === 'codex-accounts' && <CodexAccountRouter v17={…} legacy={…} />}` 渲染块
4. `src/components/WorkbenchLayout.jsx` — 「账户与用量」组加回 `{ id: 'codex-accounts', label: 'Codex 账户', icon: '⚡' }`（顺带 JSDoc 类型并集）

**主进程 `electron/main.js`**
5. 重新 require `registerCodexAccountHandlers, stopCodexAccountWatcher` / `registerCodexAccountHandlersV17` / `bootstrapV17`
6. 模块级变量 `let v17BootstrapResult / v17Scheduler / v17Handlers = null`
7. `whenReady` 内重新 `await bootstrapV17({...})`（cloud detect → migrate → recover → integrity → scheduler）
8. 重新挂 `app.on('before-quit')` drain（scheduler + handlers stop，最长 3 秒 race）
9. `app.on('window-all-closed')` 内加回 `stopCodexAccountWatcher()`
10. 重新调 `registerCodexAccountHandlers({...})` + `v17Handlers = registerCodexAccountHandlersV17({...})`

**preload `electron/preload.js`**
11. 加回 `codexAccount: { … }`（V1.6 通道：list/save/switch/rename/delete/detect-storage/open-codex/refresh-slot/onNewAccountDetected）
12. 加回 `codexAccountV17: { … }`（V1.7 通道：list/read-active/switch/force-refresh/judge-status/login-*/rename/delete/open-codex/get-bootstrap + onLoginEvent/onMigrationEvent/onCloudSyncWarning）

**收尾**
13. `package.json` 加回 `test:v150` / `test:v17` 等脚本
14. `README.md` 恢复「Codex 账户」功能段 + 凭证保活隐私声明
15. 跑 `npm run build` + 对应 Codex 测试套件确认绿
16. `docs/screenshots/codex-accounts.png` 仍在原处可直接复用

> 提示：以上每个接线点的原始写法都能在 git 历史中按文件 `git log -p -- electron/main.js` 等检索到下线那一笔 commit 的 diff，照着反向贴回最稳。
