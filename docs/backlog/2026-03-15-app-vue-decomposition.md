---
id: ISSUE-021
title: ChatView 二阶段深拆 — transcript / overlay / editor / export follow-up
status: open
priority: p2
source: ISSUE-017 follow-up after ChatView controller split
created: 2026-03-15
assignee: unassigned
kind: refactor
tags: [panel, refactor, vue, composables, chat-view, follow-up]
---

# ISSUE-021: ChatView 二阶段深拆 — transcript / overlay / editor / export follow-up

## 背景

`ISSUE-017` 现已重新校准为：在保留 `App.vue` shell 收口成果的前提下，从 `ChatView.vue` 拆出第一层 controller 边界（run state / runtime bus / plugin runtime / conversation actions）。当前工作树里，`use-ui-render-pipeline.ts` 与 `use-llm-streaming.ts` 已经落下首轮抽离，本条目只承接其后的二阶段深拆。

本条目保留为**第二阶段 follow-up**：当 `ISSUE-017` 完成首轮 controller 解耦后，如果 `ChatView.vue` 或新抽出的 composable 仍然偏厚，再继续做更深层的 presentational / auxiliary 拆分。

> 说明：本条目**不替代** `ISSUE-017`。`ISSUE-017` 解决的是“一阶控制器边界”；本条目只处理首轮收口之后残留的二阶热点。

## 当前热点（基于真实工作树）

当前 `ChatView.vue` 约 2,142 行，主要热点已从 `App.vue` 转移至此：

| 区块 | 现状 |
|------|------|
| tool pending / run-view / step-stream sync | 仍与 tool card model、事件恢复逻辑紧耦合 |
| watchers / auto-scroll | 与运行态、消息列表可见性、fork scene 等交织 |
| panel UI plugin runtime wiring | `use-ui-render-pipeline.ts` 已接入，但 `ChatView.vue` 仍保留不少 side-effect/wiring |
| runtime message bus | `chrome.runtime.onMessage`、bridge/runtime event 分发、polling 混在视图主体 |
| conversation actions | send / export / debug link / fork source / refresh title 混在同层 |

## 拆分计划（按优先级）

### Phase 1：在 `ISSUE-017` 完成后再做的二阶段收尾

1. **`ChatTranscript.vue` / `ChatTimeline.vue`**
   - 负责消息列表、流式草稿、tool pending card、空状态视图
   - 前提：tool pending 状态机和 message bus 已从 `ChatView.vue` 主体拆出

2. **`ChatHeaderActions.vue` / `ChatExportActions.vue`**
   - Header 菜单、export/debug/fork source 辅助动作
   - 减少 `ChatView.vue` 顶栏模板与动作处理耦合

3. **`useConversationEditing()` / `useConversationExport()`**
   - user message editing、markdown/debug/export handler
   - 将辅助交互从主视图进一步沉降到独立 composable

4. **plugin overlay / widget host 继续独立**
   - 如果 `chat.scene.overlay` 插槽与 plugin runtime 仍然厚，可拆成独立 host component

### Phase 2：对首轮新 composable 做二次细拆（仅在确实膨胀时）

1. **若 `use-tool-pending-state.ts` 继续膨胀**
   - 候选拆分：`useToolRunStream()` / `useToolPendingCardModel()`

2. **若 `use-llm-streaming.ts` 继续膨胀**
   - 候选拆分：draft buffer / visibility heuristic / final reply commit

3. **若 `use-ui-render-pipeline.ts` 继续膨胀**
   - 候选拆分：notice / lifecycle / render-payload-normalizer 三层

4. **若 `use-runtime-message-bus.ts` 继续膨胀**
   - 候选拆分：runtime event dispatch / polling sync / bridge event output

## 非目标

- 不把控制器职责搬回 `App.vue`
- 不重新讨论“要不要 `ChatView.vue`”——它已经是当前真实边界
- 不与 `ISSUE-017` 的首轮 controller 抽离 scope 重叠

## 验收标准

- `ISSUE-017` 完成后，如仍有必要，再把剩余热点拆成独立 presentational component / composable
- 新增模块职责边界明确，不与 `ISSUE-017` 首轮 scope 重叠
- `bun run build` 通过
- 功能无回归（手动验证 SidePanel 主流程）

## 约束

- 不改变任何用户可见行为
- 默认在 `ISSUE-017` 完成后再评估是否启动
- 不制造仅为“符合旧计划”而存在的新抽象
- 每个 composable / component 单独 commit，方便 review
