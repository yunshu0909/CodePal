# Issue 池规则

> 本项目的 Issue 池是「一条 issue 一个文件」。根目录的 `ISSUES.md` 只是总览，由 `docs/issue-check.py build` 生成，不手改。
> 本文是规则正本；协议第 4 节只写「本项目是目录模式、去哪看、跑什么」。

## 给 AI：issue-pool skill 在本项目怎么用

装了 dev-workflow 时，它的 issue-pool skill 照常负责「记、并、拆、转、pending」的判断（原话优先、产出问题定义而不是方案、single-task / roadmap 两种规模）。它里面这几句**在本项目不适用**：「载体就是仓库根的 ISSUES.md」「拆解产物缩进挂在条目下」「直接写在池子条目下」「池子就是一个 markdown 文件」。改为：

| 动作 | 怎么做 |
|---|---|
| 记 | 先读 `ISSUES.md` 总览的「一句话」列，再 `rg 关键词 issues/` 查相关条目；确实是新的才 `python3 docs/issue-check.py new "标题" --summary "一句话"`，把用户原话写进新文件的「原话」。当场告诉用户编号。 |
| 并 | 被并入的条目：`set N merged_into=目标号`，再 `close N dropped`；原话复制到目标条目「原话」并注明来自 #N。 |
| 拆 | 能单独开工的子事项：`new "标题" --parent 原号`；原条目「已拆出」写一行指向新号。 |
| 转 | 在条目文件里补「问题定义 / 现在要做 / 验收 / 卡点与指路」，再 `set N status=ready next="下一步"`。 |
| pending | `set N status=pending next="卡在哪"`。 |
| 开工 | `set N status=doing`；开工策略、审核轮次、提交记录写进 specs 单元，不回写 issue。 |
| 交付 | 「交付摘要」加一行（日期 + 结果 + specs 链接，不写哈希、测试数、审核轮次）。 |
| 关闭 | 先核对正文里的「后续 / 待办」是否真的做完（看最终交付记录和现行文件）；没做完的列进验收页当候选新号，用户划掉不要的再建号。然后 `close N done` 或 `close N dropped`（作废写原因）。 |

改完任何 issue 文件都跑 `python3 docs/issue-check.py build`（`new / set / close / reopen` 已自动 build），收尾前跑 `check`。

**不要手改 `ISSUES.md`。** 万一某个会话按老习惯往池子里加了内容，先挪进 `issues/收件箱.md`（一行一条，`- ` 开头），再整理成正式条目、清空收件箱。

## 目录

| 位置 | 放什么 |
|---|---|
| `ISSUES.md`（根目录） | 总览：每条一行，按「可开工 / 开发中 / 等前置 / 没收敛·没聊过 / 已关闭」分表。脚本生成。 |
| `issues/未关闭/` | 状态是 idea、pending、ready、doing 的条目 |
| `issues/已完成/` | done |
| `issues/已作废/` | dropped |
| `NNN-短名.历史.md` | 只有特别长的条目才有：被推翻的旧讨论、完整交付细账。只存不改，和主文件放在一起、一起挪。 |
| `issues/收件箱.md` | 兜底，平时是空的 |
| `issues/_模板.md` | `new` 用的模板 |

文件名是「三位编号 + 中文短名」，短名不写进度和版本。找文件只认编号：`issues/*/026-*.md`。

## 单条文件

```markdown
---
id: 26
title: 标题（不写进度、版本、哈希）
status: doing          # idea / pending / ready / doing / done / dropped
summary: 一句话（≤30 字，给「记」时的查重用）
next: 下一步
blocked_by:            # 前置条件：一句话，或 #号
parent:                # 从哪条拆出来（只写号）
merged_into:           # 并入哪条（只写号）
closed:                # 关闭日期；迁移来的老条目查不到就写「未记录」
---
```

正文分区：原话（只追加不改写）→ 问题定义 → 已确认的决定（被推翻的标「已被某日决定替代」，原文挪进历史）→ 现在要做（范围 / 不做）→ 验收 → 卡点与指路 → 交付摘要。

什么放哪：

| 放主文件（干活要看） | 放 .历史.md（翻旧账） | 不放进 issue（各有正本） |
|---|---|---|
| 原话、问题定义、已确认的决定、范围、验收、卡点与指路、交付摘要 | 被推翻的讨论原文、完整交付细账 | 提交、合并、审核轮次、测试细账 → specs 单元或 git；版本对应 → [版本索引](../specs/README.md)；可复用的技术结论 → `memory/topics/` |

主文件正文超过 6000 字，`check` 会提醒挪一部分进历史文件。

## 状态与编号

- 状态只写在 `status` 字段；总览、文件夹都由它决定。图例：💭 idea 没聊过 · ⏸ pending 聊过没收敛 · 📋 ready 可开工 · 🚧 doing 开发中 · ✅ done 已完成 · ⛔ dropped 作废。有 `blocked_by` 的未关闭条目在总览里单列「⏳ 等前置」。
- 只有关闭（`close`）和重开（`reopen`）会挪文件；状态在未关闭四个值之间变化时文件不动。
- 编号永久、递增、不复用；`new` 在锁里取「最大号 + 1」并排他创建文件，两个会话同时建不会撞号。
- 已关闭条目 `set` 会拒绝；确实要改先 `reopen`。总览被手改时，所有改动命令都会在动任何文件之前拒绝。
- 本池的号写 `#26`；别的来源必须带前缀（「另一个仓 #20」「PR #5」）。
- specs 合同里的 issue 字段继续写 `ISSUES.md#26` 这种形式，不写 `issues/未关闭/…` 路径（关闭时文件会挪）。
- 已关闭条目内容不再改；要改先 `reopen`。

## 命令

```bash
python3 docs/issue-check.py check                      # 校验（每次改完、收尾前）
python3 docs/issue-check.py build                      # 重新生成总览
python3 docs/issue-check.py new "标题" --summary "一句话" [--status idea] [--parent 54] [--blocked-by "…"]
python3 docs/issue-check.py set 26 status=ready next="下一步"
python3 docs/issue-check.py close 26 done              # 或 dropped
python3 docs/issue-check.py reopen 26 --status doing
python3 docs/issue-check.py export > /tmp/ISSUES-导出.md # 当前内容拼成单文件快照（有历史文件的条目会重复）
```

## 以后改插件（还没做）

先在本项目用上面的规则覆盖 skill 文字；用顺了再给 dev-workflow 的 issue-pool 加一个可选的「目录模式」：项目在总览里有 `issue-pool: mode=directory` 标记时才按本文执行，其他项目照旧用单个 ISSUES.md。改前先给用户看一页前后流程图。
