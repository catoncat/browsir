---
id: ISSUE-009
title: Runtime Store 领域拆分
status: open
priority: p0
source: next-development-master-plan-2026-03-14 + slice breakdown
created: 2026-03-14
assignee: unassigned
kind: slice
epic: EPIC-2026-03-14-NEXT-PHASE
parallel_group: panel-store
depends_on: [ISSUE-008]
write_scope:
  - extension/src/panel/stores/runtime.ts
  - extension/src/panel/stores
acceptance_ref: docs/next-development-slices-2026-03-14.md
tags: [slice, panel, store, state]
---

# ISSUE-009: Runtime Store 领域拆分

## 目标

把 `runtime.ts` 拆成 chat/config/skills/plugins/diagnostics 等领域 store。

## 范围

- chat session / run
- environment / config
- skills
- plugins
- diagnostics

## 非目标

- 不改 UI 文案
- 不在本 slice 内重做 App 壳层

## 验收

- `runtime.ts` 不再是超级 store
- 新 store 之间通过明确 action / selector 协作
- 发送、rerun、stop 等聊天动作只在聊天域

