---
id: ISSUE-020
title: "终态 / overflow 语义统一"
status: done
priority: p2
source: architecture-evolution-phase2
created: 2026-03-14
assignee: agent
resolved: 2026-03-15
kind: slice
epic: EPIC-2026-03-14-ARCH-EVOLUTION-PHASE2
parallel_group: kernel-loop
depends_on:
  - ISSUE-018
write_scope:
  - extension/src/sw/kernel/orchestrator.browser.ts
  - extension/src/sw/kernel/runtime-loop.browser.ts
  - extension/src/sw/kernel/loop-shared-types.ts
  - extension/src/sw/kernel/runtime-router/
  - README.md
  - AGENTS.md
  - bdd/contracts/
acceptance_ref: docs/architecture-evolution-plan-2026-03-14.md
tags:
  - slice
  - kernel
  - semantics
  - bdd
  - documentation
  - phase2
claimed_at: "2026-03-14T16:53:21.576Z"
---

## 问题

1. `runtime-loop.browser.ts` 的 `finalStatus`、`loop-shared-types.ts` 的 `FailureReason`、`orchestrator.browser.ts` 的 `handleAgentEnd()` decision 是三层并行语义
2. overflow → compaction → continue 的 ownership 横跨 runtime-loop / orchestrator / runtime-router，文档与实现容易漂移

## 目标

先定义 canonical terminal status / failure reason / agent-end decision 映射，再补齐 overflow → auto-compaction → continue 的真实控制流。

## 分阶段落地

### Phase A — 状态模型统一

- 明确 `loop_done.status`、`FailureReason`、`handleAgentEnd()` decision 的 canonical mapping
- 先解决“同一故障在不同层被不同名字描述”的问题

### Phase B — overflow ownership

- 明确 overflow 由谁上报、谁触发 compaction、谁决定 continue / done / failed_execute
- 把 runtime-loop / orchestrator / runtime-router 的控制流连接成可测试闭环

## 验收标准

- [x] canonical terminal status / failure reason / agent-end decision 已在代码与文档中对齐
- [x] overflow 场景在适用路径下走 auto-compaction → continue，而不是被过早收口成 `failed_execute`
- [x] `runtime-loop` / `runtime-router` / `orchestrator` 对同一状态模型的映射明确且可测试
- [x] BDD 契约覆盖 overflow 自愈场景
- [x] README 和 AGENTS 中的终态文档已更新
- [x] `bun run build` 通过
- [x] `bun run test` 通过
- [x] `bun run bdd:gate` 通过

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

## 工作总结（2026-03-15 09:48 +08:00）

- 新增 `loop-shared-types.ts` 中的 canonical 终态 helper，明确：
  - `loop_done.status` 终态域
  - `FailureReason` 失败子域
  - `handleAgentEnd()` 决策域
- `orchestrator.handleAgentEnd()` 的 `action=done` 分支不再返回模糊 `completed|error`，改为复用 canonical terminal status / failure reason。
- `runtime-router` 的 `brain.agent.end` 现在支持透传 `payload.status` 与 `payload.failureReason`，使外部上报的 agent-end 语义不会在路由层被抹平。
- `runtime-loop.browser.ts` 显式收口到 `LoopTerminalStatus` 类型，减少终态域继续漂移的空间。
- `loop-browser-proof.ts` 与 `loop-failure-protocol.ts` 的 failure normalize 已回收到 shared helper，消除重复实现。
- README、AGENTS、BDD contract 已同步补充“终态域 / 失败子域 / 决策域”与 overflow ownership 口径。

## 相关 commits（2026-03-15 09:48 +08:00）

- 未提交
