---
id: ISSUE-033
title: "失败信封瘦身 — attachFailureProtocol 精简"
status: done
priority: p2
source: "ISSUE-022 Slice C 归档残留项"
created: 2026-03-15
assignee: agent
resolved: 2026-03-15
tags:
  - browser-automation
  - performance
  - residual
---

## 来源

ISSUE-022（浏览器自动化对齐 AIPex）Slice C 未实现。当前 `attachFailureProtocol` 仍返回完整 `failureClass` / `modeEscalation` / `resume` 结构，失败返回 token 量过大。

## 问题

LLM 被失败元数据淹没，无法聚焦核心错误信息。AIPex 失败消息截断到 500 字符只保留核心错误。

## 目标

将 `attachFailureProtocol` 输出精简，去掉 `failureClass`/`resume` block（`modeEscalation` 保留，因 runtime-loop 消费用于自动 focus 切换）。

## 写入范围

- `extension/src/sw/kernel/loop-failure-protocol.ts`
- `extension/src/sw/kernel/loop-shared-types.ts`
- `extension/src/sw/kernel/dispatch-plan-executor.ts`
- `extension/src/sw/kernel/loop-tool-dispatch.ts`
- `extension/src/sw/kernel/runtime-loop.browser.ts`
- `extension/src/sw/kernel/__tests__/runtime-router.browser.test.ts`

## 验收标准

- [x] `failureClass` 输出及 `FailurePhase`/`FailureCategory` 类型已移除
- [x] `resume` 输出及 `ResumeStrategy` 类型已移除
- [x] `modeEscalation` 保留（有消费者：runtime-loop focus 自动切换）
- [x] `bun run build` 通过
- [x] `bun run test` 通过（42 文件 378 测试全绿）

## 工作总结

移除了 `attachFailureProtocol` 中无下游消费者的两个输出字段：
- `failureClass`（含 `phase`/`category`）— 仅在生成侧存在，无读取方
- `resume`（含 `strategy`/`action`）— 同上

影响文件 6 个，清除了约 50+ 处 `phase`/`category`/`resumeStrategy` 传参。类型层面删除了 `FailurePhase`、`FailureCategory`、`ResumeStrategy` 三个不再使用的类型。

## 验收标准

- [ ] `attachFailureProtocol` 输出精简，失败返回 token 降 5-10x
- [ ] `bun run build` 通过
- [ ] `bun run test` 通过
