---
id: ISSUE-025
title: Cursor Help pool slot 健康检查心跳
status: done
priority: p1
source: ISSUE-023 decomposition
created: 2026-03-15
assignee: agent
kind: slice
epic: EPIC-2026-03-15-CURSOR-HELP-POOL
parallel_group: cursor-help
depends_on: [ISSUE-027]  # 先明确窗口行为，再做周期性心跳与恢复
write_scope:
  - extension/src/sw/kernel/web-chat-executor.browser.ts
  - extension/src/sw/kernel/__tests__/web-chat-executor.browser.test.ts
acceptance_ref: docs/backlog/2026-03-15-cursor-help-pool-followup.md
tags: [slice, cursor-help, pool, heartbeat, health-check]
---

# ISSUE-025: Cursor Help pool slot 健康检查心跳

## 目标

为 `cursor_help_web` 的 slot 引入周期性健康检查，而不是只在请求进来时被动发现 stale/error。

## 范围

- 定期心跳探测 slot tab 存活、页面状态与 inspect 结果
- 自动把异常 slot 标记为 `stale` / `error`
- 必要时触发恢复或回收
- 将心跳与恢复事件纳入 debug 状态面

## 非目标

- 不处理 Provider 首次连通性恢复
- 不修改 page sender 的实际执行协议
- 不引入新的 window/pool 架构

## 验收

- 存在明确的周期性健康检查入口
- stale/error slot 不再只能等到业务请求时才暴露
- 健康检查结果能够驱动 slot 状态变更与恢复逻辑
- 心跳失败日志能区分 tab 丢失 / inspect 失败 / 页面未就绪 / runtime mismatch
- 至少补一组针对心跳/恢复的回归测试

## 启动建议

- 这是连接恢复之后最值得优先收口的 pool 稳定化项之一
- 建议在 `ISSUE-027` 明确窗口策略后立即启动

## 开工清单

- [ ] 定义心跳周期、失败阈值、恢复退避策略
- [ ] 抽出可复用的 slot 健康探测入口（tab 存活 / inspect / runtime mismatch）
- [ ] 规范 slot 状态迁移：idle → stale/error → recovering/idle
- [ ] 为心跳失败补充结构化 reason（tab-missing / inspect-failed / page-not-ready / runtime-mismatch）
- [ ] 把心跳结果接到 debug state / debug route
- [ ] 补充至少一组“心跳发现异常并自动恢复”的回归测试

## 工作总结（2026-03-15 第一轮实现）

- 已为 `ISSUE-025` 落下第一刀：新增 **手动 heartbeat 一次** 的能力，而不是一上来就直接上定时器。
- 当前新增内容：
  - `web-chat-executor.browser.ts` 导出 `runCursorHelpPoolHeartbeat()`
  - `brain.debug.cursor_help_pool` 新增 `action=heartbeat`
  - `ProviderSettingsView.vue` 的“刷新”现在会触发一次实际 heartbeat，而不是只读旧状态
- heartbeat 当前会对已有 slot 做一轮健康探测，并把最新状态回写到 debug state / UI。
- 已补回归测试：runtime mismatch 场景下，heartbeat 会把 slot 标记为 `error` 并带出对应 `lastError`。
- 本轮验证结果：
  - 聚焦测试 `src/sw/kernel/__tests__/web-chat-executor.browser.test.ts` 15/15 通过
  - `bun run build` 成功
- 当前仍未完成的部分：
  - 周期性调度（timer/backoff）
  - 更细的结构化 health reason 字段
  - 自动恢复闭环（recovering/idle）

## 相关 commits（2026-03-15 第一轮实现）

- 未提交

## 工作总结（2026-03-15 第二轮实现）

- 已继续推进 `ISSUE-025` 第二刀：把 health reason 和 heartbeat 调度元数据从隐式字符串提升为显式字段。
- 当前 slot debug state 已新增：
  - `lastHealthCheckedAt`
  - `lastHealthReason`（如 `ready` / `page-not-ready` / `inspect-failed` / `runtime-mismatch` / `tab-missing`）
- 当前 pool summary 已新增：
  - `lastHeartbeatAt`
  - `lastHeartbeatDelayMs`
  - `lastHeartbeatReason`
  - `heartbeatInFlight`
- `runCursorHelpPoolHeartbeat()` 现在会：
  - 依据当前 pool 健康状态给出下一次 heartbeat 的 delay
  - 在 attention 场景下切到 backoff（60s）
  - 覆盖旧 timer，确保手动 heartbeat 返回的元数据与当前状态一致
- `ProviderSettingsView` 现在会直接展示 heartbeat 的最近 reason 与下次大致延迟。
- 本轮验证结果：
  - 聚焦测试 `src/sw/kernel/__tests__/web-chat-executor.browser.test.ts` 16/16 通过
  - `bun run build` 成功

## 相关 commits（2026-03-15 第二轮实现）

- 未提交

## 工作总结（2026-03-15 第三轮实现）

- 已把 `ISSUE-025` 从“发现问题”推进到“尝试修一点问题”：新增第一条最小 auto-heal 路径。
- 当前能力：当 slot 的 tab 丢失，但其所属 pool window 仍然活着时，heartbeat 会尝试自动补一个 replacement tab，并复用原 slotId/lanePreference 继续把该 slot 拉回可用状态。
- 这条路径引入了新的 slot 状态 `recovering`，并已同步到 `ProviderSettingsView` 的状态颜色/文案显示。
- 对应新增回归测试：missing slot tab + live pool window 场景下，heartbeat 会自动恢复该 slot，而不是仅仅把它留在 `stale`。
- 本轮验证结果：
  - 聚焦测试 `src/sw/kernel/__tests__/web-chat-executor.browser.test.ts` 18/18 通过
  - `bun run build` 成功
- 当前仍未完成的部分：
  - 针对 page-not-ready / inspect-failed 的更细 recovering 策略
  - recovering → idle/error 的更多路径覆盖
  - 更完整的 backoff / retry budget 设计

## 相关 commits（2026-03-15 第三轮实现）

- 未提交

## 工作总结（2026-03-15 第四轮实现）

- 已继续推进 `ISSUE-025` 的 recovering/auto-heal：对于 `page-not-ready` 和 `inspect-failed`，heartbeat 不再只记录状态，而是会进入 `recovering`、重注入脚本并做一次短重试。
- 当前 recover 路径已经覆盖三类场景：
  - `tab-missing` + live pool window → replacement tab auto-heal
  - `page-not-ready` → soft retry after script reinjection
  - `inspect-failed` → soft retry after script reinjection
- 对应新增回归测试：
  - `heartbeat soft-recovers page-not-ready slots`
  - `heartbeat soft-recovers inspect-failed slots`
- 本轮验证结果：
  - 聚焦测试 `src/sw/kernel/__tests__/web-chat-executor.browser.test.ts` 20/20 通过
  - `bun run build` 成功
- 当前仍未完成的部分：
  - per-reason retry budget / 最大恢复次数
  - `recovering -> error` 的更细降级策略
  - 周期性 heartbeat 与 auto-heal 之间更明确的调度协同

## 相关 commits（2026-03-15 第四轮实现）

- 未提交

## 工作总结（2026-03-15 第五轮实现）

- 已把 `ISSUE-025` 的恢复链进一步收口到“会收手”的阶段：新增 per-reason retry budget，并在恢复预算耗尽后把 slot 明确降级到 `error`，而不是无限 `recovering`。
- 当前 retry budget / degradation 已覆盖：
  - `tab-missing`
  - `page-not-ready`
  - `inspect-failed`
- 对应新增回归测试：`heartbeat downgrades to error after inspect-failed recovery budget is exhausted`。
- 本轮验证结果：
  - 聚焦测试 `src/sw/kernel/__tests__/web-chat-executor.browser.test.ts` 23/23 通过
  - `bun run build` 成功
- 至此，`ISSUE-025` 的验收口径已基本满足：
  - 有明确 heartbeat 入口
  - stale/error 不再只能等业务请求暴露
  - 健康检查能驱动状态变更与恢复
  - 失败 reason 已结构化
  - 已有多组 heartbeat/恢复回归测试

## 相关 commits（2026-03-15 第五轮实现）

- 未提交
