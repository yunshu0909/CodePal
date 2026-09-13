#!/usr/bin/env bash
# codepal-script-version: __SCRIPT_VERSION__
# CodePal-managed Claude Code usage status line.
# Reads Claude Code's JSON stdin, writes a local snapshot, and prints
# a single status line based on the user's display mode.
# v5: also shows current context window usage (bar + percent) by parsing
#     transcript_path's last assistant usage entry.
# v7: appends a second line with Git info (git:<branch>@<nearest-tag><dirty>)
#     for the cwd's repo. Coupled to the usage line: only emitted when the
#     usage/no-rate-limits first line is printed. All git calls are read-only
#     with a 1.0s timeout each; any failure silently drops the second line so
#     the status line never breaks.
# v8: stops collecting the retired 7d peak-history metric.
# v9: prefers the statusLine payload's authoritative `context_window`
#     (context_window_size / used_percentage) over guessing the window from
#     the model name; the transcript + name heuristic is now only a fallback
#     for older Claude Code builds that do not send that field.

input=$(cat)
CODEPAL_STATUS_PAYLOAD="$input" python3 - "__CONFIG_PATH__" "__SNAPSHOT_PATH__" <<'PY'
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from datetime import datetime

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
    判定当前模型的上下文窗口大小（**v9 起仅作老版本 Claude Code 的回退**）：
    当前版本 Claude Code 会在 payload 里直接给出 context_window，优先用它。
    - display_name 或 model_id 以独立 word 形式含 '1M' / '1m' → 1,000,000
    - 其他 → 200,000（Claude 4.x / 3.x 默认）
    用 \\b1m\\b 避免误中型号名里恰好出现 "1m" 子串的情形。
    注意：原生 1M 模型（如 Opus 5）的名字里没有 "(1M context)" 后缀，
    这个名字启发式必然看不到 1M —— 这正是 v9 改用 payload 的原因。
    """
    haystack = " ".join(str(x or "") for x in (display_name, model_id))
    if _ONE_M_PATTERN.search(haystack):
        return 1000000
    return 200000

def read_payload_context(payload):
    """
    读取 statusLine stdin 的 context_window（Claude Code 2.x 提供）：
    {total_input_tokens, total_output_tokens, context_window_size,
     current_usage, used_percentage, remaining_percentage}
    - context_window_size 是 Claude Code 自己解析出的真实窗口（含原生 1M 模型），
      比按模型名猜的 200k 兜底可靠；
    - used_percentage 与官方 /context 口径一致：
      round((input_tokens + cache_read + cache_creation) / context_window_size * 100)。
    返回 (window, tokens, pct)；字段缺失 / 类型不对一律 None，由调用方回退。
    只读取叶子标量，绝不把 payload 整体带出去。
    """
    window = None
    tokens = None
    pct = None
    cw = payload.get("context_window") if is_plain_object(payload) else None
    if is_plain_object(cw):
        raw_window = cw.get("context_window_size")
        if isinstance(raw_window, (int, float)) and not isinstance(raw_window, bool) and int(raw_window) > 0:
            window = int(raw_window)
            raw_tokens = cw.get("total_input_tokens")
            if isinstance(raw_tokens, (int, float)) and not isinstance(raw_tokens, bool) and int(raw_tokens) > 0:
                tokens = int(raw_tokens)
            raw_pct = cw.get("used_percentage")
            if isinstance(raw_pct, (int, float)) and not isinstance(raw_pct, bool) and raw_pct >= 0:
                pct = float(raw_pct)
    return window, tokens, pct

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

_GIT_TIMEOUT = 1.0  # v7: 每个 git 子命令超时上限（秒），冻结值见 PRD V1.6.5

def _git_capture(cwd, args):
    """
    在 cwd 下跑只读 git 子命令，最多 _GIT_TIMEOUT 秒。
    返回 (returncode, stdout_str)；任何异常（git 不在 PATH / 超时 / 非法路径 /
    非 UTF-8 输出）都收敛为 (None, "")，绝不抛出影响状态栏主流程。
    """
    try:
        proc = subprocess.run(
            ["git", "-C", cwd] + args,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=_GIT_TIMEOUT,
        )
        return proc.returncode, proc.stdout.decode("utf-8", "ignore")
    except Exception:
        return None, ""

def compute_git_line(payload):
    """
    计算 statusLine 第二行的 Git 信息：git:<分支>@<最近tag><脏标记>。
    - cwd 取 workspace.current_dir，回退顶层 cwd；非字符串/缺失 → None
    - 分支为必要段：取不到（非 git / git 不可用 / 超时）→ 整行 None
    - HEAD 游离 → 退化为 git rev-parse --short HEAD 的短 sha
    - tag / 脏 为 best-effort 段：各自失败仅省略该段
    - 整体异常兜底：任何未预期异常 → None（绝不让状态栏报错）
    任何分支都不会抛异常。
    """
    try:
        cwd = get_value(payload, "workspace", "current_dir")
        if not isinstance(cwd, str) or not cwd:
            cwd = get_value(payload, "cwd")
        if not isinstance(cwd, str) or not cwd:
            return None

        # 分支段（必要）：HEAD 游离时退化为短 sha
        rc, out = _git_capture(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])
        if rc != 0:
            return None
        branch = out.strip()
        if not branch:
            return None
        if branch == "HEAD":
            rc2, out2 = _git_capture(cwd, ["rev-parse", "--short", "HEAD"])
            short_sha = out2.strip() if rc2 == 0 else ""
            if not short_sha:
                return None
            branch = short_sha

        # tag 段（best-effort）：只取最近 tag，不带偏移后缀
        tag = ""
        rct, outt = _git_capture(cwd, ["describe", "--tags", "--abbrev=0"])
        if rct == 0:
            tag = outt.strip()

        # 脏段（best-effort）：porcelain 非空即脏（含未跟踪）
        dirty = False
        rcd, outd = _git_capture(cwd, ["status", "--porcelain"])
        if rcd == 0 and outd.strip():
            dirty = True

        # v7: 纯文本一行，不加任何 ANSI 颜色。脏(*)是开发常态、非告警，
        # 不用红（红是额度行的告警色，用在常态上是假警报）；也不 DIM 弱化。
        return "git:" + branch + (("@" + tag) if tag else "") + ("*" if dirty else "")
    except Exception:
        return None

config = load_config()
model = get_value(payload, "model", "display_name", default="Claude Code")
model_id = get_value(payload, "model", "id")
transcript_path = get_value(payload, "transcript_path")
five_pct = get_value(payload, "rate_limits", "five_hour", "used_percentage")
week_pct = get_value(payload, "rate_limits", "seven_day", "used_percentage")
resets_at = get_value(payload, "rate_limits", "five_hour", "resets_at")
week_resets_at = get_value(payload, "rate_limits", "seven_day", "resets_at")

# v5: 计算当前上下文占用（与 rate_limits 无关，任何模式下都算）
# v9: 优先用 payload 的权威 context_window（窗口由 Claude Code 自己解析，
#     原生 1M 模型不再被按 200k 误算）；没有该字段的老版本才回退
#     transcript 尾部 + 模型名启发式。两条路径不混用，避免新旧口径拼接。
payload_window, payload_tokens, payload_pct = read_payload_context(payload)
if payload_window is not None:
    context_window = payload_window
    context_tokens = payload_tokens
    context_pct = round(payload_pct, 1) if payload_pct is not None else None
else:
    context_window = detect_context_window(model, model_id)
    context_tokens = read_last_assistant_usage(transcript_path)
    if context_tokens is not None and context_window > 0:
        context_pct = round(context_tokens / context_window * 100, 1)
    else:
        context_pct = None

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

if not should_render(config, five_pct, week_pct):
    raise SystemExit(0)

sep = f"{DIM} | {RESET}"
line = f"{BOLD}{model}{RESET}"

if five_pct is None and week_pct is None:
    # v1.3.4: 针对非 Max 订阅 / 第三方后端 的账号(payload 里没有 rate_limits 字段),
    # 输出明确提示替代原来的 "usage data pending",避免用户误以为是 bug。
    # 前端通过 snapshot.updatedAt 做同样的"首次等待 vs 账号无数据"区分。
    print(f"{line}{sep}{YELLOW}no rate limits{RESET}{DIM} (非 Max 订阅或第三方后端){RESET}")
    # v7: no rate limits 仍算"有第一行"，在其下方追加 git 第二行（耦合：此分支已打印第一行）
    git_line = compute_git_line(payload)
    if git_line is not None:
        print(git_line)
    raise SystemExit(0)

parts = []
# v5: 上下文占用（无 label，左边 "(1M context)" 已点名）
# v9: 判据只看 context_pct —— payload 路径可能已知比例但没有 token 数
if context_pct is not None:
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
# v7: 额度第一行已打印，追加 git 第二行（耦合：off/阈值/首启已在上方 SystemExit 退出，不会到这）
git_line = compute_git_line(payload)
if git_line is not None:
    print(git_line)
PY
