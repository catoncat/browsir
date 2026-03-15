---
id: ISSUE-032
title: "runtime-router brain.agent.end 终态透传"
status: done
priority: p2
source: "ISSUE-020 归档残留项"
created: 2026-03-15
assignee: agent
resolved: 2026-03-15
tags:
  - kernel
  - semantics
  - residual
---

## 来源

ISSUE-020（终态/overflow 语义统一）归档时发现：工作总结声称 `runtime-router` 的 `brain.agent.end` 已支持透传 `payload.status` 与 `payload.failureReason`，但代码验证未在 `runtime-router/` 下找到对应引用。

## 结论

经深入分析，透传逻辑**已实现**于 `runtime-router.ts`（L313-340），而非 `runtime-router/` 子目录。原始验证搜索范围有误（搜索了子目录而非主文件），导致误判为未实现。

代码确认：`runtime-router.ts` L318-319 解析 `failureReasonRaw` 和 `terminalStatusRaw`，L323-340 透传给 `orchestrator.handleAgentEnd()`，类型约束完整。

## 写入范围

无需修改。

## 验收标准

- [ ] `brain.agent.end` payload 中 `status` 和 `failureReason` 字段被正确透传
- [ ] `bun run build` 通过
