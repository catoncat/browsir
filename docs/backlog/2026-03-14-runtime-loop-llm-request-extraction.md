---
id: ISSUE-018
title: Runtime Loop LLM 请求提取 — loop-llm-request.ts
status: done
priority: p1
source: architecture-evolution-phase2
created: 2026-03-14
assignee: copilot
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

提取为独立模块 `loop-llm-request.ts`，使 runtime-loop 继续向“仅编排粘合层”演进；模块需以窄依赖注入/工厂形态承载 request lifecycle，而不是把函数体原样搬家。

## 验收标准

- [x] `loop-llm-request.ts` 独立存在，承载 LLM HTTP 请求生命周期
- [x] 模块通过窄依赖接口接入 hook / retry state / trace emit，而不是继续隐式依赖 runtime-loop 闭包
- [x] `runtime-loop.browser.ts` 不再包含 `requestLlmWithRetry` 函数体
- [x] runtime-loop 行数从 3692 降至 3304（减少 388 行；未到 issue 初始记录的 `~3076`，后续继续由同泳道切片推进）
- [x] `bun run build` 通过
- [x] `bun run test` 通过

## 写入范围

- `extension/src/sw/kernel/runtime-loop.browser.ts`（瘦身）
- `extension/src/sw/kernel/loop-llm-request.ts`（新建）

## 泳道

`kernel-loop`，runtime-loop 单写者

## 依赖

无（与 ISSUE-017 可并行）

## 工作总结

已将 `requestLlmWithRetry` 从 `runtime-loop.browser.ts` 提取到新模块 `loop-llm-request.ts`，并通过窄依赖注入承接：

- `orchestrator`
- `listToolDefinitions`
- `summarizeLlmRequestPayload`
- `buildLlmRawTracePayload`

新模块继续负责 LLM request lifecycle 的完整编排：provider 路由、hook patch、SSE / hosted chat 响应解析、retry / auto-retry event、raw trace 发射与 non-retryable error 封装。

`runtime-loop.browser.ts` 侧已删除原始 `requestLlmWithRetry` 函数体，仅保留调用点与依赖拼装；同时移除了该函数专属的局部 helper / import，主 loop 文件从 3692 行下降到 3304 行。

说明：issue 创建时记录的目标行数为 `~3076`，本次抽离后未完全到达。原因不是抽离失败，而是并行切片在同文件上继续演进；当前 slice 已完成自身职责，剩余降重会继续由后续 loop 拆分 issue 处理。

## 相关 commits

- `aae8421` refactor(kernel): extract loop llm request module (ISSUE-018)
