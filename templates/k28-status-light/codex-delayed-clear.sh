#!/bin/bash
# Codex done 状态延迟清理：10 分钟无新动作后删除对应 session 状态并重渲染。
DIR="$1"
PYBIN="$2"
FILE="$3"
MARK="$4"
TS="$5"
PIDFILE="$6"
DELAY="$7"

sleep "$DELAY"

if [ "$(cat "$MARK" 2>/dev/null)" != "$TS" ]; then
  rm -f "$PIDFILE"
  exit 0
fi

if [ -f "$FILE" ]; then
  CURRENT_TS=$(awk -F '\t' '{print $2}' "$FILE" 2>/dev/null)
  if [ "$CURRENT_TS" != "$TS" ]; then
    rm -f "$PIDFILE"
    exit 0
  fi
  rm -f "$FILE"
fi

rm -f "$MARK" "$PIDFILE"
"$PYBIN" "$DIR/k28_render.py" >/dev/null 2>&1
