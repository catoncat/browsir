---
id: ISSUE-007
title: Runtime Loop compaction / aux LLM 抽离
status: done
priority: p1
source: next-development-master-plan-2026-03-14 + slice breakdown
created: 2026-03-14
assignee: agent
resolved: 2026-03-14
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

## 工作总结（2026-03-14 13:49 UTC）

- 新增 `extension/src/sw/kernel/loop-compaction-llm.ts`，承接 compaction summary 的 aux route 解析、LLM 请求、响应解析、trace 与重试逻辑。
- `extension/src/sw/kernel/runtime-loop.browser.ts` 中 `compaction.summary` hook 已改为调用新模块，主 loop 不再内联该段请求逻辑。
- compaction 路径保留了 hosted chat 响应处理，并继续通过 `parseLlmMessageFromBody` 覆盖 SSE / JSON 摘要解析路径。
- 补齐了 compaction 路径与主链路一致的 `llm.before_request` / `llm.after_response` patch 校验，避免非法 hook patch 被静默吞掉。

## 相关 commits

- 未提交

