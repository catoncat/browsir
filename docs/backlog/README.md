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
claimed_at: ISO datetime（可选；claim 时写入）
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

项目内也可以通过 repo skill `auto-claim-issues` 自动认领符合条件的 backlog slice。

## 当前未完成项（2026-03-15 更新）

以下清单用于快速派工；后续 agent 进入仓库时，优先看本节，不必先遍历整个目录。

已完成的 26 项 backlog 已归档至 `archive/` 子目录。

### 进行中

1. `ISSUE-023` [cursor_help_web Pool 架构后续](./2026-03-15-cursor-help-pool-followup.md)
  - `status: in-progress`
  - `priority: p1`
  - `parallel_group: cursor-help`
  - `assignee: human`
  - 说明：Provider 连通性由 human 接手。子 slice ISSUE-024/025/026/027 全部已完成，仅剩 S1（multi-conversation conversationKey）部分已落地首阶段。

### 已完成（未归档）

1. `ISSUE-024` [Cursor Help pool slot 自动扩缩容](./2026-03-15-cursor-help-pool-autoscaling.md)
  - `status: done`
  - `priority: p2`
  - `parallel_group: cursor-help`
  - 说明：autoscaling 已实现并通过 5 组回归测试覆盖扩缩容决策与冷却时间。

### 可立即开工

1. `ISSUE-021` [ChatView 二阶段深拆 follow-up](./2026-03-15-app-vue-decomposition.md)
   - `status: open`
   - `priority: p2`
   - 说明：ChatView 已从 2142→892 行，composables 分工合理。当前厚度不紧迫，可推迟。

## 推荐领取顺序

1. `ISSUE-023` 由 human 负责，agent 不要并行改其 `write_scope`。
2. `ISSUE-024` 已 done，Cursor Help pool follow-up 子 slice 全部收束。
3. `ISSUE-021` 是唯一剩余的 open slice，但当前 ChatView 厚度（892 行）已在合理范围，优先级低。
4. 如无新需求，backlog 已基本清空。

## 维护规则

- 任何 agent 完成一次 backlog 扫描后，如果结论发生变化，应先更新本 README 的“当前未完成项”与“推荐领取顺序”。
- 任何 agent 修改某个 issue 的 `status`、依赖或推荐顺序时，应同步更新本 README，保持这里始终是首选入口。
