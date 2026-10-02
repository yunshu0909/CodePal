#!/usr/bin/env python3
"""协议检查：AGENTS.md 与 CLAUDE.md 全文一致、写到的路径存在、体积不超预算。

用法：python3 docs/protocol-check.py（在哪个目录跑都行，按脚本位置找项目根）
有 ERROR 返回 1；WARN 只提醒（例如点名的 skill 本机没装，或路径是还没建的计划位置）。
只用标准库。
"""

import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FILES = ("AGENTS.md", "CLAUDE.md")
SIZE_LIMIT = 20 * 1024          # 本文预算
CODEX_LIMIT = 32 * 1024         # Codex 默认只读前 32KB
CODE_SPAN = re.compile(r"`([^`\n]+)`")
# 不当路径看的写法：占位、通配、命令、链接、只有扩展名
NOT_PATH = re.compile(r"[<>{}()*|\s→]|YYYY|://|^\.\w+$|^--")
SKILL = re.compile(r"`(dev-workflow:[\w-]+)`")


def read(name):
    path = os.path.join(ROOT, name)
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as f:
        return f.read()


def path_tokens(text):
    for tok in CODE_SPAN.findall(text):
        tok = tok.strip()
        if NOT_PATH.search(tok):
            continue
        if "/" in tok or re.search(r"\.(md|json|py|html|txt)$", tok):
            yield tok.rstrip("/")


def skill_installed(name):
    """装了 dev-workflow 插件时，skill 会出现在 Claude 或 Codex 的本机目录里；只做提醒用。"""
    short = name.split(":", 1)[1]
    home = os.path.expanduser("~")
    for base in (os.path.join(home, ".claude"), os.path.join(home, ".codex")):
        for dirpath, dirnames, _ in os.walk(base):
            if short in dirnames:
                return True
            if dirpath.count(os.sep) - base.count(os.sep) > 6:
                dirnames[:] = []
    return False


def main():
    errors, warns, infos = [], [], []
    texts = {name: read(name) for name in FILES}
    missing = [n for n, t in texts.items() if t is None]
    if missing:
        errors.append(f"缺少协议文件：{', '.join(missing)}")
    if not missing and texts["AGENTS.md"] != texts["CLAUDE.md"]:
        errors.append("AGENTS.md 与 CLAUDE.md 不一致：改一份必须同步另一份")

    text = texts.get("CLAUDE.md") or texts.get("AGENTS.md") or ""
    if text:
        size = len(text.encode("utf-8"))
        infos.append(f"{size} 字节，预算 {SIZE_LIMIT}，Codex 上限 {CODEX_LIMIT}")
        if size > CODEX_LIMIT:
            errors.append(f"协议 {size} 字节，超过 Codex 默认只读的 {CODEX_LIMIT} 字节")
        elif size > SIZE_LIMIT:
            warns.append(f"协议 {size} 字节，超过预算 {SIZE_LIMIT}：把细则挪去正本，这里只写去哪找")

        for tok in sorted(set(path_tokens(text))):
            if not os.path.exists(os.path.join(ROOT, tok)):
                warns.append(f"写到的路径不存在：{tok}")

        for name in sorted(set(SKILL.findall(text))):
            if not skill_installed(name):
                warns.append(f"本机没找到 {name}：没装 dev-workflow 时照协议手工走")

        if "（待填" in text:
            infos.append("还有「（待填）」的地方：第一次对话时和 AI 一起填")

    for e in errors:
        print(f"ERROR {e}")
    for w in warns:
        print(f"WARN  {w}")
    for i in infos:
        print(f"INFO  {i}")
    print(f"结果：ERROR {len(errors)}，WARN {len(warns)}")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
