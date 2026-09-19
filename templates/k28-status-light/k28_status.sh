#!/bin/bash
# CodePal「会话状态」钩子：把本会话的状态写进 states/，CodePal 读它显示列表、发系统通知。
# 全局工具，对所有项目生效。用法: k28_status.sh <busy|done|attention|idle|clear>
# （目录名 k28-status-light 是旧状态灯留下的，为兼容已装的钩子不改名；K28 亮灯和语音播报已停用、代码已删）
#
# 来源标记：环境变量 K28_SRC（默认 Claude）。Codex 路径在 codex-hook.sh / codex-notify.sh 里设 K28_SRC=Codex。
#
# hook 从 stdin 传入 JSON：
#   - session_id 作窗口唯一标识（一个窗口=一盏灯，bash 切目录不影响）；cwd 文件夹名作项目名
#   - busy(UserPromptSubmit) 带 prompt → 取前 30 字作「在干嘛」存进 <key>.task（本地截断，不调模型），done 时保留
#   - attention(AskUserQuestion) 带 tool_input → 取「问什么」存进 <key>.ask，回到 busy / done / clear 时删掉
DIR="$HOME/.claude/k28-status-light"
PYBIN="$DIR/.venv/bin/python"
# 旧状态灯装过 venv 就用它；新安装不再建 venv，退回系统 python3（只用来解析钩子传进来的 JSON）
[ -x "$PYBIN" ] || PYBIN="$(command -v python3 || echo /usr/bin/python3)"
STATES="$DIR/states"
CONF="$DIR/tts.conf"
mkdir -p "$STATES"
STATE="$1"
SRC="${K28_SRC:-Claude}"

conf_value() {
  awk -F= -v k="$1" '$1 == k {print substr($0, index($0, "=") + 1); exit}' "$CONF" 2>/dev/null
}

# 总闸：CodePal「会话状态」打开时写 1；为 0 时只保留 clear 能力，便于撤掉旧状态。
STATUS_LIGHT_ENABLED="$(conf_value STATUS_LIGHT_ENABLED)"
[ "$STATUS_LIGHT_ENABLED" = "0" ] && [ "$STATE" != "clear" ] && exit 0

INPUT=""
[ -t 0 ] || INPUT=$(cat)
# 一次性从 stdin 提取 4 个字段：session_id / cwd / 原始 prompt / 问题(tool_input)
META=$(printf '%s' "$INPUT" | "$PYBIN" -c "
import sys, json
def clip(s, n):
    return ' '.join((s or '').split())[:n]   # 压平空白并截断，避免 tab/换行污染
try:
    d = json.load(sys.stdin)
except Exception:
    d = {}
sid = d.get('session_id') or ''
cwd = d.get('cwd') or ''
prompt = ' '.join((d.get('prompt') or '').split())[:1200]
q = ''
ti = d.get('tool_input') or {}
qs = ti.get('questions') if isinstance(ti, dict) else None
if isinstance(qs, list) and qs and isinstance(qs[0], dict):
    q = clip(qs[0].get('question') or qs[0].get('header'), 60)
print('\t'.join([sid, cwd, prompt, q]))
" 2>/dev/null)
SID=$(printf '%s' "$META" | cut -f1)
CWD=$(printf '%s' "$META" | cut -f2)
PROMPT=$(printf '%s' "$META" | cut -f3)
QUES=$(printf '%s' "$META" | cut -f4)
[ -z "$CWD" ] && CWD="${2:-$PWD}"
NAME=$(basename "$CWD")
[ -z "$SID" ] && SID=$(printf '%s' "$CWD" | md5 -q 2>/dev/null)   # 无 session_id 时退回用 cwd
KEY=$(printf '%s' "$SID" | tr -c 'A-Za-z0-9' '_')
FILE="$STATES/$KEY.txt"
TASKFILE="$STATES/$KEY.task"
ASKFILE="$STATES/$KEY.ask"

# 防幽灵：项目名取成 "/"、"." 或空（cwd 异常）时，非 clear 一律忽略，不写灯。
if [ "$STATE" != "clear" ]; then
  case "$NAME" in /|.|"") exit 0 ;; esac
fi

# Codex Desktop 可能同时跑 ambient suggestions / title 生成等内部会话。
# 同项目真实会话开始工作时，清掉同项目同来源的旧 done，避免页面出现两个同名 session。
if [ "$STATE" = "busy" ] && [ "$SRC" = "Codex" ]; then
  for OLD in "$STATES"/*.txt; do
    [ -e "$OLD" ] || continue
    [ "$OLD" = "$FILE" ] && continue
    OLD_STATE=$(awk -F '\t' '{print $1}' "$OLD" 2>/dev/null)
    OLD_NAME=$(awk -F '\t' '{print $3}' "$OLD" 2>/dev/null)
    OLD_SRC=$(awk -F '\t' '{print $4}' "$OLD" 2>/dev/null)
    if [ "$OLD_STATE" = "done" ] && [ "$OLD_NAME" = "$NAME" ] && [ "$OLD_SRC" = "$SRC" ]; then
      rm -f "$OLD" "${OLD%.txt}.task"
    fi
  done
fi

# 写/清本窗口状态。
# Codex 的 SessionStart 常代表 subagent/新工作线程已开始运行；视觉上应按 busy 处理，但保留 idle 事件本身不播报。
# Claude 的 SessionStart（打开 / 恢复 / 压缩上下文）不代表开始干活，也不代表做完：不写，保持原状态。
WSTATE="$STATE"
if [ "$STATE" = "idle" ]; then
  if [ "$SRC" = "Codex" ]; then
    WSTATE="busy"
  else
    exit 0
  fi
fi
if [ "$STATE" = "clear" ]; then
  rm -f "$FILE" "$TASKFILE" "$ASKFILE"
else
  printf '%s\t%s\t%s\t%s\n' "$WSTATE" "$(date +%s)" "$NAME" "${K28_SRC:-Claude}" > "$FILE"
fi

# busy 时把「在干嘛」存起来：取你这句话的前 30 字（本地截断，不调模型）。
# 仅在拿到 prompt 时覆盖；PostToolUse 恢复的 busy 没有 prompt，保留原句。done 时保留，给列表和通知用。
if [ "$STATE" = "busy" ] && [ -n "$PROMPT" ]; then
  GIST=$(printf '%s' "$PROMPT" | "$PYBIN" -c "import sys; print(' '.join(sys.stdin.read().split())[:30])" 2>/dev/null)
  [ -n "$GIST" ] && printf '%s' "$GIST" > "$TASKFILE"
fi

# 「问什么」：attention 时存，离开 attention 时删
if [ "$STATE" = "attention" ]; then
  if [ -n "$QUES" ]; then printf '%s' "$QUES" > "$ASKFILE"; else rm -f "$ASKFILE"; fi
else
  rm -f "$ASKFILE"
fi

exit 0
