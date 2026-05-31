#!/bin/bash
# Codex hook 入口（带调试日志）：记录 Codex 实际传入的 stdin/argv/cwd，然后转交 k28_status.sh。
# 用法（codex-hooks.json 里）：bash codex-hook.sh <busy|done|attention|idle>
DIR="$HOME/.claude/k28-status-light"
PYBIN="$DIR/.venv/bin/python"
STATES="$DIR/states"
STATE="$1"
INPUT=""
[ -t 0 ] || INPUT=$(cat)

# 调试记录（确认 Codex 怎么传项目信息；确认无误后可删此段）
{
  echo "=== $(date '+%H:%M:%S') state=$STATE pwd=$PWD ==="
  echo "argv: $*"
  echo "stdin: ${INPUT:0:400}"
} >> "$DIR/codex-debug.log" 2>&1

# Codex Desktop 会启动内部建议/安全检查会话（transcript_path=null）。
# 这不是用户任务，不能写灯或播报，否则会和真实 Claude/Codex 语音混在一起。
IS_INTERNAL=$(printf '%s' "$INPUT" | "$PYBIN" -c "import json,sys
try:
    d=json.load(sys.stdin)
except Exception:
    d={}
is_internal = d.get('transcript_path') is None
print('1' if is_internal else '0')" 2>/dev/null)
if [ "$IS_INTERNAL" = "1" ]; then
  date +%s > "$DIR/codex-hook.last"
  exit 0
fi

# 给 notify 分发器留一个短期心跳：hooks 已经负责本轮状态时，notify 不再重复播报完成。
date +%s > "$DIR/codex-hook.last"

# 功能性转交（把原 stdin 一并传给 k28_status.sh，它从中取 session_id/cwd）
printf '%s' "$INPUT" | K28_SRC=Codex bash "$DIR/k28_status.sh" "$STATE"

KEY=$(printf '%s' "$INPUT" | "$PYBIN" -c "import hashlib,json,sys
try:
    d=json.load(sys.stdin)
    sid=d.get('session_id') or d.get('cwd') or ''
except Exception:
    sid=''
if not sid:
    sid='$PWD'
print(''.join(ch if ch.isalnum() else '_' for ch in sid))" 2>/dev/null)
MARK="$DIR/codex-clear-$KEY.mark"
PIDFILE="$DIR/codex-clear-$KEY.pid"
FILE="$STATES/$KEY.txt"

clear_if_due() {
  TARGET_FILE="$1"
  TARGET_MARK="$2"
  TARGET_TS="$3"
  NOW=$(date +%s)
  [ $((NOW - TARGET_TS)) -lt 600 ] && return 1
  if [ -f "$TARGET_FILE" ]; then
    CURRENT_TS=$(awk -F "\t" "{print \$2}" "$TARGET_FILE" 2>/dev/null)
    [ "$CURRENT_TS" = "$TARGET_TS" ] || return 1
    rm -f "$TARGET_FILE"
  fi
  rm -f "$TARGET_MARK"
  return 0
}

cancel_timer() {
  if [ -f "$PIDFILE" ]; then
    OLD_PID=$(cat "$PIDFILE" 2>/dev/null)
    case "$OLD_PID" in
      ''|*[!0-9]*) ;;
      *) kill "$OLD_PID" >/dev/null 2>&1 || true ;;
    esac
    rm -f "$PIDFILE"
  fi
}

schedule_timer() {
  TARGET_FILE="$1"
  TARGET_MARK="$2"
  TARGET_TS="$3"
  TARGET_PIDFILE="$4"
  DELAY="$5"
  [ "$DELAY" -lt 1 ] && DELAY=1
  nohup bash "$DIR/codex-delayed-clear.sh" "$DIR" "$PYBIN" "$TARGET_FILE" "$TARGET_MARK" "$TARGET_TS" "$TARGET_PIDFILE" "$DELAY" >/dev/null 2>&1 &
  printf '%s\n' "$!" > "$TARGET_PIDFILE"
}

# 兼容旧版本：如果曾经留下没有 pidfile 或进程已死的 marker，到期后顺手清掉。
for ORPHAN_MARK in "$DIR"/codex-clear-*.mark; do
  [ -e "$ORPHAN_MARK" ] || continue
  ORPHAN_KEY=$(basename "$ORPHAN_MARK" .mark | sed 's/^codex-clear-//')
  ORPHAN_PIDFILE="$DIR/codex-clear-$ORPHAN_KEY.pid"
  if [ -f "$ORPHAN_PIDFILE" ]; then
    ORPHAN_PID=$(cat "$ORPHAN_PIDFILE" 2>/dev/null)
    case "$ORPHAN_PID" in
      ''|*[!0-9]*) ;;
      *) kill -0 "$ORPHAN_PID" >/dev/null 2>&1 && continue ;;
    esac
  fi
  ORPHAN_TS=$(cat "$ORPHAN_MARK" 2>/dev/null)
  case "$ORPHAN_TS" in
    ''|*[!0-9]*) rm -f "$ORPHAN_MARK" "$ORPHAN_PIDFILE"; continue ;;
  esac
  if clear_if_due "$STATES/$ORPHAN_KEY.txt" "$ORPHAN_MARK" "$ORPHAN_TS"; then
    rm -f "$ORPHAN_PIDFILE"
    nohup "$PYBIN" "$DIR/k28_render.py" >/dev/null 2>&1 &
  else
    NOW=$(date +%s)
    REMAINING=$((600 - (NOW - ORPHAN_TS)))
    schedule_timer "$STATES/$ORPHAN_KEY.txt" "$ORPHAN_MARK" "$ORPHAN_TS" "$ORPHAN_PIDFILE" "$REMAINING"
  fi
done

# Codex Desktop 没有可靠的窗口关闭事件：完成后保留绿灯 10 分钟，再回到待机保底。
case "$STATE" in
  done)
    cancel_timer
    TS=$(date +%s)
    printf '%s\n' "$TS" > "$MARK"
    schedule_timer "$FILE" "$MARK" "$TS" "$PIDFILE" 600
    ;;
  busy|attention|idle)
    cancel_timer
    rm -f "$MARK"
    ;;
esac
exit 0
