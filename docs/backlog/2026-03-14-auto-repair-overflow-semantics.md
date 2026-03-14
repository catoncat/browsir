---
id: ISSUE-020
title: auto-repair / overflow 语义统一
status: open
priority: p3
source: architecture-evolution-phase2
created: 2026-03-14
assignee: ""
kind: alignment
tags: [kernel, semantics, bdd, documentation, phase2]
---

## 问题

1. README/AGENTS 声明的 `execute_error/no_progress` 触发条件，与内核终态枚举（`failed_execute/failed_verify/progress_uncertain/max_steps/stopped`）不完全同构
2. overflow 恢复路径可能落 `failed_execute` 而非自愈（Pi 的 overflow → auto-compaction → continue 链路更完整）

## 目标

终态枚举与文档声明 1:1 对应，overflow 恢复链路补齐。

## 验收标准

- [ ] 内核终态枚举与 README/AGENTS 中的描述 1:1 对应
- [ ] overflow 场景不再落 `failed_execute`，而是走 auto-compaction → continue
- [ ] BDD 契约覆盖 overflow 自愈场景
- [ ] README 和 AGENTS 中的终态文档已更新
- [ ] `bun run build` 通过
- [ ] `bun run test` 通过
- [ ] `bun run bdd:gate` 通过

## 写入范围

- `extension/src/sw/kernel/orchestrator.browser.ts`
- `extension/src/sw/kernel/runtime-loop.browser.ts`
- `extension/src/sw/kernel/loop-shared-types.ts`
- `README.md`
- `AGENTS.md`
- `bdd/contracts/`

## 泳道

`kernel-loop` + `bdd-docs`

## 依赖

ISSUE-018, ISSUE-019（同泳道串行）
