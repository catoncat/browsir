---
name: auto-claim-issues
description: 为 browser-brain-loop 项目自动认领 backlog issue / slice。用于用户要求“认领 issue”“自动 claim backlog”“挑一个可并行的 slice 开工”“找下一个可做 issue”时触发。会读取 docs/backlog 和 next-development-slices 文档，优先认领依赖已满足且与当前 in-progress write_scope 不冲突的 open issue。
---

# Auto Claim Issues

为本仓库自动认领 backlog issue / slice。

## 何时使用

当用户要求以下事情时使用：

- 自动认领一个 issue
- 从 backlog 里挑一个现在能做的 slice
- 给某个 agent 分配一个不冲突的任务
- 判断当前哪些 issue 可并行开工

## 规则

1. 先使用脚本扫描 `docs/backlog/*.md`，不要手工猜。
2. 默认只认领 `status: open` 的 issue。
3. 默认只认领：
   - `depends_on` 全部已完成
   - 与当前 `in-progress` issue 的 `write_scope` 不冲突
4. 如果用户指定 `ISSUE-xxx`，优先尝试认领该 issue。
5. 如果用户指定某个泳道或方向，传给脚本的 `--group` 参数，而不是手工筛选。
6. 认领后，必须再读取被认领的 backlog 文件，向用户汇报：
   - issue id / title
   - parallel_group
   - depends_on
   - write_scope
   - acceptance
7. 除非用户明确要求，不要一次认领多个 issue。

## 用法

默认自动认领一个当前最合适的 issue：

```bash
bun .agents/skills/auto-claim-issues/scripts/claim-issue.ts --assignee=agent
```

只预览，不落盘：

```bash
bun .agents/skills/auto-claim-issues/scripts/claim-issue.ts --dry-run --assignee=agent
```

指定 issue：

```bash
bun .agents/skills/auto-claim-issues/scripts/claim-issue.ts --issue=ISSUE-005 --assignee=agent
```

指定泳道：

```bash
bun .agents/skills/auto-claim-issues/scripts/claim-issue.ts --group=cursor-help --assignee=agent
```

输出 JSON 方便后续处理：

```bash
bun .agents/skills/auto-claim-issues/scripts/claim-issue.ts --json --assignee=agent
```

## 读取顺序

1. `docs/backlog/README.md`
2. `docs/next-development-slices-2026-03-14.md`
3. 被认领的 `docs/backlog/<issue>.md`

## 结果解释

- `claimed`
  - 成功认领并已更新 frontmatter
- `preview`
  - 只预览候选，不写文件
- `blocked`
  - 没有可认领 issue；需要看 `blockedByDependencies` 或 `blockedByConflicts`
- `already_claimed`
  - 指定 issue 已经是 `in-progress`

## 不要做的事

- 不要绕开 `docs/backlog/*.md` 直接口头“认领”
- 不要忽略 `write_scope` 冲突
- 不要把 `done` issue 重新改回 `in-progress`
- 不要在 claim 时顺手修改 issue 正文需求

