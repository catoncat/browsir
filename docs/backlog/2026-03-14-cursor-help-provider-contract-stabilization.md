---
id: ISSUE-014
title: Cursor Help provider contract 稳定化
status: open
priority: p1
source: next-development-master-plan-2026-03-14 + slice breakdown
created: 2026-03-14
assignee: unassigned
kind: slice
epic: EPIC-2026-03-14-NEXT-PHASE
parallel_group: cursor-help
depends_on: []
write_scope:
  - extension/src/sw/kernel/web-chat-executor.browser.ts
  - extension/src/content/cursor-help-content.ts
  - extension/src/injected/cursor-help-page-hook.ts
  - extension/src/panel/components/ProviderSettingsView.vue
acceptance_ref: docs/next-development-slices-2026-03-14.md
tags: [slice, cursor-help, provider, inspect]
---

# ISSUE-014: Cursor Help provider contract 稳定化

## 目标

继续收紧 `inspect` / readiness / runtime mismatch / transport contract，保持 sidepanel 主聊 + hook 接管正式链路。

## 范围

- inspect 字段
- readiness 解释
- transport 事件摘要
- ProviderSettingsView 展示收口

## 非目标

- 不回退 direct-api
- 不恢复 DOM 回读成功路径

## 验收

- inspect 足以判断可执行性
- runtime mismatch 明确 fail fast
- UI 不泄露 direct-api / composer / DOM fallback 细节

