---
id: ISSUE-026
title: Cursor Help pool lane 并发冲突细化
status: done
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

## 工作总结（2026-03-15 第一轮实现）

- 已为 `ISSUE-026` 落下第一刀：新增集中式 `resolveSessionLaneConflict()` 判定函数，把 lane conflict 规则从零散条件收拢到单点入口。
- 当前已明确的第一批规则：
  - same-session `primary + compaction` 允许并行
  - same-session `title` 在已有 active lane（如 `primary`）时拒绝
  - same-session same-lane 仍视为 busy / reject
- Provider debug log 已新增 `provider.lane_conflict` 事件，能区分 lane rule reject 与普通 busy。
- 对应新增回归测试：
  - `allows same-session compaction while primary is active`
  - `rejects same-session title while primary is active`
- 本轮验证结果：
  - 聚焦测试 `src/sw/kernel/__tests__/web-chat-executor.browser.test.ts` 25/25 通过
  - `bun run build` 成功

## 相关 commits（2026-03-15 第一轮实现）

- 未提交

## 工作总结（2026-03-15 第二轮实现）

- 已继续补全 `ISSUE-026` 的 lane conflict 矩阵：
  - same-session `title` 在 active `compaction` 时拒绝
  - same-session `compaction` 在 active `title` 时拒绝
- 当前 title lane 已收紧为 same-session 独占 lane；`primary + compaction` 仍允许并行。
- `provider.lane_conflict` 事件继续沿用，lane rule reject 与普通 busy 的区分口径已明确。
- 对应新增回归测试：
  - `rejects same-session title while compaction is active`
  - `rejects same-session compaction while title is active`
- 本轮验证结果：
  - 聚焦测试 `src/sw/kernel/__tests__/web-chat-executor.browser.test.ts` 27/27 通过
  - `bun run build` 成功
- 至此，`ISSUE-026` 的验收口径已基本满足：
  - 冲突规则集中表达
  - primary / compaction / title 关键组合已覆盖
  - busy vs lane-rule-reject 有不同语义与日志

## 相关 commits（2026-03-15 第二轮实现）

- `a444abe` feat(cursor-help): ISSUE-026 lane conflict refinement — resolveSessionLaneConflict
- `158dba6` feat(cursor-help): ISSUE-026 round 2 — title/compaction lane mutual exclusion

> 注：以上两轮实现已合并入 main。
