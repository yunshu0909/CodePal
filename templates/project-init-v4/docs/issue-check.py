#!/usr/bin/env python3
"""Issue 池工具：从 issues/ 下的单条文件生成总览 ISSUES.md，并负责新建、改字段、关闭、重开与校验。

规则正本在 issues/README.md。只用标准库；按脚本自身位置找项目根，不依赖当前目录。

命令：
  build                 从各条 frontmatter 生成 ISSUES.md（总览被手改过时拒绝，--force 覆盖）
  check                 校验；有错误返回 1
  new 标题 [--short 短名] [--status idea] [--parent N] [--summary ..] [--next ..] [--blocked-by ..]
  set N 键=值 ...        改 frontmatter 字段（status 只能在未关闭的四个值之间改；关闭用 close）
  close N done|dropped [--date YYYY-MM-DD]
  reopen N [--status doing]
  export                把 issues/ 当前内容拼成单文件快照输出（有历史文件的条目会把主文件和历史拼在一起，有重复）；
"""

import argparse
import datetime
import fcntl
import hashlib
import os
import re
import sys
import time
import urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ISSUES_DIR = os.path.join(ROOT, "issues")
OVERVIEW = os.path.join(ROOT, "ISSUES.md")
TEMPLATE = os.path.join(ISSUES_DIR, "_模板.md")
INBOX = os.path.join(ISSUES_DIR, "收件箱.md")
LOCK = os.path.join(ISSUES_DIR, ".lock")

OPEN_DIR, DONE_DIR, DROP_DIR = "未关闭", "已完成", "已作废"
OPEN_STATUSES = ("idea", "pending", "ready", "doing")
STATUS_DIR = {"idea": OPEN_DIR, "pending": OPEN_DIR, "ready": OPEN_DIR, "doing": OPEN_DIR,
              "done": DONE_DIR, "dropped": DROP_DIR}
STATUS_ICON = {"idea": "💭", "pending": "⏸", "ready": "📋", "doing": "🚧", "done": "✅", "dropped": "⛔"}
FIELDS = ("id", "title", "status", "summary", "next", "blocked_by", "parent", "merged_into", "closed")
HISTORY_SUFFIX = ".历史.md"
MARKER_RE = re.compile(r"^<!-- issue-pool: mode=directory; rules=issues/README\.md; tool=docs/issue-check\.py; sha=([0-9a-f]{64}) -->$")
ID_RE = re.compile(r"[1-9]\d*")
LINK_RE = re.compile(r"\]\(([^)\s]+)\)")
WORK_AREA_LIMIT = 6000


class IssueError(Exception):
    pass


# ---------- 读写单条文件 ----------

def parse_issue(path):
    """读一条 issue：返回 (字段 dict, 正文)。frontmatter 只认「键: 值」一种写法。"""
    with open(path, encoding="utf-8") as f:
        text = f.read()
    if not text.startswith("---\n"):
        raise IssueError(f"{rel(path)}：缺 frontmatter")
    end = text.find("\n---\n", 4)
    if end < 0:
        raise IssueError(f"{rel(path)}：frontmatter 没有结束行")
    keys = []
    for line in text[4:end].split("\n"):
        if not line.strip():
            continue
        if ":" not in line:
            raise IssueError(f"{rel(path)}：frontmatter 行不是「键: 值」：{line}")
        keys.append(line.split(":", 1)[0].strip())
    unknown = sorted(set(keys) - set(FIELDS))
    if unknown:
        raise IssueError(f"{rel(path)}：不认识的字段 {', '.join(unknown)}（只允许 {', '.join(FIELDS)}）")
    dup = sorted({k for k in keys if keys.count(k) > 1})
    if dup:
        raise IssueError(f"{rel(path)}：frontmatter 字段重复：{', '.join(dup)}")
    meta, body = parse_issue_text(text)
    if not ID_RE.fullmatch(meta.get("id", "")):
        raise IssueError(f"{rel(path)}：id 必须是不带前导 0 的正整数，现在是「{meta.get('id', '')}」")
    return meta, body


def dump_issue(meta, body):
    lines = ["---"] + [f"{k}: {meta.get(k, '')}".rstrip() for k in FIELDS] + ["---"]
    return "\n".join(lines) + "\n" + body


def write_atomic(path, content):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(content)
    os.replace(tmp, path)


def rel(path):
    return os.path.relpath(path, ROOT)


def is_main_issue_file(name):
    return re.match(r"^\d{3,}-.+\.md$", name) and not name.endswith(HISTORY_SUFFIX)


def load_all():
    """返回按 id 排序的条目列表；每项含 meta、body、path、folder。"""
    items = []
    for folder in (OPEN_DIR, DONE_DIR, DROP_DIR):
        d = os.path.join(ISSUES_DIR, folder)
        if not os.path.isdir(d):
            continue
        for name in sorted(os.listdir(d)):
            if not is_main_issue_file(name):
                continue
            path = os.path.join(d, name)
            meta, body = parse_issue(path)
            items.append({"meta": meta, "body": body, "path": path, "folder": folder, "name": name})
    items.sort(key=lambda it: int(it["meta"].get("id") or 0))
    return items


def find_issue(items, num):
    for it in items:
        if it["meta"].get("id") == str(num):
            return it
    raise IssueError(f"找不到 #{num}")


def history_path(path):
    return path[:-3] + HISTORY_SUFFIX


# ---------- 锁：new / set / close / reopen / build 串行执行 ----------

class Lock:
    """系统文件锁（flock）：持锁进程退出时由系统释放，锁文件本身留着不删。"""

    def __enter__(self):
        self.f = open(LOCK, "a")
        deadline = time.time() + 15
        while True:
            try:
                fcntl.flock(self.f, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return self
            except BlockingIOError:
                if time.time() > deadline:
                    self.f.close()
                    raise IssueError("另一个会话正在用本工具超过 15 秒，稍后再试")
                time.sleep(0.2)

    def __exit__(self, *exc):
        fcntl.flock(self.f, fcntl.LOCK_UN)
        self.f.close()


class Undo:
    """记下每一步改动，失败时倒序撤回：写入恢复原内容、新建删除、挪动挪回。"""

    def __init__(self):
        self.steps = []

    def write(self, path, content):
        with open(path, encoding="utf-8") as f:
            original = f.read()
        write_atomic(path, content)
        self.steps.append(lambda: write_atomic(path, original))

    def created(self, path):
        self.steps.append(lambda: os.remove(path))

    def move(self, src, dest):
        os.replace(src, dest)
        self.steps.append(lambda: os.replace(dest, src))

    def rollback(self):
        for step in reversed(self.steps):
            try:
                step()
            except OSError as e:
                print(f"撤回时出错（请对照 git 记录手工核对）：{e}", file=sys.stderr)


def ensure_overview_writable():
    """改任何条目之前先确认总览没被手改，避免改了一半才在 build 时失败。"""
    if overview_state() in ("edited", "unmanaged"):
        raise IssueError("ISSUES.md 被手改过（或不是本工具生成的）；先把改动挪进对应 issue 文件或收件箱，再用 build --force 覆盖，然后重试")


def check_value(key, value):
    if value is None:
        return ""
    if "\n" in value or "\r" in value:
        raise IssueError(f"{key} 不能换行")
    if key in ("parent", "merged_into") and value and not ID_RE.fullmatch(value):
        raise IssueError(f"{key} 只能写号，例如 54")
    return value.strip()


# ---------- 总览 ----------

def cell(text):
    return (text or "").replace("|", "\\|").replace("\n", " ")


def link_for(it):
    return f"[#{it['meta']['id']}]({rel(it['path'])})"


def inbox_count():
    if not os.path.exists(INBOX):
        return 0
    with open(INBOX, encoding="utf-8") as f:
        return sum(1 for line in f if line.startswith("- "))


def render_overview(items):
    open_items = [it for it in items if it["meta"].get("status") in OPEN_STATUSES]
    done = sum(1 for it in items if it["meta"].get("status") == "done")
    dropped = sum(1 for it in items if it["meta"].get("status") == "dropped")
    waiting = [it for it in open_items if it["meta"].get("blocked_by")]
    free = [it for it in open_items if not it["meta"].get("blocked_by")]

    out = ["# Issue 池", "",
           "> 要记想法、改状态，直接告诉 AI；本页由 `docs/issue-check.py build` 从 `issues/` 生成，不要手改。",
           "> 每条 issue 一个文件，规则见 [issues/README.md](issues/README.md)；版本与发布状态看 [specs 版本索引](specs/README.md)。",
           f"> 未关闭 {len(open_items)} · 已完成 {done} · 已作废 {dropped} · 收件箱 {inbox_count()} 条待整理",
           ""]

    def table(title, rows, last_col):
        out.append(f"## {title}")
        out.append("")
        if not rows:
            out.append("（暂无）")
            out.append("")
            return
        out.append(f"| # | 标题 | 一句话 | {last_col} |")
        out.append("|---|---|---|---|")
        for it in rows:
            m = it["meta"]
            last = m.get("blocked_by") if last_col == "等什么" else m.get("next")
            out.append(f"| {link_for(it)} | {cell(m.get('title'))} | {cell(m.get('summary'))} | {cell(last)} |")
        out.append("")

    by_status = lambda *ss: [it for it in free if it["meta"].get("status") in ss]
    table("📋 可开工", by_status("ready"), "下一步")
    table("🚧 开发中", by_status("doing"), "下一步")
    table("⏳ 等前置", waiting, "等什么")
    table("⏸ 聊过没收敛 · 💭 没聊过", by_status("pending", "idea"), "下一步")

    out.append("## 已关闭（按号）")
    out.append("")
    out.append("| # | 结果 | 标题 | 关闭日期 |")
    out.append("|---|---|---|---|")
    for it in items:
        m = it["meta"]
        if m.get("status") in ("done", "dropped"):
            out.append(f"| {link_for(it)} | {STATUS_ICON[m['status']]} | {cell(m.get('title'))} | {cell(m.get('closed') or '未记录')} |")
    out.append("")
    body = "\n".join(out)
    sha = hashlib.sha256(body.encode("utf-8")).hexdigest()
    marker = f"<!-- issue-pool: mode=directory; rules=issues/README.md; tool=docs/issue-check.py; sha={sha} -->"
    return insert_marker(body, marker)


def insert_marker(body, marker):
    # 标记放在说明块之后，便于人读时先看到说明
    lines = body.split("\n")
    idx = next(i for i, l in enumerate(lines) if l.startswith("> 未关闭 "))
    lines.insert(idx + 1, marker)
    return "\n".join(lines)


def split_marker(text):
    """返回 (去掉标记后的内容, 记录的 sha 或 None)。"""
    lines = text.split("\n")
    for i, line in enumerate(lines):
        m = MARKER_RE.match(line)
        if m:
            return "\n".join(lines[:i] + lines[i + 1:]), m.group(1)
    return text, None


def overview_state():
    """返回 'missing' / 'unmanaged' / 'edited' / 'ok'。"""
    if not os.path.exists(OVERVIEW):
        return "missing"
    with open(OVERVIEW, encoding="utf-8") as f:
        content, sha = split_marker(f.read())
    if sha is None:
        return "unmanaged"
    if hashlib.sha256(content.encode("utf-8")).hexdigest() != sha:
        return "edited"
    return "ok"


def build(force=False):
    state = overview_state()
    if state in ("edited", "unmanaged") and not force:
        raise IssueError("ISSUES.md 被手改过（或不是本工具生成的）；先把改动挪进对应 issue 文件或收件箱，再用 build --force 覆盖")
    write_atomic(OVERVIEW, render_overview(load_all()))


# ---------- 命令 ----------

def safe_short(text):
    s = re.sub(r"[\\/:*?\"<>|\s`'（）()「」，,。.#%\[\]]+", "", text)
    return s[:24] or "未命名"


def today():
    return datetime.date.today().isoformat()


def cmd_new(args):
    if args.status not in OPEN_STATUSES:
        raise IssueError(f"新建的状态只能是 {', '.join(OPEN_STATUSES)}")
    title = check_value("title", args.title)
    fields = {k: check_value(k, getattr(args, k)) for k in ("summary", "next", "blocked_by", "parent")}
    if not title:
        raise IssueError("标题不能为空")
    with Lock():
        ensure_overview_writable()
        items = load_all()
        num = max([int(it["meta"]["id"]) for it in items] or [0]) + 1
        if fields["parent"]:
            find_issue(items, fields["parent"])
        name = f"{num:03d}-{safe_short(args.short or title)}.md"
        path = os.path.join(ISSUES_DIR, OPEN_DIR, name)
        with open(TEMPLATE, encoding="utf-8") as f:
            _, body = parse_issue_text(f.read())
        meta = dict(fields, id=str(num), title=title, status=args.status, merged_into="", closed="")
        body = body.replace("{{id}}", str(num)).replace("{{title}}", title)
        undo = Undo()
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)  # 排他创建，防止并发撞号
        undo.created(path)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(dump_issue(meta, body))
            build()
        except Exception:
            undo.rollback()
            raise
    print(f"#{num} {rel(path)}")


def parse_issue_text(text):
    end = text.find("\n---\n", 4)
    meta = {}
    for line in text[4:end].split("\n"):
        if ":" in line:
            k, v = line.split(":", 1)
            meta[k.strip()] = v.strip()
    return meta, text[end + 5:]


def cmd_set(args):
    with Lock():
        ensure_overview_writable()
        it = find_issue(load_all(), args.num)
        meta = it["meta"]
        if meta.get("status") not in OPEN_STATUSES:
            raise IssueError(f"#{args.num} 已关闭，内容不再改；确实要改先 reopen")
        for pair in args.pairs:
            if "=" not in pair:
                raise IssueError(f"参数要写成 键=值：{pair}")
            k, v = pair.split("=", 1)
            if k not in FIELDS or k == "id":
                raise IssueError(f"不能改的字段：{k}")
            if k == "status" and v not in OPEN_STATUSES:
                raise IssueError("status 只能在未关闭的四个值之间改；关闭用 close，重开用 reopen")
            if k == "closed":
                raise IssueError("closed 由 close 填写")
            meta[k] = check_value(k, v)
            if k == "title" and not meta[k]:
                raise IssueError("标题不能为空")
        undo = Undo()
        try:
            undo.write(it["path"], dump_issue(meta, it["body"]))
            build()
        except Exception:
            undo.rollback()
            raise
    print(f"#{args.num} 已更新")


def move_target(it, folder):
    """算出挪动目标并确认不会覆盖已有文件（主文件和历史文件都查）。"""
    dest = os.path.join(ISSUES_DIR, folder, it["name"])
    if dest == it["path"]:
        return dest
    for b in (dest, history_path(dest)):
        if os.path.exists(b):
            raise IssueError(f"目标已存在：{rel(b)}")
    return dest


def move_issue(it, folder, undo):
    dest = move_target(it, folder)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    undo.move(it["path"], dest)
    hist = history_path(it["path"])
    if os.path.exists(hist):
        undo.move(hist, history_path(dest))
    return dest


def check_date(value):
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value or ""):
        raise IssueError("日期要写成 YYYY-MM-DD")
    try:
        datetime.date.fromisoformat(value)
    except ValueError:
        raise IssueError(f"不是有效日期：{value}")
    return value


def change_and_move(it, meta_updates, folder):
    """改字段、挪文件夹、重建总览；任何一步失败都把文件恢复原样。"""
    move_target(it, folder)
    undo = Undo()
    try:
        it["meta"].update(meta_updates)
        undo.write(it["path"], dump_issue(it["meta"], it["body"]))
        dest = move_issue(it, folder, undo)
        build()
    except Exception:
        undo.rollback()
        raise
    return dest


def cmd_close(args):
    closed = check_date(args.date) if args.date is not None else today()
    with Lock():
        ensure_overview_writable()
        it = find_issue(load_all(), args.num)
        if it["meta"].get("status") not in OPEN_STATUSES:
            raise IssueError(f"#{args.num} 已经关闭")
        dest = change_and_move(it, {"status": args.result, "closed": closed}, STATUS_DIR[args.result])
    print(f"#{args.num} → {rel(dest)}")


def cmd_reopen(args):
    if args.status not in OPEN_STATUSES:
        raise IssueError(f"重开后的状态只能是 {', '.join(OPEN_STATUSES)}")
    with Lock():
        ensure_overview_writable()
        it = find_issue(load_all(), args.num)
        if it["meta"].get("status") in OPEN_STATUSES:
            raise IssueError(f"#{args.num} 没有关闭")
        dest = change_and_move(it, {"status": args.status, "closed": ""}, OPEN_DIR)
    print(f"#{args.num} → {rel(dest)}")


def cmd_build(args):
    with Lock():
        build(force=args.force)
    print("ISSUES.md 已生成")


# ---------- 校验 ----------

def work_area(body):
    """主文件里「工作区」的字数：正文去掉空白后的字符数。"""
    return len(re.sub(r"\s", "", body))


def check():
    errors, warnings = [], []
    try:
        items = load_all()
    except IssueError as e:
        print(f"错误：{e}")
        return 1

    # 状态文件夹里不合命名规则的 .md 会被忽略，单独报出来
    for folder in (OPEN_DIR, DONE_DIR, DROP_DIR):
        d = os.path.join(ISSUES_DIR, folder)
        for name in sorted(os.listdir(d)) if os.path.isdir(d) else []:
            if name.endswith(".md") and not is_main_issue_file(name) and not re.match(r"^\d{3,}-.+\.历史\.md$", name):
                errors.append(f"issues/{folder}/{name}：文件名不合「三位编号-短名.md」，不会被读到")
            elif name.endswith(HISTORY_SUFFIX) and not os.path.exists(os.path.join(d, name[:-len(HISTORY_SUFFIX)] + ".md")):
                errors.append(f"issues/{folder}/{name}：找不到对应的主文件")

    # 1 frontmatter、id 唯一、文件名编号 = id
    seen = {}
    for it in items:
        m = it["meta"]
        if not re.fullmatch(r"\d+", m.get("id", "")):
            errors.append(f"{rel(it['path'])}：id 不是数字")
            continue
        if it["name"].split("-", 1)[0] != f"{int(m['id']):03d}":
            errors.append(f"{rel(it['path'])}：文件名编号和 id 不一致")
        if m["id"] in seen:
            errors.append(f"#{m['id']} 重复：{rel(seen[m['id']])} 与 {rel(it['path'])}")
        seen[m["id"]] = it["path"]
        missing = [k for k in FIELDS if k not in m]
        if missing:
            errors.append(f"{rel(it['path'])}：缺字段 {', '.join(missing)}")
        if not m.get("title"):
            errors.append(f"{rel(it['path'])}：title 为空")
        # 2 状态合法且与文件夹一致
        st = m.get("status")
        if st not in STATUS_DIR:
            errors.append(f"#{m['id']}：status 不合法：{st}")
        elif STATUS_DIR[st] != it["folder"]:
            errors.append(f"#{m['id']}：status={st} 却放在 {it['folder']}/")

    # 3 1 到最大号无缺号
    ids = sorted(int(i) for i in seen)
    if ids:
        gaps = sorted(set(range(1, ids[-1] + 1)) - set(ids))
        if gaps:
            errors.append(f"缺号：{', '.join('#' + str(g) for g in gaps)}")

    # 4 总览与内容一致
    state = overview_state()
    if state != "ok":
        errors.append({"missing": "ISSUES.md 不存在", "unmanaged": "ISSUES.md 不是本工具生成的",
                       "edited": "ISSUES.md 被手改过（sha 对不上）"}[state])
    else:
        with open(OVERVIEW, encoding="utf-8") as f:
            if f.read() != render_overview(items):
                errors.append("ISSUES.md 不是最新的：运行 build")

    # 5 parent / merged_into / blocked_by 里的号存在
    for it in items:
        m = it["meta"]
        # parent / merged_into 只写号；blocked_by 可以是一句话，只核其中的「#号」
        refs = []
        for k in ("parent", "merged_into"):
            v = m.get(k, "")
            if v and not ID_RE.fullmatch(v):
                errors.append(f"#{m['id']}：{k} 只能写号（如 54），现在是「{v}」")
            elif v:
                refs.append((k, v))
        refs += [("blocked_by", r) for r in re.findall(r"#(\d+)", m.get("blocked_by", ""))]
        for k, ref in refs:
            if ref not in seen:
                errors.append(f"#{m['id']}：{k} 指向不存在的 #{ref}")

    # 6 未关闭条目要有 next
    for it in items:
        m = it["meta"]
        if m.get("status") in OPEN_STATUSES and not m.get("next") and not m.get("blocked_by"):
            warnings.append(f"#{m['id']}：未关闭但没写 next")

    # 7 相对链接能打开（未关闭逐条报，已关闭汇总）
    closed_broken = 0
    for folder in (OPEN_DIR, DONE_DIR, DROP_DIR):
        d = os.path.join(ISSUES_DIR, folder)
        if not os.path.isdir(d):
            continue
        for name in sorted(os.listdir(d)):
            if not name.endswith(".md"):
                continue
            path = os.path.join(d, name)
            with open(path, encoding="utf-8") as f:
                text = f.read()
            # 也认尖括号写法 [x](<带 空格.md>)，并解码 %20 这类编码
            for raw in re.findall(r"\]\((<[^>]+>|[^)\s]+)\)", text):
                target = urllib.parse.unquote(raw[1:-1] if raw.startswith("<") else raw)
                if re.match(r"^(https?:|mailto:|#)", target):
                    continue
                target_path = target.split("#", 1)[0]
                if not os.path.exists(os.path.normpath(os.path.join(d, target_path))):
                    if folder == OPEN_DIR:
                        errors.append(f"{rel(path)}：链接打不开 {target}")
                    else:
                        closed_broken += 1
    if closed_broken:
        warnings.append(f"已关闭条目里有 {closed_broken} 个链接打不开（多为当时的文件后来挪走了，属历史原文）")

    # 8 未关闭主文件过长
    for it in items:
        if it["meta"].get("status") in OPEN_STATUSES and work_area(it["body"]) > WORK_AREA_LIMIT:
            warnings.append(f"#{it['meta']['id']}：主文件超过 {WORK_AREA_LIMIT} 字，考虑把旧讨论挪进 .历史.md")

    # 9 收件箱、私人路径清单、协议例外
    if inbox_count():
        warnings.append(f"收件箱有 {inbox_count()} 条待整理")
    defaults = os.path.join(ROOT, ".dev-workflow", "project-defaults.json")
    if os.path.exists(defaults):
        with open(defaults, encoding="utf-8") as f:
            if '"issues/"' not in f.read():
                warnings.append(".dev-workflow/project-defaults.json 的 privatePaths 还没加 issues/")
    for proto in ("CLAUDE.md", "AGENTS.md"):
        p = os.path.join(ROOT, proto)
        if os.path.exists(p):
            with open(p, encoding="utf-8") as f:
                if "issues/README.md" not in f.read():
                    warnings.append(f"{proto} 第 4 节缺「本项目需求池是目录模式」那一行")

    for e in errors:
        print(f"错误：{e}")
    for w in warnings:
        print(f"提醒：{w}")
    print(f"共 {len(items)} 条；错误 {len(errors)}，提醒 {len(warnings)}")
    return 1 if errors else 0


# ---------- 回退：拼回单文件 ----------

def unprefix_links(text):
    return LINK_RE.sub(lambda m: "](" + (m.group(1)[6:] if m.group(1).startswith("../../") else m.group(1)) + ")", text)


def cmd_export(args):
    """按号把各条拼回「编号. 状态 标题 + 缩进正文」的单文件格式；历史文件接在条目末尾。"""
    out = ["# Issue 池（由 issues/ 导出）", ""]
    for it in load_all():
        m = it["meta"]
        out.append(f"{m['id']}. {STATUS_ICON.get(m.get('status'), '')} {m.get('title')}")
        parts = [it["body"]]
        hist = history_path(it["path"])
        if os.path.exists(hist):
            with open(hist, encoding="utf-8") as f:
                parts.append(f.read())
        for line in unprefix_links("\n".join(parts)).split("\n"):
            out.append(("   " + line) if line.strip() else "")
    sys.stdout.write("\n".join(out) + "\n")


def main():
    p = argparse.ArgumentParser(description="Issue 池工具（规则见 issues/README.md）")
    sub = p.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build"); b.add_argument("--force", action="store_true")
    sub.add_parser("check")
    n = sub.add_parser("new")
    n.add_argument("title"); n.add_argument("--short"); n.add_argument("--status", default="idea")
    n.add_argument("--parent"); n.add_argument("--summary"); n.add_argument("--next"); n.add_argument("--blocked-by")
    s = sub.add_parser("set"); s.add_argument("num"); s.add_argument("pairs", nargs="+")
    c = sub.add_parser("close"); c.add_argument("num"); c.add_argument("result", choices=["done", "dropped"]); c.add_argument("--date")
    r = sub.add_parser("reopen"); r.add_argument("num"); r.add_argument("--status", default="doing")
    sub.add_parser("export")
    args = p.parse_args()
    try:
        if args.cmd == "check":
            return check()
        {"build": cmd_build, "new": cmd_new, "set": cmd_set, "close": cmd_close,
         "reopen": cmd_reopen, "export": cmd_export}[args.cmd](args)
        return 0
    except IssueError as e:
        print(f"错误：{e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
