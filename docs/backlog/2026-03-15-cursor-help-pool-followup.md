---
id: ISSUE-023
title: "cursor_help_web Pool 架构后续 — multi-conversation / 扩缩容 / 健康检查"
status: open
priority: p2
source: implementation-review
created: 2026-03-15
assignee: ""
kind: epic
depends_on: []
write_scope:
  - extension/src/sw/kernel/web-chat-executor.browser.ts
  - extension/src/content/cursor-help-content.ts
  - extension/src/injected/cursor-help-page-hook.ts
  - extension/src/shared/cursor-help-protocol.ts
  - extension/src/panel/components/ProviderSettingsView.vue
tags:
  - cursor-help
  - pool
  - multi-conversation
---

# ISSUE-023: cursor_help_web Pool 架构后续

## 背景

f0ddbd3 完成了 Pool/Slot/Lane 核心架构：
- 后台专用窗 + 3 slot（1 primary + 2 auxiliary）
- Lane 路由（primary > compaction > title）
- Slot 亲和性（conversationKey / sessionId）
- Debug 接口 + UI 状态面板

以下是已识别的后续工作项。

## 后续工作项

### S1: in-page multi-conversation 真正流通 conversationKey

当前 conversationKey 的来源是 `request_started` 事件的 `meta.sessionKey`，但 page-hook 侧尚未实现真正的 sessionKey/conversationKey 生成和传递。需要：
- page-hook 为每个 slot 的每次新对话生成唯一 conversationKey
- 通过 `WEBCHAT_EXECUTE` payload 的 `conversationKey` 字段下发到 page-hook
- page-hook 据此决定在已有对话框继续还是开启新对话

参考：`/Users/envvar/P/Cursor-Toolbox` 的 sessionKey/conversationKey 设计

### S2: Slot 自动扩缩容

当前 slot 数量固定（默认 3）。可增加：
- 高负载时自动扩容到 `MAX_CURSOR_HELP_POOL_SLOT_COUNT`（6）
- 空闲超阈值后自动收缩回最小数量
- 扩缩容事件记录到 debug store

### S3: Slot 健康检查心跳

当前 slot 状态依赖 `ensureCursorHelpSlotUsable` 的按需检查。可增加：
- 定期心跳（如 30s）主动探测 slot tab 存活和页面状态
- 自动标记 stale/error 并触发恢复
- 减少请求时才发现 slot 不可用的延迟

### S4: 并发 conflict 细化

当前 `ACTIVE_REQUEST_ID_BY_SESSION_LANE` 使用 `sessionId:lane` 作为互斥 key。可优化：
- 同一 session 的 compaction 和 title 请求允许真正并发（各占不同 auxiliary slot）
- primary + compaction 对同一 session 的互斥需更严格验证

### S5: Pool 窗口行为优化

- 确认 offscreen window minimized 状态在 macOS / Windows / Linux 的一致性
- 窗口被用户意外关闭后的自动重建策略优化
- 调研 `chrome.offscreen` API 是否可替代 minimized window（MV3 限制评估）
