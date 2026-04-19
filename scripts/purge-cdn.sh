#!/usr/bin/env bash
# 清理 jsDelivr CDN 对远程配置文件的缓存
#
# 何时使用：
# - 每次修改 src/config/*.json 并 push 到 master 之后
# - 不清的话 jsDelivr 可能返老数据几小时，用户启动时会被 cache 层记住（有防退化保护但仍建议清）
#
# 用法：
#   bash scripts/purge-cdn.sh
#
# 参考：https://www.jsdelivr.com/documentation#id-purge-cache

set -e

REPO="yunshu0909/CodePal"
BRANCH="master"

FILES=(
  "src/config/pricing.json"
  "src/config/model-registry.json"
)

for file in "${FILES[@]}"; do
  url="https://purge.jsdelivr.net/gh/${REPO}@${BRANCH}/${file}"
  echo "→ Purging: ${file}"
  response=$(curl -s "$url")
  status=$(echo "$response" | grep -o '"status":\s*"[^"]*"' | head -1 || true)
  if [[ "$status" == *"finished"* ]]; then
    echo "  ✓ purge finished"
  else
    echo "  ! unexpected response:"
    echo "$response" | head -3
  fi
  echo ""
done

echo "Done. jsDelivr 将在几秒内返回最新文件。"
