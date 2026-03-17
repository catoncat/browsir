---
id: ISSUE-024
title: Cursor Help pool slot 自动扩缩容
status: done
priority: p2
source: ISSUE-023 decomposition
created: 2026-03-15
assignee: agent
kind: slice
epic: EPIC-2026-03-15-CURSOR-HELP-POOL
parallel_group: cursor-help
depends_on: [ISSUE-025, ISSUE-026]  # 自动扩缩容应建立在健康检查与 lane 规则稳定之后
write_scope:
  - extension/src/sw/kernel/web-chat-executor.browser.ts
  - extension/src/panel/components/ProviderSettingsView.vue
acceptance_ref: docs/backlog/2026-03-15-cursor-help-pool-followup.md
tags: [slice, cursor-help, pool, autoscaling]
---

# ISSUE-024: Cursor Help pool slot 自动扩缩容

## 目标

让 `cursor_help_web` pool 不再固定为静态 slot 数量，而是能按负载自动扩容与回收。

## 范围

- 高负载时自动扩容到 `MAX_CURSOR_HELP_POOL_SLOT_COUNT`
- 低负载空闲超阈值后自动收缩回较小规模
- 扩缩容事件进入 debug / inspect 可见面
- 避免扩缩容过程破坏既有 slot 亲和性

## 非目标

- 不处理 Provider 连通性恢复
- 不改 page-hook / sender 探测逻辑
- 不引入另一套独立 pool 实现

## 验收

- pool 不再只依赖固定 slotCount 常量
- 扩容与收缩条件可在代码中明确表达并记录调试事件
- 扩缩容不会打断已有执行中的 slot
- 收缩逻辑不会误回收仍有亲和性或仍在执行的 slot
- 至少补一组针对扩缩容决策与冷却时间的回归测试

## 启动建议

- 建议排在 `ISSUE-025` 与 `ISSUE-026` 之后
- 在 pool 健康状态与 lane 冲突规则未稳定前，不要先做自动扩缩容

## 开工清单

- [ ] 明确扩容触发条件（排队长度、等待时长、lane 压力等）
- [ ] 明确收缩触发条件（空闲时间、心跳状态、亲和性残留）
- [ ] 设计扩缩容冷却时间，避免抖动
- [ ] 明确扩缩容时如何保留/迁移 slot affinity
- [ ] 把扩缩容事件与当前 slotCount 接到 debug state
- [ ] 补充至少一组扩缩容决策与冷却时间的回归测试

## 完成总结（2026-03-16）

ISSUE-024 已全部完成，实现内容包括：
- 自动扩容：`tryAutoExpandPool()` 在排队时创建新 slot（上限 `MAX_CURSOR_HELP_POOL_SLOT_COUNT`）
- 自动收缩：`tryAutoShrinkPool()` 在 idle 超时后回收 slot（下限 `MIN_CURSOR_HELP_POOL_SLOT_COUNT`）
- 冷却时间：收缩后 60s 内不重复收缩，避免抖动
- 亲和性保护：有 session affinity 的 slot 不回收
- Debug 可见：`lastAutoscaleEventAt` / `lastAutoscaleEvent` / `slotCount`
- 回归测试：4+ 个扩缩容测试全部通过（含 shrink cooldown / affinity 保护）

验收状态：✅ 全部满足

## 相关 commits

- `47d5a74` feat(cursor-help): ISSUE-027/025/026/024 - Pool 优化完整实现
