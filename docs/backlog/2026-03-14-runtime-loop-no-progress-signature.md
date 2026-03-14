---
id: ISSUE-006
title: Runtime Loop no-progress / signature 抽离
status: done
priority: p0
source: next-development-master-plan-2026-03-14 + slice breakdown
created: 2026-03-14
assignee: copilot
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

- volatile evidence 归一化（screenshot diff hash、DOM mutation count 等动态证据的标准化处理）
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

## 工作总结

从 `runtime-loop.browser.ts` 提取以下纯函数/常量到 `loop-progress-guard.ts`：

- `NO_PROGRESS_VOLATILE_EVIDENCE_KEYS` — 易变证据字段集合
- `normalizeNoProgressEvidenceValue()` — 证据值归一化（volatile 抹除、clipText）
- `buildNoProgressEvidenceFingerprint()` — 证据对象指纹
- `buildNoProgressScopeKey()` — no-progress 作用域键
- `resolveNoProgressDecision()` — 参数化 hit 计数判定（接受外部 Map）

同时删除了 `runtime-loop.browser.ts` 中重复的 `isToolCallRequiringBrowserProof`、`didToolProvideBrowserProof` 闭包（已由 `loop-browser-proof.ts` 导出），改为 import。

测试：`loop-progress-guard.browser.test.ts` 新增 22 个用例，覆盖全部导出函数。回归测试（loop-browser-proof 25 + routing 2 + llm-route 3）全通过。

## 相关 commits

- `624e618` refactor(kernel): extract no-progress pure functions to loop-progress-guard (ISSUE-006)

