---
id: ISSUE-019
title: "Prompt 域整合 — system prompt resolver 下沉到 prompt/"
status: done
priority: p3
source: architecture-evolution-phase2
created: 2026-03-14
assignee: agent
claimed_at: 2026-03-15T00:00:00Z
kind: slice
epic: EPIC-2026-03-14-ARCH-EVOLUTION-PHASE2
parallel_group: kernel-loop
depends_on:
  - ISSUE-018
  - ISSUE-020
write_scope:
  - extension/src/sw/kernel/runtime-loop.browser.ts
  - extension/src/sw/kernel/prompt/
acceptance_ref: docs/architecture-evolution-plan-2026-03-14.md
tags:
  - slice
  - kernel
  - prompt
  - system-prompt
  - architecture
  - phase2
---

## 问题

`buildResolvedSystemPrompt` 并不是“纯函数小工具”，而是 context-ref 解析 + system prompt 组装的一部分；当前 prompt 逻辑已分散在 `runtime-loop.browser.ts` 与 `prompt/prompt-policy.browser.ts` 两处。

## 目标

将 system prompt resolver 下沉到 `prompt/` 域，避免再新增一个根层 `loop-system-prompt.ts` 继续打散 prompt 逻辑。

## 验收标准

- [ ] resolver 位于 `extension/src/sw/kernel/prompt/` 域内（或并入 `prompt-policy.browser.ts`）
- [ ] `runtime-loop.browser.ts` 不再定义 `buildResolvedSystemPrompt` 函数体
- [ ] system prompt + context-ref 解析逻辑不再在 loop 根层与 prompt 域之间分裂
- [ ] `bun run build` 通过
- [ ] `bun run test` 通过

## 写入范围

- `extension/src/sw/kernel/runtime-loop.browser.ts`（瘦身）
- `extension/src/sw/kernel/prompt/`

## 泳道

`kernel-loop`，runtime-loop 单写者（建议在 ISSUE-020 之后进入）

## 依赖

ISSUE-018、ISSUE-020（同泳道串行）

## 工作总结

- 新建 `extension/src/sw/kernel/prompt/prompt-resolver.browser.ts`，导出 `createSystemPromptResolver` 工厂函数
  - 定义 `SystemPromptContextRefService` 接口（contextRefService 的窄类型子集）
  - 工厂接受 `{ contextRefService }` 依赖注入，返回 `{ resolveSystemPrompt }` 方法
  - 逻辑与原 `buildResolvedSystemPrompt` 完全一致：无自定义 prompt 时走 `buildBrowserAgentSystemPromptBase`；有 `@` context-ref 时走 resolve → materialize → prefix 组装
- 修改 `runtime-loop.browser.ts`：
  - 移除内联 `buildResolvedSystemPrompt` 函数定义（约 50 行）
  - 移除 `buildBrowserAgentSystemPromptBase` import（已被 prompt-resolver 内部引用替代）
  - 在 `contextRefService` 创建后实例化 `systemPromptResolver`
  - `runAgentLoop` 和 `getSystemPromptPreview` 两个调用点改为 `systemPromptResolver.resolveSystemPrompt(...)`

验收标准逐项：
- [x] resolver 位于 `prompt/` 域内（`prompt/prompt-resolver.browser.ts`）
- [x] `runtime-loop.browser.ts` 不再定义 `buildResolvedSystemPrompt` 函数体
- [x] system prompt + context-ref 解析逻辑不再在 loop 根层与 prompt 域之间分裂
- [ ] `bun run build` 通过（需用户自行验证）
- [ ] `bun run test` 通过（需用户自行验证）

## 相关 commits

未提交
