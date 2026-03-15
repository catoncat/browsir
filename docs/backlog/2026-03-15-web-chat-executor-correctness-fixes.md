---
id: ISSUE-030
title: "web-chat-executor 正确性修复 — TOCTOU 竞态 / transport_error / 测试隔离"
status: in-progress
priority: p0
source: "review/2026-03-15-round1-cursor-help-pool-review.md"
created: 2026-03-15
assignee: copilot-agent
kind: slice
epic: EPIC-2026-03-15-CURSOR-HELP-POOL
parallel_group: cursor-help
depends_on: []
write_scope:
  - extension/src/sw/kernel/web-chat-executor.browser.ts
  - extension/src/sw/kernel/__tests__/web-chat-executor.browser.test.ts
tags: [slice, cursor-help, pool, critical, correctness]
---

# ISSUE-030: web-chat-executor 正确性修复

## 来源

Round 1 Code Review — 3 个 CRITICAL + 5 个 HIGH 发现。

## 修复清单

### CRITICAL

- [ ] **C1**: `__resetCursorHelpWebProviderTestState()` 中对 7 个 module-level Map 调用 `.clear()`，同时将 `cursorHelpSlotLifecycleBound*` 置 null
- [ ] **C2**: `send()` 中 slot 分配引入原子 acquire/release，消除 TOCTOU 竞态
- [ ] **C3**: `transport_error` 路径改用 `failExecution(entry, event.error)` 替代 `closeExecution(entry)`

### HIGH

- [ ] **H1**: 删除死代码 `classifySlotStatusFromInspect`
- [ ] **H2**: 将 `CURSOR_HELP_HEARTBEAT_RECOVERY_RETRY_MS` 从 1ms 调整为合理值（500ms）或移除
- [ ] **H3**: `getCursorHelpPoolDebugState` 中 `chrome.windows.get()` 只调一次
- [ ] **H4**: `closeExecution` 中清空 `entry.queue`（`entry.queue.length = 0`）
- [ ] **H5**: `reconcileCursorHelpPoolState` 引入互斥锁

### 新增测试

- [ ] **H6**: 修复或定义 `defaultExecuteResponse()`
- [ ] **H8**: 添加 `transport_error` 事件传播测试
- [ ] **H9**: 添加 abort signal 传播测试
- [ ] **H10**: 添加 `sendTabMessageWithRetry` 失败/重试测试

## 验收

- 所有 CRITICAL 修复落地
- 测试套件增加至少 3 个新场景（transport_error / abort / retry）
- 现有 28 个测试继续通过
- `bun run build` 成功
