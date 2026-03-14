---
id: ISSUE-020
title: 终态 / overflow 语义统一
status: open
priority: p2
source: architecture-evolution-phase2
created: 2026-03-14
assignee: unassigned
kind: slice
epic: EPIC-2026-03-14-ARCH-EVOLUTION-PHASE2
parallel_group: kernel-loop
depends_on: [ISSUE-018]
write_scope:
  - extension/src/sw/kernel/orchestrator.browser.ts
  - extension/src/sw/kernel/runtime-loop.browser.ts
  - extension/src/sw/kernel/loop-shared-types.ts
  - extension/src/sw/kernel/runtime-router/
  - README.md
  - AGENTS.md
  - bdd/contracts/
acceptance_ref: docs/architecture-evolution-plan-2026-03-14.md
tags: [slice, kernel, semantics, bdd, documentation, phase2]
---

## 问题

1. `runtime-loop.browser.ts` 的 `finalStatus`、`loop-shared-types.ts` 的 `FailureReason`、`orchestrator.browser.ts` 的 `handleAgentEnd()` decision 是三层并行语义
2. overflow → compaction → continue 的 ownership 横跨 runtime-loop / orchestrator / runtime-router，文档与实现容易漂移

## 目标

先定义 canonical terminal status / failure reason / agent-end decision 映射，再补齐 overflow → auto-compaction → continue 的真实控制流。

## 验收标准

- [ ] canonical terminal status / failure reason / agent-end decision 已在代码与文档中对齐
- [ ] overflow 场景在适用路径下走 auto-compaction → continue，而不是被过早收口成 `failed_execute`
- [ ] `runtime-loop` / `runtime-router` / `orchestrator` 对同一状态模型的映射明确且可测试
- [ ] BDD 契约覆盖 overflow 自愈场景
- [ ] README 和 AGENTS 中的终态文档已更新
- [ ] `bun run build` 通过
- [ ] `bun run test` 通过
- [ ] `bun run bdd:gate` 通过

## 写入范围

- `extension/src/sw/kernel/orchestrator.browser.ts`
- `extension/src/sw/kernel/runtime-loop.browser.ts`
- `extension/src/sw/kernel/loop-shared-types.ts`
- `extension/src/sw/kernel/runtime-router/`
- `README.md`
- `AGENTS.md`
- `bdd/contracts/`

## 泳道

`kernel-loop` + `bdd-docs`

## 依赖

ISSUE-018（同泳道串行）
