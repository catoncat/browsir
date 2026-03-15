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

## 当前未完成项（2026-03-15）

以下清单用于快速派工；后续 agent 进入仓库时，优先看本节，不必先遍历整个目录。

### 进行中

1. `ISSUE-017` [ChatView 主控拆分](./2026-03-14-app-vue-chat-view-extraction.md)
   - `status: in-progress`
   - `priority: p0`
   - `parallel_group: panel-chat`
   - 说明：当前 panel 侧最直接主线；目标是继续从 `ChatView.vue` 剥离 controller / action / watch glue。

2. `ISSUE-023` [cursor_help_web Pool 架构后续](./2026-03-15-cursor-help-pool-followup.md)
  - `status: in-progress`
  - `priority: p1`
  - `parallel_group: cursor-help`
  - 说明：当前 Cursor Help 方向仍在处理中；其中 Provider 连通性由 human 继续接手，其他 agent 默认不要再并行改 `web-chat-executor.browser.ts` / `cursor-help-content.ts` / `cursor-help-page-hook.ts`，除非先明确重新分工。

3. `ISSUE-024` [Cursor Help pool slot 自动扩缩容](./2026-03-15-cursor-help-pool-autoscaling.md)
  - `status: open`
  - `priority: p2`
  - `parallel_group: cursor-help`
  - 说明：`ISSUE-026` 收尾后，当前队列中的最后一张 cursor-help card 是 autoscaling。

### 可立即开工

（当前无可立即开工的 issue）

### 暂不应启动

1. `ISSUE-021` [ChatView 二阶段深拆 follow-up](./2026-03-15-app-vue-decomposition.md)
   - `status: open`
   - `priority: p2`
   - 阻塞：依赖 `ISSUE-017` 首轮 controller 解耦完成
   - 说明：这是 follow-up，不替代 `ISSUE-017`，默认不要提前启动。

2. `ISSUE-024` [Cursor Help pool slot 自动扩缩容](./2026-03-15-cursor-help-pool-autoscaling.md)
  - `status: open`
  - `priority: p2`
  - 阻塞：依赖 `ISSUE-023`（当前 human 正在处理 Provider 连通性）
  - 说明：这是 `ISSUE-023` 的后续 slice，先不要与连接恢复并行推进。

3. `ISSUE-025` [Cursor Help pool slot 健康检查心跳](./2026-03-15-cursor-help-pool-heartbeat.md)
  - `status: done`
  - `priority: p1`
  - 说明：已完成 heartbeat / health reason / soft recovery / retry budget 收口。

4. `ISSUE-026` [Cursor Help pool lane 并发冲突细化](./2026-03-15-cursor-help-pool-lane-conflict-refinement.md)
  - `status: done`
  - `priority: p2`
  - 说明：已完成 lane conflict 集中判定与关键组合测试覆盖。

5. `ISSUE-024` [Cursor Help pool slot 自动扩缩容](./2026-03-15-cursor-help-pool-autoscaling.md)
  - `status: open`
  - `priority: p2`
  - 阻塞：依赖 `ISSUE-025` 与 `ISSUE-026`（均已满足，等待认领）
  - 说明：当前已成为 Cursor Help 队列中的下一张可开工 card。

## 推荐领取顺序

1. 先看是否有人正在持有 `panel-chat` 或 `kernel-loop` 单写者泳道。
2. `panel-chat` 侧当前仍是 `ISSUE-017` 单写者，默认不要重复认领。
3. `kernel-loop` 侧当前 `ISSUE-019` 已完成，暂无后续 open slice。
4. `cursor-help` 侧当前下一张建议 card 为 `ISSUE-024`；认领后应避免并行写入其 `write_scope`。
5. `ISSUE-024` 完成后，当前这一组 Cursor Help pool follow-up 即可视为基本收束。
6. `ISSUE-021` 必须排在 `ISSUE-017` 后，并且仅在一阶段拆分后仍有明显厚度时才启动。

## 维护规则

- 任何 agent 完成一次 backlog 扫描后，如果结论发生变化，应先更新本 README 的“当前未完成项”与“推荐领取顺序”。
- 任何 agent 修改某个 issue 的 `status`、依赖或推荐顺序时，应同步更新本 README，保持这里始终是首选入口。
