---
id: ISSUE-032
title: "runtime-router brain.agent.end 终态透传"
status: open
priority: p2
source: "ISSUE-020 归档残留项"
created: 2026-03-15
assignee: unassigned
tags:
  - kernel
  - semantics
  - residual
---

## 来源

ISSUE-020（终态/overflow 语义统一）归档时发现：工作总结声称 `runtime-router` 的 `brain.agent.end` 已支持透传 `payload.status` 与 `payload.failureReason`，但代码验证未在 `runtime-router/` 下找到对应引用。

## 问题

外部上报的 agent-end 语义可能在路由层被抹平，导致终态信息丢失。

## 目标

在 `runtime-router` 中为 `brain.agent.end` 事件补齐 `payload.status` / `payload.failureReason` 透传逻辑。

## 写入范围

- `extension/src/sw/kernel/runtime-router/`

## 验收标准

- [ ] `brain.agent.end` payload 中 `status` 和 `failureReason` 字段被正确透传
- [ ] `bun run build` 通过
