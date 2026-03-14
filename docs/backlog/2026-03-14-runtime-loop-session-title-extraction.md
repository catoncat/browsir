---
id: ISSUE-004
title: Runtime Loop 标题模块抽离
status: in-progress
priority: p0
source: next-development-master-plan-2026-03-14 + slice breakdown
created: 2026-03-14
assignee: agent
kind: slice
epic: EPIC-2026-03-14-NEXT-PHASE
parallel_group: kernel-loop
depends_on: []
write_scope:
  - extension/src/sw/kernel/runtime-loop.browser.ts
  - extension/src/sw/kernel/loop-session-title.ts
  - extension/src/sw/kernel/__tests__/loop-session-title.browser.test.ts
acceptance_ref: docs/next-development-slices-2026-03-14.md
tags: [slice, kernel, runtime-loop, session-title]
---

# ISSUE-004: Runtime Loop 标题模块抽离

## 目标

把 session title / title refresh / title LLM request 从 `runtime-loop.browser.ts` 抽到独立模块。

## 范围

- `normalizeSessionTitle`
- `readSessionTitleSource`
- `withSessionTitleMeta`
- `parseLlmContent`
- `requestSessionTitleFromLlm`
- `refreshSessionTitleAuto`

## 非目标

- 不调整标题生成策略
- 不改 session title 的产品语义

## 验收

- `runtime-loop.browser.ts` 不再定义上述函数
- 新模块成为唯一入口
- `tsc --noEmit` 通过
- 新增标题模块单测通过

