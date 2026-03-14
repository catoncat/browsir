---
id: ISSUE-006
title: Runtime Loop no-progress / signature 抽离
status: open
priority: p0
source: next-development-master-plan-2026-03-14 + slice breakdown
created: 2026-03-14
assignee: unassigned
kind: slice
epic: EPIC-2026-03-14-NEXT-PHASE
parallel_group: kernel-loop
depends_on: [ISSUE-005]
write_scope:
  - extension/src/sw/kernel/runtime-loop.browser.ts
  - extension/src/sw/kernel/loop-progress-guard.ts
  - extension/src/sw/kernel/__tests__/loop-progress-guard.browser.test.ts
acceptance_ref: docs/next-development-slices-2026-03-14.md
tags: [slice, kernel, runtime-loop, no-progress]
---

# ISSUE-006: Runtime Loop no-progress / signature 抽离

## 目标

把 no-progress fingerprint、tool signature、continue budget、terminal outcome 汇总从主 loop 移出。

## 范围

- volatile evidence 归一化
- no-progress fingerprint
- tool-call signature 计算
- continue budget 判定
- terminal status 汇总辅助

## 非目标

- 不改 no-progress 产品策略
- 不改外部事件名

## 验收

- 主 loop 文件不再直接保存这套计算细节
- 新模块有纯函数测试
- 原有 runtime-loop 回归测试继续通过

