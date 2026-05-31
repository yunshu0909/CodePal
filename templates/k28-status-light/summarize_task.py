#!/usr/bin/env python3
"""
K28 状态灯任务摘要模块

负责：
- 从 hook prompt 中提炼适合语音播报的短任务名
- 有 DeepSeek API Key 时调用便宜非 thinking 模型压缩
- 模型失败、超时、未配置时回退本地截断
- 按原始 prompt 缓存摘要，避免重复调用模型

@module k28-status-light/summarize_task
"""
import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.request

DIR = os.path.dirname(os.path.abspath(__file__))
CONF = os.path.join(DIR, "tts.conf")
CACHE = os.path.join(DIR, "summary_cache")
LOG = os.path.join(DIR, "summary-debug.log")
DEFAULT_BASE_URL = "https://api.deepseek.com"
VERSION = "v3"


def log(msg):
    """追加摘要调试日志；失败不影响主流程。"""
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(msg + "\n")
    except Exception:
        pass


def load_conf():
    """读取 KEY=VALUE 配置，返回 dict；环境变量可覆盖同名项。"""
    cfg = {}
    try:
        with open(CONF, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                cfg[k.strip()] = v.strip()
    except FileNotFoundError:
        pass
    for key in ("DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "TASK_SUMMARY_MODEL", "TASK_SUMMARY_ENABLED"):
        if os.environ.get(key):
            cfg[key] = os.environ[key]
    return cfg


def fallback(text, limit=18):
    """本地兜底：压平空白、去掉口语前缀，并对高频任务做轻量归纳。"""
    text = re.sub(r"```.*?```", " ", text or "", flags=re.S)
    text = re.sub(r"[#>*_`~-]+", " ", text)
    text = " ".join(text.split())
    if not text:
        return ""
    rules = [
        (("语音", "播报"), "修复语音播报"),
        (("没播报",), "修复语音播报"),
        (("不播报",), "修复语音播报"),
        (("测试进程",), "清理测试进程"),
        (("多余", "进程"), "清理测试进程"),
        (("任务", "压缩"), "优化任务摘要"),
        (("提示词", "便宜模型"), "优化任务摘要"),
        (("摘要", "模型"), "优化任务摘要"),
        (("状态灯", "Codex"), "调整状态灯"),
        (("状态灯", "Claude"), "调整状态灯"),
    ]
    for needles, summary in rules:
        if all(needle in text for needle in needles):
            return summary
    text = re.sub(r"^(你|请|麻烦)?(能不能|可以)?(帮我|帮忙|把|给我|现在|再)?", "", text)
    text = re.sub(r"^(看一下|看看|处理一下|搞一下|弄一下)", "", text)
    text = text.strip(" ，。！？,.!?:：；;、")
    return text[:limit]


def clean_summary(text):
    """清理模型输出，保证只有短摘要，没有引号、标点堆叠或解释。"""
    text = " ".join((text or "").strip().split())
    text = text.strip("「」『』“”\"'`，。！？,.!?:：；;、 ")
    text = re.sub(r"^(任务|摘要|标题)[:：]\s*", "", text)
    return text[:12]


def summarize_deepseek(prompt, cfg):
    """调用 DeepSeek 非 thinking 模型生成短任务名；失败返回空字符串。"""
    api_key = cfg.get("DEEPSEEK_API_KEY")
    if not api_key:
        return ""
    model = cfg.get("TASK_SUMMARY_MODEL") or "deepseek-v4-flash"
    base_url = (cfg.get("DEEPSEEK_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")
    url = base_url + "/chat/completions"
    body = {
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": (
                    "你是状态灯语音播报的任务压缩器。"
                    "把用户给 AI 的任务压成中文短任务名，4到8个汉字最佳，最多12个字。"
                    "只输出短任务名，不要解释，不要标点，不要称呼。"
                    "保留动作和对象，例如：修复语音、整理周报、排查蓝牙、改登录样式。"
                ),
            },
            {
                "role": "user",
                "content": prompt[:1200],
            },
        ],
        "thinking": {"type": "disabled"},
        "temperature": 0,
        "max_tokens": 24,
        "stream": False,
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=2.5) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        content = (((data.get("choices") or [{}])[0].get("message") or {}).get("content") or "")
        summary = clean_summary(content)
        if not summary:
            log(f"deepseek_empty_content keys={list(data.keys())} model={model}")
        return summary
    except urllib.error.HTTPError as e:
        log(f"deepseek_http_error status={getattr(e, 'code', '')} model={model}")
    except Exception as e:
        log(f"deepseek_error type={type(e).__name__} msg={e}")
    return ""


def main():
    prompt = sys.stdin.read()
    if not prompt.strip():
        return
    cfg = load_conf()
    if cfg.get("TASK_SUMMARY_ENABLED", "1") in ("0", "false", "False", "no"):
        print(fallback(prompt))
        return

    os.makedirs(CACHE, exist_ok=True)
    model = cfg.get("TASK_SUMMARY_MODEL") or "deepseek-v4-flash"
    key = hashlib.md5((VERSION + "|" + model + "|" + prompt).encode("utf-8")).hexdigest()
    path = os.path.join(CACHE, key + ".txt")
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as f:
                cached = f.read().strip()
            if cached:
                print(cached)
                return
        except Exception:
            pass

    summary = summarize_deepseek(prompt, cfg) or fallback(prompt)
    with open(path, "w", encoding="utf-8") as f:
        f.write(summary)
    print(summary)


if __name__ == "__main__":
    main()
