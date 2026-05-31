#!/bin/bash
# K28 状态灯监控：展示当前活跃状态、Codex 延迟清理 timer、孤儿 marker 和渲染进程。
DIR="$HOME/.claude/k28-status-light"
STATES="$DIR/states"
NOW=$(date +%s)
TTL=3600
DONE_TTL=600

echo "K28 status light monitor  $(date '+%F %T')"
echo

ACTIVE=0
STALE=0
echo "states:"
for FILE in "$STATES"/*.txt; do
  [ -e "$FILE" ] || continue
  IFS=$'\t' read -r STATE TS NAME < "$FILE"
  case "$TS" in
    ''|*[!0-9]*) AGE="bad-ts"; STALE=$((STALE + 1)) ;;
    *)
      AGE=$((NOW - TS))
      if [ "$AGE" -gt "$TTL" ]; then
        STALE=$((STALE + 1))
      else
        ACTIVE=$((ACTIVE + 1))
      fi
      ;;
  esac
  KEY=$(basename "$FILE" .txt)
  printf '  %-10s %-24s age=%ss key=%s\n' "$STATE" "$NAME" "$AGE" "$KEY"
done
[ "$ACTIVE" -eq 0 ] && [ "$STALE" -eq 0 ] && echo "  (none; renderer will show idle mark)"
echo "  active=$ACTIVE stale=$STALE"
echo

TIMERS=0
ORPHANS=0
echo "codex done timers:"
for MARK in "$DIR"/codex-clear-*.mark; do
  [ -e "$MARK" ] || continue
  KEY=$(basename "$MARK" .mark | sed 's/^codex-clear-//')
  PIDFILE="$DIR/codex-clear-$KEY.pid"
  TS=$(cat "$MARK" 2>/dev/null)
  REMAINING="unknown"
  case "$TS" in
    ''|*[!0-9]*) ;;
    *) REMAINING=$((DONE_TTL - (NOW - TS))); [ "$REMAINING" -lt 0 ] && REMAINING=0 ;;
  esac
  PID=""
  [ -f "$PIDFILE" ] && PID=$(cat "$PIDFILE" 2>/dev/null)
  if [ -n "$PID" ] && kill -0 "$PID" >/dev/null 2>&1; then
    TIMERS=$((TIMERS + 1))
    printf '  running  key=%s remaining=%ss pid=%s\n' "$KEY" "$REMAINING" "$PID"
  else
    ORPHANS=$((ORPHANS + 1))
    printf '  orphan   key=%s remaining=%ss pid=%s\n' "$KEY" "$REMAINING" "${PID:-none}"
  fi
done
[ "$TIMERS" -eq 0 ] && [ "$ORPHANS" -eq 0 ] && echo "  (none)"
echo "  timers=$TIMERS orphans=$ORPHANS"
echo

RENDER_PROCS=$(pgrep -fl "k28_render.py" | wc -l | tr -d ' ')
CLEAR_PROCS=$(pgrep -fl "codex-delayed-clear.sh" | wc -l | tr -d ' ')
echo "processes:"
echo "  k28_render.py=$RENDER_PROCS"
echo "  codex-delayed-clear.sh=$CLEAR_PROCS"
echo
echo "watch:"
echo "  while true; do clear; $DIR/k28_monitor.sh; sleep 2; done"
