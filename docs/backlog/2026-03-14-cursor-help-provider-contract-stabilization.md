---
id: ISSUE-014
title: "Cursor Help provider contract 稳定化"
status: done
priority: p1
source: "next-development-master-plan-2026-03-14 + slice breakdown"
created: 2026-03-14
assignee: agent
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
tags:
  - slice
  - cursor-help
  - provider
  - inspect
claimed_at: "2026-03-14T12:12:44.462Z"
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
- 构建后确认 cursor-help-page-hook 产物为单文件可执行，无顶层 import/export

## 工作总结

**日期**: 2026-03-14

**结论**：经全面审查，4 项验收标准均已满足，无需代码修改。

**审查明细**：

1. **inspect 足以判断可执行性** — `CursorHelpInspectResult` 含完整字段：`canExecute`, `pageHookReady`, `fetchHookReady`, `senderReady`, `runtimeMismatch`, `runtimeMismatchReason`, `selectedModel`, `availableModels`, `senderKind`
2. **runtime mismatch fail fast** — `tryUseTabForSession` 在 `runtimeMismatch` 时直接 throw；`shouldPropagateInspectFailure` 确保 mismatch 错误向上传播，不被 catch 吞掉
3. **UI 不泄露内部细节** — ProviderSettingsView 模板仅显示产品文案（“已连接”/“等待聊天入口”/“等待页面就绪”）；web-chat-executor 无 legacy/fallback/direct-api/compat 代码
4. **page-hook 单文件** — 构建产物 `dist/assets/cursor-help-page-hook.js` 确认 0 个顶层 import/export，完全自包含

## 相关 commits

- 无代码修改，仅审查确认

