---
id: ISSUE-012
title: `@路径` 输入与发送链路接线
status: open
priority: p0
source: next-development-master-plan-2026-03-14 + slice breakdown
created: 2026-03-14
assignee: unassigned
kind: slice
epic: EPIC-2026-03-14-NEXT-PHASE
parallel_group: panel-store
depends_on: [ISSUE-009]
write_scope:
  - extension/src/panel/components/ChatInput.vue
  - extension/src/panel/stores/runtime.ts
  - extension/src/sw/kernel/orchestrator.browser.ts
  - extension/src/sw/kernel/runtime-router/run-controller.ts
acceptance_ref: docs/next-development-slices-2026-03-14.md
tags: [slice, context-ref, chat-input, send-pipeline]
---

# ISSUE-012: `@路径` 输入与发送链路接线

## 目标

把 `ChatInput` 的路径引用真正接到 `contextRefs` 发送链路。

## 范围

- 输入框提取结果
- send payload
- orchestrator / run-controller 接线

## 非目标

- 不做新的 prompt DSL
- 不做自动猜测文件注入

## 验收

- `@路径` 引用进入 `contextRefs`
- 发送链路不依赖纯文本 include
- 空文本 + contextRefs 仍可发起请求

