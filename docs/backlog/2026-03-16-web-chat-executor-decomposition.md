---
id: ISSUE-035
title: "web-chat-executor 拆分 — pool/execution/heartbeat/window 职责分离"
status: open
priority: p2
source: "ISSUE-023 code quality review"
created: 2026-03-16
assignee: unassigned
kind: refactor
tags:
  - kernel
  - refactor
  - cursor-help
  - pool
---

# ISSUE-035: web-chat-executor 拆分 — pool/execution/heartbeat/window 职责分离

## 背景

`web-chat-executor.browser.ts` 当前 2389 行 / 85 个函数，混合了 6+ 个不同职责域：

| 职责 | 大致行数 | 说明 |
|------|---------|------|
| 执行生命周期 | ~200 | PendingExecution 管理、enqueue/close/fail/watchdog |
| Pool 状态管理 | ~400 | slot CRUD、persist/load、normalize |
| 心跳/健康监控 | ~200 | heartbeat timer、slot health classify、soft recovery |
| 窗口策略 | ~300 | window policy state、recovery actions、background decisions |
| 自动扩缩容 | ~100 | tryAutoExpandPool/tryAutoShrinkPool |
| Provider send + runtime message | ~200 | createCursorHelpWebProvider、handleWebChatRuntimeMessage |
| Slot 选择/等待 | ~200 | chooseCursorHelpSlot、waitForCursorHelpSlot、affinity |
| 辅助工具 | ~100 | Lane conflict、slot lifecycle、tab message retry |

## 拆分候选（按收益排序）

### P1: 执行生命周期提取

提取 `PendingExecution` 管理到 `cursor-help-execution.ts`：
- `releaseExecution`, `closeExecution`, `failExecution`
- `touchExecution`, `armExecutionWatchdog`
- `enqueueHostedEvent`
- `clearStaleExecution`, `reapStaleExecutionsForSlots`
- 相关 Map 状态：`ACTIVE_BY_REQUEST_ID`, `ACTIVE_REQUEST_ID_BY_SLOT`, `ACTIVE_REQUEST_ID_BY_TAB`, `ACTIVE_REQUEST_ID_BY_SESSION_LANE`

### P2: 窗口策略提取

提取窗口/recovery 逻辑到 `cursor-help-window-policy.ts`：
- `buildCursorHelpWindowPolicyState`
- `resolveCursorHelpWindowRuntimeState`
- `resolveMissingPoolWindowRecoveryAction`
- `buildCursorHelpWindowRecoveryPreview`
- `buildCursorHelpAdoptDecisionPreview`
- `buildCursorHelpBackgroundDecisionPreview`

### P3: 心跳/健康监控提取

提取心跳系统到 `cursor-help-heartbeat.ts`：
- `resolveHeartbeatDelay`
- `scheduleCursorHelpPoolHeartbeat`
- `classifyInspectHealth`
- `buildSlotHealthSnapshot`
- `attemptCursorHelpSlotRecovery`
- `attemptCursorHelpSlotSoftRecovery`

### P4: Pool 状态持久化提取

提取 pool 状态管理到 `cursor-help-pool-state.ts`：
- `loadCursorHelpPoolState`, `persistCursorHelpPoolState`, `saveCursorHelpPoolState`
- `normalizePoolState`, `normalizeSlotRecord`, `cloneSlotRecord`
- `patchCursorHelpSlotState`

## 验收标准

- 每个提取后 `bun run build` 通过
- web-chat-executor 测试全部通过
- 不改变任何运行时行为
- 每个提取单独 commit

## 约束

- 不改变 MV3 service worker 的入口接口
- content script / page hook 不受影响（自包含设计）
- 若提取后发现循环依赖需人工评估
