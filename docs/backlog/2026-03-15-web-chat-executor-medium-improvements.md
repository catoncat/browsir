---
id: ISSUE-031
title: "web-chat-executor MEDIUM 级改进 — lane 文档 / 重试策略 / 状态一致性"
status: open
priority: p1
source: "review/2026-03-15-round1-cursor-help-pool-review.md"
created: 2026-03-15
assignee: unassigned
kind: slice
epic: EPIC-2026-03-15-CURSOR-HELP-POOL
parallel_group: cursor-help
depends_on: [ISSUE-030]
write_scope:
  - extension/src/sw/kernel/web-chat-executor.browser.ts
  - extension/src/injected/cursor-help-page-hook.ts
  - extension/src/panel/components/ProviderSettingsView.vue
tags: [slice, cursor-help, pool, medium, quality]
---

# ISSUE-031: web-chat-executor MEDIUM 级改进

## 来源

Round 1 Code Review — 9 个 MEDIUM 发现。

## 修复清单

- [ ] **M1**: 在 `resolveSessionLaneConflict` 中添加注释说明不对称规则的设计意图
- [ ] **M2**: `failExecution` 中 `patchSlotState` 至少添加错误日志而非空 catch
- [ ] **M3**: `sendTabMessageWithRetry` 对已知永久性失败短路（如 "Could not establish connection"），考虑指数退避
- [ ] **M4**: SW 重启后 listener 累积问题 — 在添加前检查并清理旧 listener
- [ ] **M5**: `waitForCursorHelpSlot` 考虑递增轮询间隔或仅在状态变化时 reconcile
- [ ] **M6**: `closeExecution` 在 slot 处于 `recovering` 时不覆盖为 `idle`
- [ ] **M7**: page-hook `!latest` 分支添加 `logToContent` 日志
- [ ] **M8**: page-hook postMessage listener 考虑 per-session nonce（可延后评估）
- [ ] **M9**: ProviderSettingsView `handleSave` 连接探测失败时 early return 不关闭对话框

## 验收

- 所有 MEDIUM 项处理完毕（修复或记录为 accepted risk）
- 现有测试继续通过
