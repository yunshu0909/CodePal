#!/usr/bin/env python3
"""
豆包 TTS 播报模块 (V3 / API Key)

负责：
- 读取 tts.conf 火山豆包 API Key 凭据
- 经火山「豆包语音合成大模型」V3 单向流式 HTTP 接口把文本合成为 mp3
- 按 (音色+文本) 缓存音频，命中直接 afplay，不重复请求、不重复消耗额度
- 豆包默认最多等待 30 秒，可由 tts.conf 的 TTS_TIMEOUT_SECONDS 调整；失败静默跳过

鉴权（已实测打通，新版控制台）：请求头
    X-Api-Key:        <API Key>
    X-Api-Resource-Id:<资源 id, 1.0音色=seed-tts-1.0 / 2.0音色=seed-tts-2.0>

用法: tts_say.py "要播报的文本"

@module k28-status-light/tts_say
"""
import sys
import os
import json
import base64
import hashlib
import uuid
import subprocess
import urllib.request
import urllib.error
import fcntl

DIR = os.path.dirname(os.path.abspath(__file__))
CONF = os.path.join(DIR, "tts.conf")
CACHE = os.path.join(DIR, "tts_cache")
LOCK = os.path.join(DIR, ".tts.lock")
LOG = os.path.join(DIR, "tts-debug.log")
API = "https://openspeech.bytedance.com/api/v3/tts/unidirectional"
STRICT = os.environ.get("K28_TTS_STRICT") == "1"
LAST_SYNTH_ERROR = ""


def log(msg):
    """追加 TTS 调试日志；失败不影响播报。"""
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(msg + "\n")
    except Exception:
        pass


def fail(reason):
    """Hook 默认静默失败；CodePal 测试模式下把失败暴露给页面。"""
    log(reason)
    if STRICT:
        print(reason, file=sys.stderr)
        sys.exit(1)


def load_conf():
    """读取 KEY=VALUE 形式的 tts.conf，返回 dict（缺文件返回空 dict）"""
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
    return cfg


def ensure_local_output(cfg):
    """
    保证播报从本机扬声器出，而不是 K28（K28 只当显示屏，不当音箱）。
    若默认输出被 macOS 自动切到了 K28，就强制切回本机扬声器。
    依赖 SwitchAudioSource（switchaudio-osx）；未安装则静默跳过，不影响播报。
    """
    target = cfg.get("OUTPUT_DEVICE") or "MacBook Air扬声器"
    try:
        cur = subprocess.run(
            ["SwitchAudioSource", "-c"],
            capture_output=True, text=True, timeout=2,
        ).stdout
    except (FileNotFoundError, subprocess.SubprocessError):
        return  # 没装工具 → 跳过（多数情况下默认输出本就是本机，无碍）
    # 仅当当前输出是 K28 时才纠正，避免无谓地动用户的输出选择
    if "K28" in cur:
        subprocess.run(
            ["SwitchAudioSource", "-s", target],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )


def play_audio(path):
    """使用系统 afplay 直接播放豆包原始音频。"""
    return subprocess.run(
        ["afplay", path],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def _collect_audio(raw):
    """
    解析 V3 单向流式响应：响应体是若干 JSON 事件（可能首尾相连），
    每个事件里可能带 base64 音频。逐个 raw_decode，把所有音频片段解码拼接。
    返回 mp3 字节；解析不到音频返回 None。
    """
    text = raw.decode("utf-8", "ignore").strip()
    dec = json.JSONDecoder()
    chunks = []
    i, n = 0, len(text)
    while i < n:
        while i < n and text[i] in " \r\n\t":
            i += 1
        if i >= n:
            break
        try:
            obj, end = dec.raw_decode(text, i)
        except ValueError:
            break
        i = end
        # 业务错误：header.code 或顶层 code 非 0 视为失败
        if isinstance(obj, dict):
            hdr = obj.get("header")
            codes = []
            if isinstance(hdr, dict):
                codes.append(hdr.get("code"))
            codes.append(obj.get("code"))
            if any(c not in (None, 0, 20000000) for c in codes):
                return None
        # 音频字段在不同版本里可能叫 data / audio
        for key in ("data", "audio"):
            val = obj.get(key) if isinstance(obj, dict) else None
            if isinstance(val, str) and val:
                try:
                    chunks.append(base64.b64decode(val))
                except Exception:
                    pass
    return b"".join(chunks) if chunks else None


def synth(text, cfg):
    """调用豆包 V3 TTS 合成并返回 mp3 字节；失败返回 None。"""
    global LAST_SYNTH_ERROR
    LAST_SYNTH_ERROR = ""
    try:
        timeout = max(3, min(60, int(float(cfg.get("TTS_TIMEOUT_SECONDS") or 30))))
    except ValueError:
        timeout = 30
    body = {
        "user": {"uid": "k28-status-light"},
        "req_params": {
            "text": text,
            "speaker": cfg["VOLC_SPEAKER"],
            "audio_params": {
                "format": "mp3",
                "sample_rate": 24000,
                "speech_rate": int((float(cfg.get("VOLC_SPEED") or 1.0) - 1.0) * 100),
            },
        },
    }
    req = urllib.request.Request(
        API,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "X-Api-Key": cfg["VOLC_API_KEY"],
            "X-Api-Resource-Id": cfg.get("VOLC_RESOURCE_ID") or "seed-tts-1.0",
            "X-Api-Request-Id": str(uuid.uuid4()),
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return _collect_audio(resp.read())
    except urllib.error.HTTPError as e:
        # 鉴权/授权错误等，读出来便于排查；不回退系统 say，避免突然冒出 macOS 原声。
        try:
            detail = e.read().decode("utf-8", "ignore").strip()[:500]
        except Exception:
            detail = ""
        log(f"synth_http_error status={getattr(e, 'code', '')} body={detail}")
        LAST_SYNTH_ERROR = f"豆包 TTS 鉴权失败，HTTP {getattr(e, 'code', '')}。请检查 VOLC_API_KEY 是否有效，以及资源 ID 是否有 seed-tts 权限。"
        return None
    except (urllib.error.URLError, TimeoutError, ValueError) as e:
        log(f"synth_error type={type(e).__name__} msg={e}")
        LAST_SYNTH_ERROR = f"豆包 TTS 请求失败：{type(e).__name__}"
        return None


def main():
    text = ""
    if len(sys.argv) > 2 and sys.argv[1] == "--file":
        try:
            with open(sys.argv[2], encoding="utf-8") as f:
                text = f.read()
            os.unlink(sys.argv[2])
        except Exception as e:
            log(f"read_text_file_error type={type(e).__name__} msg={e}")
            text = ""
    elif len(sys.argv) > 1:
        text = sys.argv[1]
    if not text:
        fail("skip_empty_text")
        return
    cfg = load_conf()

    os.makedirs(CACHE, exist_ok=True)
    log(f"start pid={os.getpid()} text={text[:80]}")
    with open(LOCK, "w") as lock:
        # Claude/Codex hooks 会并发触发；串行化可避免 afplay 叠音和先完成的 TTS 抢先播。
        fcntl.flock(lock, fcntl.LOCK_EX)
        log(f"lock_acquired pid={os.getpid()}")

        # 播报前确保走本机扬声器，别从 K28 出声（K28 只当显示屏）
        ensure_local_output(cfg)

        # 凭据不全时静默失败，避免突然冒出 macOS 原声。
        if not all(cfg.get(k) for k in ("VOLC_API_KEY", "VOLC_SPEAKER")):
            fail("skip_missing_config")
            return

        # 缓存键 = 音色 + 文本（换音色自动重新生成）
        key = hashlib.md5((cfg["VOLC_SPEAKER"] + "|" + text).encode("utf-8")).hexdigest()
        path = os.path.join(CACHE, key + ".mp3")

        if not os.path.exists(path):
            log(f"cache_miss path={path}")
            audio = synth(text, cfg)
            if not audio:
                fail(LAST_SYNTH_ERROR or "skip_synth_failed")
                return
            with open(path, "wb") as f:
                f.write(audio)
            log(f"cache_write bytes={len(audio)} path={path}")
        else:
            log(f"cache_hit path={path}")

        result = play_audio(path)
        log(f"afplay_exit code={result.returncode} path={path}")
        if result.returncode != 0:
            fail(f"afplay_exit code={result.returncode}")


if __name__ == "__main__":
    main()
