---
id: ISSUE-005
title: Runtime Loop browser proof / lease / verify 抽离
status: done
priority: p0
source: next-development-master-plan-2026-03-14 + slice breakdown
created: 2026-03-14
assignee: agent
kind: slice
epic: EPIC-2026-03-14-NEXT-PHASE
parallel_group: kernel-loop
depends_on: [ISSUE-004]  # 单写者泳道串行约束（共享 runtime-loop.browser.ts），非逻辑依赖
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

## 工作总结

**完成内容**：
- `loop-browser-proof.ts` 已由 ISSUE-004 agent 创建，包含全部 7 个导出函数
- 删除 `runtime-loop.browser.ts` 中 5 个重复函数定义（buildObserveProgressVerify, shouldVerifyStep, actionRequiresLease, shouldAcquireLease, mapToolErrorReasonToTerminalStatus），解决 TS2440 冲突
- 新增 `loop-browser-proof.browser.test.ts`：25 个纯函数测试覆盖全部 7 个导出函数
- 验收条件全部满足 ✅

**Commits**：
- `4292a75` — 修正 import 路径 + 删除重复函数定义
- `8170860` — 添加 25 个单元测试

