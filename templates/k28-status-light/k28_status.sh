#!/bin/bash
# K28 多项目状态灯 + 语音：写本窗口状态 → 渲染所有窗口 → 播报。后台执行，不阻塞。
# 全局工具，对所有项目生效。用法: k28_status.sh <busy|done|attention|idle|clear>
#
# 来源标记：环境变量 K28_SRC（默认 Claude）。Codex 路径在 codex-hook.sh / codex-notify.sh
#   里设 K28_SRC=Codex，于是播报会说"Claude 的 X"还是"Codex 的 X"，多窗口并行时能分辨是谁。
#
# hook 从 stdin 传入 JSON：
#   - session_id 作窗口唯一标识（一个窗口=一盏灯，bash 切目录不影响）；cwd 文件夹名作项目名
#   - busy(UserPromptSubmit) 带 prompt → 取"在干嘛"摘要；attention(AskUserQuestion) 带 tool_input → 取"问什么"
#   - 任务摘要在 busy 时存进 <key>.task，done 时复用，精准对应"做完了啥"，无需解析对话/调模型
DIR="$HOME/.claude/k28-status-light"
PYBIN="$DIR/.venv/bin/python"
STATES="$DIR/states"
CONF="$DIR/tts.conf"
mkdir -p "$STATES"
STATE="$1"
SRC="${K28_SRC:-Claude}"

conf_value() {
  awk -F= -v k="$1" '$1 == k {print substr($0, index($0, "=") + 1); exit}' "$CONF" 2>/dev/null
}

# CodePal 控制台会写入这两个开关。总开关关闭时保留 clear 能力，便于撤掉旧状态。
STATUS_LIGHT_ENABLED="$(conf_value STATUS_LIGHT_ENABLED)"
VOICE_ENABLED="$(conf_value VOICE_ENABLED)"
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
    q = clip(qs[0].get('header') or qs[0].get('question'), 18)
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

# 写/清本窗口状态。idle(开窗)=绿灯但不播报。
WSTATE="$STATE"
[ "$STATE" = "idle" ] && WSTATE="done"
if [ "$STATE" = "clear" ]; then
  rm -f "$FILE" "$TASKFILE"
else
  printf '%s\t%s\t%s\t%s\n' "$WSTATE" "$(date +%s)" "$NAME" "${K28_SRC:-Claude}" > "$FILE"
fi

# busy 时把任务摘要存起来（仅在拿到 prompt 时覆盖；PostToolUse 恢复的 busy 无 prompt，保留原摘要）
GIST=""
if [ "$STATE" = "busy" ] && [ -n "$PROMPT" ]; then
  GIST=$(printf '%s' "$PROMPT" | "$PYBIN" "$DIR/summarize_task.py" 2>/dev/null)
  [ -z "$GIST" ] && GIST=$(printf '%s' "$PROMPT" | "$PYBIN" -c "import sys; print(' '.join(sys.stdin.read().split())[:18])" 2>/dev/null)
  [ -n "$GIST" ] && printf '%s' "$GIST" > "$TASKFILE"
elif [ -f "$TASKFILE" ]; then
  GIST=$(cat "$TASKFILE" 2>/dev/null)
fi

# 渲染所有在跑窗口（后台，内部文件锁串行）
nohup "$PYBIN" "$DIR/k28_render.py" >/dev/null 2>&1 &

# 语音播报：来源 + 项目名 + 具体内容（豆包柔美女友；失败静默跳过，不回退系统原声；clear/idle 不播）
VOICE=""
case "$STATE" in
  busy)
    if [ -n "$GIST" ]; then VOICE="${SRC} 的 ${NAME}，开始 ${GIST}"; else VOICE="${SRC} 的 ${NAME} 开始干活"; fi ;;
  done)
    TASK=""; [ -f "$TASKFILE" ] && TASK=$(cat "$TASKFILE" 2>/dev/null); rm -f "$TASKFILE"
    if [ -n "$TASK" ]; then VOICE="${SRC} 的 ${NAME}，${TASK} 完成啦"; else VOICE="${SRC} 的 ${NAME} 完成啦"; fi ;;
  attention)
    if [ -n "$QUES" ]; then VOICE="${SRC} 的 ${NAME} 想问你，${QUES}"; else VOICE="${SRC} 的 ${NAME} 需要你做个选择"; fi ;;
esac
if [ -n "$VOICE" ] && [ "$VOICE_ENABLED" != "0" ]; then
  # Codex/Claude hooks may reap background children after the hook exits.
  # Submit TTS to the per-user launchd instead, so long first-time synth can finish.
  # launchctl mangles non-ASCII argv on this system, so pass voice text via a UTF-8 file.
  JOBDIR="$DIR/tts_jobs"
  mkdir -p "$JOBDIR"
  VOICEFILE="$JOBDIR/$(date +%s).$$.$RANDOM.txt"
  printf '%s' "$VOICE" > "$VOICEFILE"
  LABEL="com.yunshu.k28.tts.$(date +%s).$$.$RANDOM"
  launchctl submit -l "$LABEL" -- /bin/bash "$DIR/tts_launchd_job.sh" "$LABEL" "$PYBIN" "$DIR/tts_say.py" "$VOICEFILE" >/dev/null 2>&1 ||
    nohup "$PYBIN" "$DIR/tts_say.py" --file "$VOICEFILE" >/dev/null 2>&1 &
fi

exit 0
