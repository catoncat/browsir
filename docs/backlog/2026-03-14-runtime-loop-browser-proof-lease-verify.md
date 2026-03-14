---
id: ISSUE-005
title: Runtime Loop browser proof / lease / verify 抽离
status: open
priority: p0
source: next-development-master-plan-2026-03-14 + slice breakdown
created: 2026-03-14
assignee: unassigned
kind: slice
epic: EPIC-2026-03-14-NEXT-PHASE
parallel_group: kernel-loop
depends_on: [ISSUE-004]
write_scope:
  - extension/src/sw/kernel/runtime-loop.browser.ts
  - extension/src/sw/kernel/loop-browser-proof.ts
  - extension/src/sw/kernel/__tests__/loop-browser-proof.browser.test.ts
acceptance_ref: docs/next-development-slices-2026-03-14.md
tags: [slice, kernel, runtime-loop, browser-proof, verify]
---

# ISSUE-005: Runtime Loop browser proof / lease / verify 抽离

## 目标

把 browser action 的 verify policy、lease 获取策略、observe/verify 组合流程从主 loop 文件移出。

## 范围

- `shouldVerifyStep`
- `actionRequiresLease`
- `shouldAcquireLease`
- browser action 的 preObserve / verify / verifyError 映射
- browser proof 失败语义

## 非目标

- 不改 `runtime-infra` 的 CDP 能力
- 不改工具契约

## 验收

- `runtime-loop.browser.ts` 不再内联 browser proof / lease 决策逻辑
- 新模块有纯函数测试与至少一个回归测试
- 不保留旧实现副本

