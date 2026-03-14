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

建议分 2-3 个子 slice 执行：

### Phase A（优先）
- chat session / run → `chat-store.ts`

### Phase B
- environment / config → `config-store.ts`
- diagnostics → `diagnostics-store.ts`

### Phase C
- skills → `skills-store.ts`
- plugins → `plugins-store.ts`

Store 间协作约定：禁止循环依赖，store 间通过显式 action 调用或 computed getter 引用（不允许直接 `$patch` 其他 store 的状态）。

## 非目标

- 不改 UI 文案
- 不在本 slice 内重做 App 壳层

## 验收

- `runtime.ts` 不再是超级 store
- 新 store 之间通过明确 action / selector 协作
- 发送、rerun、stop 等聊天动作只在聊天域

