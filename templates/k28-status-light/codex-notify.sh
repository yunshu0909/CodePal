#!/bin/bash
# Codex notify 分发器：转发给原 SkyComputerUseClient + 触发 K28 状态灯。
# Codex 调用方式：codex-notify.sh <JSON>   （JSON=notify事件；本进程 $PWD = Codex 项目目录）
# Codex 外部 notify 只有 agent-turn-complete（一轮结束）→ 映射为 done(绿)。无 busy/attention。
DIR="$HOME/.claude/k28-status-light"
PYBIN="$DIR/.venv/bin/python"
JSON="$1"
SKY="/Users/yunshu/.codex-switcher/shared/.codex/computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient"

{
  echo "=== notify $(date '+%H:%M:%S') pwd=$PWD ==="
  echo "json: ${JSON:0:400}"
} >> "$DIR/codex-debug.log" 2>&1

# 1) 保留原行为：转发给 SkyComputerUseClient（原配置 = [SKY,"turn-ended"] → SKY turn-ended <JSON>）
[ -x "$SKY" ] && nohup "$SKY" "turn-ended" "$JSON" >/dev/null 2>&1 &

# 2) K28：解析事件类型，turn 结束 → done(绿)。项目名取自 $PWD（Codex 运行目录）。
TYPE=$(printf '%s' "$JSON" | "$PYBIN" -c "import sys,json
try: print(json.load(sys.stdin).get('type',''))
except Exception: print('')" 2>/dev/null)
case "$TYPE" in
  agent-turn-complete|*turn*complete*|turn-ended|"")
    NOW=$(date +%s)
    LAST=0
    [ -f "$DIR/codex-hook.last" ] && LAST=$(cat "$DIR/codex-hook.last" 2>/dev/null || printf 0)
    # hooks 生效后 Stop 会负责 done；notify 只保留为 hooks 未信任/未触发时的兜底。
    if [ $((NOW - LAST)) -le 30 ]; then
      echo "notify_skip_recent_hook last=$LAST now=$NOW" >> "$DIR/codex-debug.log" 2>&1
      exit 0
    fi
    echo "notify_forward_done" >> "$DIR/codex-debug.log" 2>&1
    printf '{"cwd":"%s"}' "$PWD" | K28_SRC=Codex bash "$DIR/k28_status.sh" done ;;
esac
exit 0
