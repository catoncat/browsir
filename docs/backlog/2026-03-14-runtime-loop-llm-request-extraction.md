---
id: ISSUE-018
title: Runtime Loop LLM 请求提取 — loop-llm-request.ts
status: open
priority: p1
source: architecture-evolution-phase2
created: 2026-03-14
assignee: unassigned
kind: slice
epic: EPIC-2026-03-14-ARCH-EVOLUTION-PHASE2
parallel_group: kernel-loop
depends_on: []
write_scope:
  - extension/src/sw/kernel/runtime-loop.browser.ts
  - extension/src/sw/kernel/loop-llm-request.ts
acceptance_ref: docs/architecture-evolution-plan-2026-03-14.md
tags: [slice, kernel, runtime-loop, llm, architecture, phase2]
---

## 问题

`requestLlmWithRetry`（~375 行）是 `runtime-loop.browser.ts` 中最大的未拆出逻辑块，包含 HTTP 请求构造、retry 循环、profile 升级、SSE/hosted-chat content-type 分发和 hook 编排。

## 目标

提取为独立模块 `loop-llm-request.ts`，使 runtime-loop 继续向"仅编排粘合层"演进。

## 验收标准

- [ ] `loop-llm-request.ts` 独立存在，承载 LLM HTTP 请求生命周期
- [ ] `runtime-loop.browser.ts` 不再包含 `requestLlmWithRetry` 函数体
- [ ] runtime-loop 总行数降至 ~3,076
- [ ] `bun run build` 通过
- [ ] `bun run test` 通过

## 写入范围

- `extension/src/sw/kernel/runtime-loop.browser.ts`（瘦身）
- `extension/src/sw/kernel/loop-llm-request.ts`（新建）

## 泳道

`kernel-loop`，runtime-loop 单写者

## 依赖

无（与 ISSUE-017 可并行）
