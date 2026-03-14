---
id: ISSUE-019
title: Runtime Loop System Prompt 构建提取 — loop-system-prompt.ts
status: open
priority: p2
source: architecture-evolution-phase2
created: 2026-03-14
assignee: ""
kind: refactor
tags: [kernel, runtime-loop, system-prompt, architecture, phase2]
---

## 问题

`buildResolvedSystemPrompt`（~150 行）+ skill prompt 展开逻辑是纯函数，无外部依赖，但仍内联在 `runtime-loop.browser.ts` 中。

## 目标

提取为独立模块 `loop-system-prompt.ts`。

## 验收标准

- [ ] `loop-system-prompt.ts` 独立存在，承载 system prompt 构建和 skill prompt 展开
- [ ] `runtime-loop.browser.ts` 通过导入使用该模块
- [ ] runtime-loop 总行数降至 ~2,926
- [ ] `bun run build` 通过
- [ ] `bun run test` 通过

## 写入范围

- `extension/src/sw/kernel/runtime-loop.browser.ts`（瘦身）
- `extension/src/sw/kernel/loop-system-prompt.ts`（新建）

## 泳道

`kernel-loop`，runtime-loop 单写者

## 依赖

ISSUE-018（同泳道串行）
