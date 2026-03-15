---
id: ISSUE-033
title: "失败信封瘦身 — attachFailureProtocol 精简"
status: open
priority: p2
source: "ISSUE-022 Slice C 归档残留项"
created: 2026-03-15
assignee: unassigned
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

将 `attachFailureProtocol` 输出精简为 `{ errorCode, hint }` 格式，去掉 `failureClass`/`resume`/`modeEscalation` block。

## 写入范围

- `extension/src/sw/kernel/loop-failure-protocol.ts`

## 验收标准

- [ ] `attachFailureProtocol` 输出精简，失败返回 token 降 5-10x
- [ ] `bun run build` 通过
- [ ] `bun run test` 通过
