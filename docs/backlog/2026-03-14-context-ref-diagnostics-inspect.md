---
id: ISSUE-013
title: ContextRef diagnostics / inspect 接线
status: open
priority: p1
source: next-development-master-plan-2026-03-14 + slice breakdown
created: 2026-03-14
assignee: unassigned
kind: slice
epic: EPIC-2026-03-14-NEXT-PHASE
parallel_group: panel-store
depends_on: [ISSUE-012]
write_scope:
  - extension/src/sw/kernel/context-ref
  - extension/src/panel/utils/diagnostics.ts
  - extension/src/panel/components/DebugView.vue
acceptance_ref: docs/next-development-slices-2026-03-14.md
tags: [slice, context-ref, diagnostics, inspect]
---

# ISSUE-013: ContextRef diagnostics / inspect 接线

## 目标

让 resolve / materialize / budget summary 进入 diagnostics / inspect 可见面。

## 范围

- ref resolve summary
- materialization summary
- truncated / skipped refs
- debug / inspect 展示

## 非目标

- 不改 `@路径` 语法
- 不改 chat input 解析

## 验收

- 能看到本轮用了哪些 refs
- 能看到哪些 ref 被截断或跳过
- diagnostics 不再只能靠日志猜测

