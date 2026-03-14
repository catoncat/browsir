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
  - extension/src/panel/composables/use-tool-pending-state.ts
  - extension/src/panel/composables/use-runtime-message-bus.ts
  - extension/src/panel/composables/use-ui-render-pipeline.ts
  - extension/src/panel/composables/use-conversation-actions.ts
acceptance_ref: docs/architecture-evolution-plan-2026-03-14.md
tags: [slice, panel, chat-view, controller, composable, architecture, phase2]
---

## 问题

`App.vue` 壳层收口已经在真实工作树中完成：当前 `App.vue` 仅约 86 行，主要负责 bootstrap、视图切换和 `SessionList` 挂载。但复杂度并未消失，而是迁移到了约 2,690 行的 `ChatView.vue`，其中同时混合了：

- chat 主视图渲染
- tool pending / llm streaming / run-view 状态机
- step stream 恢复与 polling
- `chrome.runtime.onMessage` 消息总线
- panel UI plugin render runtime / hook pipeline
- send / export / debug link 等动作处理

因此本条目的真实目标，已经从“瘦 `App.vue`”变成“避免 `ChatView.vue` 成为新的巨型主控组件”。

## 目标

保持当前 `App.vue` shell 不回退，并从 `ChatView.vue` 中逐步拆出稳定 controller 边界，优先把运行态控制器、runtime message bus、plugin runtime 以及会话动作处理分离出去。

## 验收标准

- [ ] `panel/types.ts` 继续集中 panel view-model / run-view 相关类型定义
- [ ] `App.vue` 保持 shell-only，不重新吸回 chat controller 逻辑
- [ ] `ChatView.vue` 不再直接内联 tool pending / llm streaming / run-view 主状态机
- [ ] `ChatView.vue` 不再直接承载 `chrome.runtime.onMessage` + polling + step-stream wiring
- [ ] panel UI plugin runtime / render hook 管线有单独边界
- [ ] send / export / debug link 等动作已提炼为独立 helper / composable，或至少被显式隔离
- [ ] `bun run build` 通过
- [ ] `bun run test` 通过

## 推荐拆分顺序

1. `use-tool-pending-state.ts`（从 `ChatView.vue` 抽运行态状态机）
2. `use-runtime-message-bus.ts`（抽 runtime/bridge event wiring + polling）
3. `use-ui-render-pipeline.ts`（优先复用既有 composable，承接 panel UI plugin runtime / render hook）
4. `use-conversation-actions.ts`（抽 send/export/debug/fork 等动作）

> `shell-context.ts` 不再是第一阶段硬约束；只有当 props/emits 或注入边界真的成为阻碍时再引入。

## 写入范围

- `extension/src/panel/App.vue`（保持 shell，必要时仅适配）
- `extension/src/panel/ChatView.vue`
- `extension/src/panel/types.ts`
- `extension/src/panel/composables/use-tool-pending-state.ts`（推荐新建）
- `extension/src/panel/composables/use-runtime-message-bus.ts`（推荐新建）
- `extension/src/panel/composables/use-ui-render-pipeline.ts`（优先复用/扩展）
- `extension/src/panel/composables/use-conversation-actions.ts`（推荐新建）

## 泳道

`panel-chat`，`ChatView.vue` 单写者

## 依赖

无
