---
id: ISSUE-026
title: Cursor Help pool lane 并发冲突细化
status: in-progress
priority: p2
source: ISSUE-023 decomposition
created: 2026-03-15
assignee: agent
kind: slice
epic: EPIC-2026-03-15-CURSOR-HELP-POOL
parallel_group: cursor-help
depends_on: [ISSUE-025]  # 先让 slot 健康状态可观测，再细化 lane 冲突矩阵
write_scope:
  - extension/src/sw/kernel/web-chat-executor.browser.ts
acceptance_ref: docs/backlog/2026-03-15-cursor-help-pool-followup.md
tags: [slice, cursor-help, pool, lane, concurrency]
---

# ISSUE-026: Cursor Help pool lane 并发冲突细化

## 目标

收紧 `ACTIVE_REQUEST_ID_BY_SESSION_LANE` 及 lane 调度语义，让 primary / compaction / title 的互斥规则更贴近真实需求。

## 范围

- 重新定义 `sessionId:lane` 互斥粒度
- 区分允许并发与必须串行的 lane 组合
- 保持 slot affinity 与 lane 选择逻辑一致
- 输出更清晰的 busy/conflict 调试信息

## 非目标

- 不处理 Provider 首次连通性恢复
- 不处理 slot 数量扩缩容
- 不改 page-hook / content 注入逻辑

## 验收

- 并发冲突规则在代码中有集中表达，而不是分散在多处条件判断
- 至少覆盖 primary / compaction / title 的关键组合场景
- 冲突失败日志能区分“真 busy”与“lane 规则拒绝”
- 冲突规则与 slot affinity / session affinity 不互相打架

## 启动建议

- 建议排在 `ISSUE-025` 之后
- 先有心跳/恢复证据，再细化 busy 与 conflict 的语义边界更稳妥

## 开工清单

- [ ] 盘点当前 lane 互斥点：primary / compaction / title / affinity 组合
- [ ] 定义允许并发与必须串行的 lane 矩阵
- [ ] 抽出集中式 conflict 判定函数，避免分散条件判断
- [ ] 调整 busy / rejected / retryable 的错误语义与日志文案
- [ ] 覆盖至少一组 primary+compaction、compaction+title、same-session title 的组合测试
