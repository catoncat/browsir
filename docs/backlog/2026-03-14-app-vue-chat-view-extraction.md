---
id: ISSUE-017
title: ChatView 主控拆分 — run state / message bus / plugin runtime 解耦
status: in-progress
priority: p0
source: architecture-evolution-phase2
created: 2026-03-14
assignee: unassigned
kind: slice
epic: EPIC-2026-03-14-ARCH-EVOLUTION-PHASE2
parallel_group: panel-chat
depends_on: []
write_scope:
  - extension/src/panel/App.vue
  - extension/src/panel/ChatView.vue
  - extension/src/panel/types.ts
  - extension/src/panel/composables/use-llm-streaming.ts
  - extension/src/panel/composables/use-tool-pending-state.ts
  - extension/src/panel/composables/use-runtime-message-bus.ts
  - extension/src/panel/composables/use-ui-render-pipeline.ts
  - extension/src/panel/composables/use-conversation-actions.ts
acceptance_ref: docs/architecture-evolution-plan-2026-03-14.md
tags: [slice, panel, chat-view, controller, composable, architecture, phase2]
---

## 问题

`App.vue` 壳层收口已经在真实工作树中完成：当前 `App.vue` 仅约 86 行，主要负责 bootstrap、视图切换和 `SessionList` 挂载。与此同时，`ChatView.vue` 已经接入了 `use-ui-render-pipeline.ts` 与 `use-llm-streaming.ts` 两条首轮边界，但复杂度并未被真正清空，而是继续集中在约 2,142 行的 `ChatView.vue` 中，当前仍混合了：

- chat 主视图渲染
- tool pending / run-view 主状态机
- step stream 恢复与 polling
- `chrome.runtime.onMessage` 消息总线
- 残余的 panel UI plugin render runtime / hook wiring
- send / export / debug link 等动作处理

因此本条目的真实目标，已经从“瘦 `App.vue`”变成“避免 `ChatView.vue` 成为新的巨型主控组件”。

## 目标

保持当前 `App.vue` shell 不回退，并在已落地的 `use-ui-render-pipeline.ts` / `use-llm-streaming.ts` 基础上，继续从 `ChatView.vue` 中拆出稳定 controller 边界，优先把 tool pending / run-view、runtime message bus 以及会话动作处理分离出去。

## 验收标准

- [x] `panel/types.ts` 继续集中 panel view-model / run-view 相关类型定义
- [x] `App.vue` 保持 shell-only，不重新吸回 chat controller 逻辑
- [x] `use-llm-streaming.ts` 已承接 LLM 流式草稿状态的首轮抽离
- [ ] `ChatView.vue` 不再直接内联 tool pending / run-view 主状态机
- [ ] `ChatView.vue` 不再直接承载 `chrome.runtime.onMessage` + polling + step-stream wiring
- [x] panel UI plugin runtime / render hook 管线已有 `use-ui-render-pipeline.ts` 独立边界
- [ ] send / export / debug link 等动作已提炼为独立 helper / composable，或至少被显式隔离
- [ ] `bun run build` 通过
- [ ] `bun run test` 通过

## 推荐拆分顺序

0. 保持并继续复用已接入的 `use-ui-render-pipeline.ts` / `use-llm-streaming.ts`
1. `use-tool-pending-state.ts`（从 `ChatView.vue` 抽剩余运行态状态机）
2. `use-runtime-message-bus.ts`（抽 runtime/bridge event wiring + polling）
3. `use-conversation-actions.ts`（抽 send/export/debug/fork 等动作）

> `shell-context.ts` 不再是第一阶段硬约束；只有当 props/emits 或注入边界真的成为阻碍时再引入。

## 写入范围

- `extension/src/panel/App.vue`（保持 shell，必要时仅适配）
- `extension/src/panel/ChatView.vue`
- `extension/src/panel/types.ts`
- `extension/src/panel/composables/use-llm-streaming.ts`（已落地，继续保持窄边界）
- `extension/src/panel/composables/use-tool-pending-state.ts`（推荐新建）
- `extension/src/panel/composables/use-runtime-message-bus.ts`（推荐新建）
- `extension/src/panel/composables/use-ui-render-pipeline.ts`（优先复用/扩展）
- `extension/src/panel/composables/use-conversation-actions.ts`（推荐新建）

## 泳道

`panel-chat`，`ChatView.vue` 单写者

## 依赖

无
