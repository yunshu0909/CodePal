#!/usr/bin/env bash
# codepal-script-version: __SCRIPT_VERSION__
# CodePal-managed Claude Code usage status line.
# Reads Claude Code's JSON stdin, writes a local snapshot, and prints
# a single status line based on the user's display mode.
# v4: also tracks 7d cycle peak history for 满载率趋势 feature.
# v5: also shows current context window usage (bar + percent) by parsing
#     transcript_path's last assistant usage entry.
# v6: handles Anthropic provider_reset events — when sevenDayResetsAt jumps
#     forward by < 6.5 days (non-natural shift), seal the prev window as an
#     anomaly cycle instead of a normal completed cycle, so the 满载率 metric
#     is not polluted by short partial windows.

input=$(cat)
CODEPAL_STATUS_PAYLOAD="$input" python3 - "__CONFIG_PATH__" "__SNAPSHOT_PATH__" "__HISTORY_PATH__" <<'PY'
import json
import os
import re
import sys
import tempfile
import time
from datetime import datetime

MAX_COMPLETED_CYCLES = __MAX_COMPLETED_CYCLES__

RESET = "\033[0m"
DIM = "\033[2m"
BOLD = "\033[1m"
GREEN = "\033[32m"
YELLOW = "\033[33m"
RED = "\033[31m"

DEFAULT_CONFIG = {
    "displayMode": "always",
    "fiveHourThreshold": 70,
    "sevenDayThreshold": 70,
}

config_path = sys.argv[1]
snapshot_path = sys.argv[2]
history_path = sys.argv[3] if len(sys.argv) > 3 else None
payload_raw = os.environ.get("CODEPAL_STATUS_PAYLOAD", "")

try:
    payload = json.loads(payload_raw) if payload_raw else {}
except Exception:
    payload = {}

def is_plain_object(value):
    return isinstance(value, dict)

def normalize_threshold(value, fallback):
    try:
        parsed = round(float(value))
    except Exception:
        return fallback
    return max(0, min(100, parsed))

def load_config():
    if not os.path.exists(config_path):
        return dict(DEFAULT_CONFIG)
    try:
        with open(config_path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except Exception:
        return dict(DEFAULT_CONFIG)
    if not is_plain_object(data):
        return dict(DEFAULT_CONFIG)
    display_mode = data.get("displayMode")
    if display_mode not in ("always", "threshold", "off"):
        display_mode = DEFAULT_CONFIG["displayMode"]
    return {
        "displayMode": display_mode,
        "fiveHourThreshold": normalize_threshold(data.get("fiveHourThreshold"), DEFAULT_CONFIG["fiveHourThreshold"]),
        "sevenDayThreshold": normalize_threshold(data.get("sevenDayThreshold"), DEFAULT_CONFIG["sevenDayThreshold"]),
    }

def get_value(source, *keys, default=None):
    current = source
    for key in keys:
        if not is_plain_object(current):
            return default
        current = current.get(key)
        if current is None:
            return default
    return current

def color_pct(value):
    try:
        pct = float(value)
    except Exception:
        return f"{DIM}--{RESET}"
    color = GREEN if pct < 60 else YELLOW if pct < 85 else RED
    return f"{color}{pct:.0f}%{RESET}"

def color_ctx_pct(value):
    # 上下文断点与 5h/7d 不同：≥80% 即红，因为此时 auto-compact 风险升高
    try:
        pct = float(value)
    except Exception:
        return f"{DIM}--{RESET}"
    color = GREEN if pct < 50 else YELLOW if pct < 80 else RED
    return f"{color}{pct:.0f}%{RESET}"

_ONE_M_PATTERN = re.compile(r"\b1m\b", re.IGNORECASE)

def detect_context_window(display_name, model_id):
    """
    判定当前模型的上下文窗口大小。
    - display_name 或 model_id 以独立 word 形式含 '1M' / '1m' → 1,000,000
    - 其他 → 200,000（Claude 4.x / 3.x 默认）
    用 \\b1m\\b 避免误中型号名里恰好出现 "1m" 子串的情形。
    """
    haystack = " ".join(str(x or "") for x in (display_name, model_id))
    if _ONE_M_PATTERN.search(haystack):
        return 1000000
    return 200000

# transcript 尾部读取窗口：典型单条 JSONL 条目 <2KB，256KB 足以覆盖最后几十条。
# 超长会话（几十 MB）按全文件扫描状态栏会卡顿，tail-read 把复杂度从 O(n) 降到 O(1)。
_TRANSCRIPT_TAIL_BYTES = 256 * 1024

def read_last_assistant_usage(transcript_path):
    """
    从 transcript JSONL **尾部** 反向扫描，找最后一条带 usage 的 assistant 消息。
    返回 input_tokens + cache_read + cache_creation（与 Claude Code /context 口径一致）。
    任何异常返回 None，绝不影响状态栏主流程。
    """
    if not transcript_path or not os.path.exists(transcript_path):
        return None
    try:
        size = os.path.getsize(transcript_path)
        if size <= 0:
            return None
        tail_size = min(size, _TRANSCRIPT_TAIL_BYTES)
        with open(transcript_path, "rb") as handle:
            handle.seek(size - tail_size)
            chunk = handle.read(tail_size)
        text = chunk.decode("utf-8", errors="ignore")
        lines = text.split("\n")
        # 若未读到文件开头，第一行可能是被截断的半截行，丢弃
        if size > tail_size and lines:
            lines = lines[1:]
        # 反向扫描，命中第一条（= 原顺序最后一条）即返回
        for line in reversed(lines):
            if '"usage"' not in line:
                continue
            try:
                obj = json.loads(line)
            except Exception:
                continue
            msg = obj.get("message") if isinstance(obj, dict) else None
            if not isinstance(msg, dict):
                continue
            usage = msg.get("usage")
            if not isinstance(usage, dict):
                continue
            input_tokens = usage.get("input_tokens") or 0
            cache_read = usage.get("cache_read_input_tokens") or 0
            cache_create = usage.get("cache_creation_input_tokens") or 0
            total = int(input_tokens) + int(cache_read) + int(cache_create)
            if total <= 0:
                continue
            return total
        return None
    except Exception:
        return None

def format_tokens(n):
    if n >= 1000000:
        return f"{n/1000000:.1f}M"
    if n >= 1000:
        return f"{round(n/1000)}k"
    return str(n)

def format_window(n):
    if n >= 1000000:
        return f"{n//1000000}M"
    if n >= 1000:
        return f"{n//1000}k"
    return str(n)

def render_ctx_bar(pct_value, cells=10):
    """
    用 Unicode 分数块渲染进度条（每格 8 份），低占用也能看得见。
    已填充部分按 pct 着色，未填充部分暗灰。
    """
    try:
        pct = max(0.0, min(100.0, float(pct_value)))
    except Exception:
        return f"{DIM}" + "░" * cells + f"{RESET}"
    partials = "▏▎▍▌▋▊▉█"
    total_units = cells * 8
    filled_units = int(round(pct / 100 * total_units))
    full_cells = filled_units // 8
    remainder = filled_units % 8
    bar_chars = "█" * full_cells
    if full_cells < cells and remainder > 0:
        bar_chars += partials[remainder - 1]
        empty_cells = cells - full_cells - 1
    else:
        empty_cells = cells - full_cells
    color = GREEN if pct < 50 else YELLOW if pct < 80 else RED
    return f"{color}{bar_chars}{RESET}{DIM}{'░' * empty_cells}{RESET}"

def should_render(config, five_pct, week_pct):
    if config["displayMode"] == "off":
        return False
    if config["displayMode"] == "always":
        return True
    try:
        five_match = five_pct is not None and float(five_pct) >= config["fiveHourThreshold"]
    except Exception:
        five_match = False
    try:
        week_match = week_pct is not None and float(week_pct) >= config["sevenDayThreshold"]
    except Exception:
        week_match = False
    return five_match or week_match

def write_snapshot(snapshot):
    directory = os.path.dirname(snapshot_path)
    os.makedirs(directory, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(prefix="codepal-usage-status-", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(snapshot, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.replace(tmp_path, snapshot_path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass

def load_history():
    """读取历史文件；损坏或不存在都返回干净的空结构，不抛异常影响状态栏主流程"""
    default = {"version": 1, "currentCycle": None, "completedCycles": []}
    if not history_path or not os.path.exists(history_path):
        return default
    try:
        with open(history_path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except Exception:
        return default
    if not isinstance(data, dict):
        return default
    current_cycle = data.get("currentCycle") if isinstance(data.get("currentCycle"), dict) else None
    completed = data.get("completedCycles") if isinstance(data.get("completedCycles"), list) else []
    # 过滤非法条目
    completed = [c for c in completed if isinstance(c, dict)]
    return {
        "version": 1,
        "currentCycle": current_cycle,
        "completedCycles": completed,
    }

def write_history(history):
    if not history_path:
        return
    directory = os.path.dirname(history_path)
    os.makedirs(directory, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(prefix="codepal-usage-history-", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(history, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.replace(tmp_path, history_path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass

ONE_WEEK_SECONDS = 7 * 86400
JUMP_THRESHOLD_SECONDS = int(6.5 * 86400)  # delta < 6.5 天 且 > 0 视为异常跳变


def update_history(week_pct_value, week_resets_at_value):
    """
    更新 7d 周期历史。
    - 无数据时：跳过
    - sevenDayResetsAt 与上次相同 → 同一周期，更新峰值
    - sevenDayResetsAt 前移且 delta < 6.5 天 → Anthropic provider_reset 等异常跳变，
      封存旧窗口为异常条目（periodEnd 夹到新 currentCycle 起点），新 currentCycle 的
      peak 直接用 current_pct，不继承旧 peak
    - sevenDayResetsAt 前移且 delta ≥ 6.5 天 → 正常 7d 周期完成，按 v1.4.1 逻辑封存
    - completedCycles 超过 MAX_COMPLETED_CYCLES 时裁剪最旧
    """
    if week_pct_value is None or week_resets_at_value is None:
        return
    try:
        current_resets_at = int(week_resets_at_value)
        current_pct = float(week_pct_value)
    except Exception:
        return

    history = load_history()
    prev = history.get("currentCycle")
    period_start = current_resets_at - ONE_WEEK_SECONDS

    if prev is None:
        history["currentCycle"] = {
            "periodStart": period_start,
            "sevenDayResetsAt": current_resets_at,
            "peakPercentage": current_pct,
        }
        write_history(history)
        return

    prev_resets_at = prev.get("sevenDayResetsAt")
    try:
        prev_resets_at_num = int(prev_resets_at) if prev_resets_at is not None else None
    except Exception:
        prev_resets_at_num = None

    existing_peak = prev.get("peakPercentage")
    try:
        existing_peak_num = float(existing_peak) if existing_peak is not None else 0.0
    except Exception:
        existing_peak_num = 0.0

    if prev_resets_at_num == current_resets_at:
        # 同一周期：更新峰值
        history["currentCycle"] = {
            "periodStart": prev.get("periodStart", period_start),
            "sevenDayResetsAt": current_resets_at,
            "peakPercentage": max(existing_peak_num, current_pct),
        }
        write_history(history)
        return

    delta = current_resets_at - prev_resets_at_num if prev_resets_at_num is not None else None

    # 判定异常跳变：delta 在 (0, JUMP_THRESHOLD) 之间
    is_anomaly = delta is not None and 0 < delta < JUMP_THRESHOLD_SECONDS

    if is_anomaly:
        sealed = {
            "periodStart": prev.get("periodStart", current_resets_at - 14 * 86400),
            "periodEnd": period_start,  # 夹到新 current 起点，避免重叠
            "peakPercentage": existing_peak_num,
            "anomaly": True,
            "anomalyReason": "provider_reset",
        }
    else:
        sealed = {
            "periodStart": prev.get("periodStart", current_resets_at - 14 * 86400),
            "periodEnd": prev_resets_at_num if prev_resets_at_num is not None else current_resets_at,
            "peakPercentage": existing_peak_num,
        }

    completed = history.get("completedCycles", [])
    completed.insert(0, sealed)
    if len(completed) > MAX_COMPLETED_CYCLES:
        completed = completed[:MAX_COMPLETED_CYCLES]
    history["completedCycles"] = completed
    history["currentCycle"] = {
        "periodStart": period_start,
        "sevenDayResetsAt": current_resets_at,
        "peakPercentage": current_pct,  # 异常/正常都用真实新 peak，不继承
    }

    write_history(history)

config = load_config()
model = get_value(payload, "model", "display_name", default="Claude Code")
model_id = get_value(payload, "model", "id")
transcript_path = get_value(payload, "transcript_path")
five_pct = get_value(payload, "rate_limits", "five_hour", "used_percentage")
week_pct = get_value(payload, "rate_limits", "seven_day", "used_percentage")
resets_at = get_value(payload, "rate_limits", "five_hour", "resets_at")
week_resets_at = get_value(payload, "rate_limits", "seven_day", "resets_at")

# v5: 计算当前上下文占用（与 rate_limits 无关，任何模式下都算）
context_window = detect_context_window(model, model_id)
context_tokens = read_last_assistant_usage(transcript_path)
context_pct = None
if context_tokens is not None and context_window > 0:
    context_pct = round(context_tokens / context_window * 100, 1)

# 初次启动：payload 里没有 rate_limits 字段，说明还没产生过真实 API 响应，
# 不写快照、不输出状态行，静默退出等待首次对话。
if "rate_limits" not in payload and five_pct is None and week_pct is None:
    raise SystemExit(0)

snapshot = {
    "source": "codepal-claude-statusline",
    "modelDisplayName": model,
    "fiveHourUsedPercentage": five_pct,
    "sevenDayUsedPercentage": week_pct,
    "resetsAt": resets_at,
    "sevenDayResetsAt": week_resets_at,
    "displayMode": config["displayMode"],
    "fiveHourThreshold": config["fiveHourThreshold"],
    "sevenDayThreshold": config["sevenDayThreshold"],
    "hasRateLimits": five_pct is not None or week_pct is not None,
    "contextTokens": context_tokens,
    "contextWindow": context_window,
    "contextUsedPercentage": context_pct,
    "updatedAt": int(time.time()),
}
write_snapshot(snapshot)

# v4: 写入 7d 周期历史（与 displayMode 无关，off 模式也要记）
update_history(week_pct, week_resets_at)

if not should_render(config, five_pct, week_pct):
    raise SystemExit(0)

sep = f"{DIM} | {RESET}"
line = f"{BOLD}{model}{RESET}"

if five_pct is None and week_pct is None:
    # v1.3.4: 针对非 Max 订阅 / 第三方后端 的账号(payload 里没有 rate_limits 字段),
    # 输出明确提示替代原来的 "usage data pending",避免用户误以为是 bug。
    # 前端通过 snapshot.updatedAt 做同样的"首次等待 vs 账号无数据"区分。
    print(f"{line}{sep}{YELLOW}no rate limits{RESET}{DIM} (非 Max 订阅或第三方后端){RESET}")
    raise SystemExit(0)

parts = []
# v5: 上下文占用（无 label，左边 "(1M context)" 已点名）
if context_pct is not None and context_tokens is not None:
    parts.append(f"{render_ctx_bar(context_pct)} {color_ctx_pct(context_pct)}")
parts.append(f"5h:{color_pct(five_pct)}" if five_pct is not None else f"{DIM}5h:--{RESET}")
parts.append(f"7d:{color_pct(week_pct)}" if week_pct is not None else f"{DIM}7d:--{RESET}")

if resets_at is not None:
    try:
        reset_dt = datetime.fromtimestamp(int(resets_at))
        now_dt = datetime.now()
        remaining_seconds = max(0, int((reset_dt - now_dt).total_seconds()))
        hours, remainder = divmod(remaining_seconds, 3600)
        minutes = remainder // 60
        reset_local = reset_dt.strftime("%H:%M")
        if hours > 0:
            reset_display = f"in {hours}h {minutes:02d}m"
        else:
            reset_display = f"in {minutes}m"
        parts.append(f"{DIM}resets {reset_display} ({reset_local}){RESET}")
    except Exception:
        pass

print(f"{line}{sep}" + f"{sep}".join(parts))
PY
