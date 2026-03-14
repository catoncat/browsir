# Issue Backlog

本目录存放通过 AI 协作对话发现的待办 issue，每个文件对应一个独立 issue。

## 文件命名

`YYYY-MM-DD-<slug>.md`，如 `2026-03-14-diagnostics-optimization.md`

## Frontmatter 格式

```yaml
---
id: ISSUE-<序号>
title: 简明标题
status: open | in-progress | done
priority: p0 | p1 | p2
source: 来源描述（如"调试对话 session-xxx"）
created: YYYY-MM-DD
assignee: agent | human | unassigned
tags: [tag1, tag2]
---
```

## Agent 工作流

1. **发现 issue**：对话中发现待办事项时，创建 backlog 文件记录
2. **承接 issue**：空闲时或用户指派时，读取本目录寻找 `status: open` 的 issue
3. **更新状态**：开始处理改为 `in-progress`，完成改为 `done` 并补充 `resolved` 字段
4. **跨会话交接**：新 agent 进入时可扫描本目录了解未完成工作
