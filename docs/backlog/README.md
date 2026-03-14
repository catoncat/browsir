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

## Slice 扩展字段

当 backlog 文件承载“可并行分配的实施 slice”时，允许追加以下可选字段：

```yaml
kind: slice
epic: EPIC-<标识>
parallel_group: kernel-loop | panel-shell | panel-store | plugin-product | skill-runtime | context-ref | cursor-help | bdd-docs
depends_on: [ISSUE-xxx, ISSUE-yyy]
write_scope:
  - extension/src/...
  - docs/...
acceptance_ref: docs/<某设计文档>.md
```

字段语义：

- `kind`
  - 默认可省略；若这是可直接派发给 agent 的实施切片，写 `slice`
- `epic`
  - 归属的大计划或母任务
- `parallel_group`
  - 并行泳道名；同泳道通常表示存在协作关系
- `depends_on`
  - 明确前置 issue；为空表示可独立开始
- `write_scope`
  - 预计会改动的主要文件或目录；用于避免多个 agent 写同一片区域
- `acceptance_ref`
  - 对应主计划或设计文档

## 并行分配规则

1. `write_scope` 有明显重叠的 slice，默认不要并行派给不同 agent。
2. `runtime-loop.browser.ts`、`App.vue`、`runtime.ts` 这类超级节点默认单写者，同一时段只允许一个 agent 持有。
3. 能拆成“新模块 + 小接线”的，优先拆；不要把两个 agent 同时派去改同一个大文件不同段落。
4. backlog 文件是 agent 派工单元；主计划文档只负责战略，不直接承接派工。

## Agent 工作流

1. **发现 issue**：对话中发现待办事项时，创建 backlog 文件记录
2. **承接 issue**：空闲时或用户指派时，读取本目录寻找 `status: open` 的 issue
3. **更新状态**：开始处理改为 `in-progress`，完成改为 `done` 并补充 `resolved` 字段
4. **跨会话交接**：新 agent 进入时可扫描本目录了解未完成工作
