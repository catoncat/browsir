---
id: ISSUE-013
title: "ContextRef diagnostics / inspect 接线"
status: done
priority: p1
source: "next-development-master-plan-2026-03-14 + slice breakdown"
created: 2026-03-14
assignee: agent
kind: slice
epic: EPIC-2026-03-14-NEXT-PHASE
parallel_group: panel-store
depends_on:
  - ISSUE-012
write_scope:
  - extension/src/sw/kernel/context-ref
  - extension/src/panel/utils/diagnostics.ts
  - extension/src/panel/components/DebugView.vue
acceptance_ref: docs/next-development-slices-2026-03-14.md
tags:
  - slice
  - context-ref
  - diagnostics
  - inspect
claimed_at: "2026-03-14T12:03:25.076Z"
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

## 工作总结

**日期**: 2026-03-14

**实现方案**：利用已存储在 user message metadata 中的 contextRef 数据（由 `buildPromptExecutionPayload` -> `toMetadataRows` 生成），在 diagnostics 中提取并展示。

**修改文件**：
1. `session-utils.ts`：`buildConversationView` 现在包含 user message 的 metadata（包含 contextRefs 行）
2. `diagnostics.ts`：新增 `buildContextRefSummary` 从会话消息中提取 contextRef 数据，生成 compact table；已加入 diagnosticGuide 的 preferredLookupOrder 和 jqHints
3. `DebugView.vue`：新增「上下文引用」区块，按 mode 颜色编码展示每个 ref 的 displayPath / kind / runtime / size / summary

**验证标准覆盖**：
- ✅ 能看到本轮用了哪些 refs（displayPath + source + runtime）
- ✅ 能看到哪些 ref 被截断或跳过（mode = excerpt / metadata_only / error）
- ✅ diagnostics 不再只能靠日志猜测（compact table + DebugView UI）

## 相关 commits

- `9eaf19c` feat(diagnostics): add contextRefs section to diagnostics and DebugView

