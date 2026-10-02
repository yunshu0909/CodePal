# 外层私人仓：管协议、需求、规格、记忆、文档；代码在里层单独一个仓
{{CODE_DIR}}/

# 系统文件
.DS_Store
Thumbs.db

# 个人 AI 工具配置（含本地偏好）
.claude/

# 缓存与构建产物
__pycache__/
*.pyc
node_modules/
dist/
build/
.cache/

# 日志与临时文件
*.log
*.tmp

# Issue 池工具的锁文件
issues/.lock

# 敏感配置（绝不入库）
.env
.env.local
.env.*.local
*.pem
*.key
