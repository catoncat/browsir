---
id: ISSUE-015
title: BDD / 文档边界同步
status: open
priority: p1
source: next-development-master-plan-2026-03-14 + slice breakdown
created: 2026-03-14
assignee: unassigned
kind: slice
epic: EPIC-2026-03-14-NEXT-PHASE
parallel_group: bdd-docs
depends_on: [ISSUE-006, ISSUE-009, ISSUE-010, ISSUE-012, ISSUE-014]
write_scope:
  - bdd
  - docs/kernel-architecture.md
  - docs/context-reference-filesystem-and-kernel-boundaries-design-2026-03-13.md
acceptance_ref: docs/next-development-slices-2026-03-14.md
tags: [slice, bdd, docs, architecture]
---

# ISSUE-015: BDD / 文档边界同步

## 目标

让 BDD 契约分类、证明要求、架构文档与当前真实边界一致。

## 范围

建议分两阶段执行：

### Phase A（可提前启动，不依赖代码重构完成）
- contract categories 重编目
- 证明要求更新

### Phase B（等代码稳定后启动）
- kernel 文档边界
- context ref 文档边界

## 非目标

- 不在本 slice 内继续大规模代码重构

## 验收

- 契约分类能反映当前一级模块
- 不再接受源码锚点充当 required proof
- 文档与目录边界一致

