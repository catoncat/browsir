---
id: ISSUE-004
title: Runtime Loop 标题模块抽离
status: done
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

## 工作总结

### Code Review（审查通过）

经 code review 确认所有验收标准已满足：

1. **6 个函数全部抽到 `loop-session-title.ts`**：normalizeSessionTitle, readSessionTitleSource, withSessionTitleMeta, parseLlmContent, requestSessionTitleFromLlm, refreshSessionTitleAuto
2. **`runtime-loop.browser.ts` 不再定义这些函数**：仅保留 import + call
3. **构建通过**：`bun run build` ✅
4. **300 测试全通过**：`bun run test` ✅
5. **测试文件覆盖**：`__tests__/loop-session-title.browser.test.ts` 含 3 个测试用例

**小建议**：`withSessionTitleMeta` 是纯函数但测试未覆盖，建议后续补一个简单的 snapshot 测试。

### 相关 commits

- 模块抽离实现：由前序 agent 完成（已在代码库中）
- 状态标记 done：当前 review 确认

