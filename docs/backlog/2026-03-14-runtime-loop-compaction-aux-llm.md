---
id: ISSUE-007
title: Runtime Loop compaction / aux LLM 抽离
status: open
priority: p1
source: next-development-master-plan-2026-03-14 + slice breakdown
created: 2026-03-14
assignee: unassigned
kind: slice
epic: EPIC-2026-03-14-NEXT-PHASE
parallel_group: kernel-loop
depends_on: [ISSUE-006]
write_scope:
  - extension/src/sw/kernel/runtime-loop.browser.ts
  - extension/src/sw/kernel/loop-compaction-llm.ts
  - extension/src/sw/kernel/__tests__/loop-compaction-llm.browser.test.ts
acceptance_ref: docs/next-development-slices-2026-03-14.md
tags: [slice, kernel, runtime-loop, compaction, llm]
---

# ISSUE-007: Runtime Loop compaction / aux LLM 抽离

## 目标

把 compaction summary 请求、aux route 解析、summary 结果整形从主 loop 文件移出。

## 范围

- `requestCompactionSummaryFromLlm`
- aux route 使用规则
- summary body parse / normalize

## 非目标

- 不重写 compaction 算法
- 不改 compaction 产品阈值

## 验收

- 主 loop 文件不再内联 compaction summary LLM 请求逻辑
- 覆盖 hosted chat / SSE / JSON 三种摘要解析路径

