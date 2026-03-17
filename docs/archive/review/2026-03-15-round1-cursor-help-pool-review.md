# Round 1 Review: Cursor Help Pool 核心

**日期**: 2026-03-15
**审查范围**: web-chat-executor.browser.ts (+2015行), 对应测试文件 (+1198行), cursor-help-page-hook.ts (+137行), ProviderSettingsView.vue (+230行)
**涉及 Agent**: Agent 1 (Cursor Help), Agent 2 (Chat/UI), Agent 3 (调试)

---

## CRITICAL（3 项 — 必须修复）

### C1: 测试状态重置不完整
**文件**: `web-chat-executor.browser.ts` L141-149
**问题**: `__resetCursorHelpWebProviderTestState()` 未清除 7 个 module-level Map（`ACTIVE_BY_REQUEST_ID`, `ACTIVE_REQUEST_ID_BY_SLOT`, `ACTIVE_REQUEST_ID_BY_TAB`, `ACTIVE_REQUEST_ID_BY_SESSION_LANE`, `PREFERRED_SLOT_ID_BY_SESSION`, `PREFERRED_SLOT_ID_BY_CONVERSATION`, `LAST_CONVERSATION_KEY_BY_SESSION`），测试隔离靠偶然的 unique sessionId。
**修复**: 在 reset 函数中对所有 7 个 Map 调用 `.clear()`，同时将 `cursorHelpSlotLifecycleBoundTabs`/`Windows` 置 null。

### C2: send() 中 TOCTOU slot 分配竞态
**文件**: `web-chat-executor.browser.ts` L2029-2044
**问题**: 在 guard `ACTIVE_REQUEST_ID_BY_SLOT.has(slot.slotId)` (L2039) 与 `markCursorHelpSlotBusy` (L2072) 之间无锁。两个并发 `send()` 可同时通过检查并分配同一 slot，导致第一个请求的 execution mapping 被覆盖且永远无法 close。
**修复**: 引入 per-slot acquire/release 机制（如在检查后立即设置一个占位标记），或将整个 slot 选择 + 标记操作改为同步原子操作。

### C3: transport_error 使用错误的关闭路径
**文件**: `web-chat-executor.browser.ts` L2201-2205
**问题**: `hosted_chat.transport_error` 事件调用 `closeExecution(entry)`（clean close），将 slot 设为 `idle` 并调用 `controller.close()`。错误无法通过 ReadableStream 传播到消费端。应使用 `failExecution(entry, event.error)` 以通过 `controller.error()` 传播，并将 slot 标记为 `error`/`stale`。
**修复**: 将 `closeExecution(entry)` 替换为 `failExecution(entry, event.error || "transport_error")`。

---

## HIGH（10 项 — 尽快修复）

### H1: classifySlotStatusFromInspect 死代码
**文件**: `web-chat-executor.browser.ts` L1488-1496
**问题**: 定义但无调用点，与 `classifyInspectHealth()` 有微妙差异，会随主逻辑漂移。
**修复**: 删除。

### H2: 恢复重试延迟 1ms 疑为调试遗留
**文件**: `web-chat-executor.browser.ts` L115
**问题**: `CURSOR_HELP_HEARTBEAT_RECOVERY_RETRY_MS = 1`，对脚本加载后重新 inspect 无实际等待意义。
**修复**: 改为合理值（如 500-1000ms）或删除该 await。

### H3: getCursorHelpPoolDebugState 双重 windows.get 调用
**文件**: `web-chat-executor.browser.ts` L1822-1826
**问题**: `chrome.windows.get()` 在三元条件和结果中各调一次，存在 TOCTOU 且浪费 API 调用。
**修复**: 只调一次，赋给变量。

### H4: PendingExecution.queue 内存泄漏
**文件**: `web-chat-executor.browser.ts` L2053-2065
**问题**: 若 ReadableStream 被放弃（消费者 abort），`cancel()` 回调调用 `closeExecution` 但不清空 `entry.queue`。
**修复**: 在 `closeExecution` 中添加 `entry.queue.length = 0`。

### H5: reconcileCursorHelpPoolState 并发覆写
**文件**: `web-chat-executor.browser.ts` L1366-1467
**问题**: 无读-改-写守卫，心跳与 `send()` 轮询并发调用会互覆 slot 状态。
**修复**: 引入 reconcile 互斥锁（如 `reconcileInFlight` Promise chain）。

### H6: 测试中 defaultExecuteResponse() 未定义
**文件**: `web-chat-executor.browser.test.ts` L1162
**问题**: `sendMessage.mockImplementation` fallthrough 调用 `defaultExecuteResponse()` 但该函数从未定义。runtime 会 ReferenceError。
**修复**: 定义该函数或替换为 `{ ok: true }`。

### H7: 测试 lifecycle binding 变量未 reset
**文件**: `web-chat-executor.browser.test.ts` 
**问题**: `cursorHelpSlotLifecycleBoundTabs`/`Windows` 跨测试泄漏，旧 listener 指向 stale chrome mock。
**修复**: 在 reset 函数中将其置 null。

### H8: 零测试覆盖 transport_error 路径
**严重性**: 高  
**修复**: 添加 `transport_error` 事件传播测试。

### H9: 零测试覆盖 abort signal 传播
**严重性**: 高  
**修复**: 添加 `AbortController.abort()` → stream 终止测试。

### H10: 零测试覆盖 sendTabMessageWithRetry 失败/重试
**严重性**: 高  
**修复**: 添加 sendMessage 失败重试和最终失败测试。

---

## MEDIUM（9 项）

### M1: Lane conflict 规则不对称缺乏文档
**文件**: executor L237-268
**问题**: `activeTitle` 阻止所有 lane，但 `activePrimary` 只阻止 `title`。这种不对称可能是有意的但无注释。

### M2: failExecution 中 patchSlotState fire-and-forget
**文件**: executor L706-726
**问题**: `patchCursorHelpSlotState(...).catch(() => {})` 失败被吞。

### M3: sendTabMessageWithRetry 固定 12×250ms 无退避
**文件**: executor L1909-1920
**问题**: 对已知永久性失败（tab 已导航）仍重试 3 秒。

### M4: SW 重启后 listener 累积风险
**文件**: executor L1732-1744
**问题**: Service Worker 重启后模块变量 reset，但 `chrome.tabs` 对象不变，`addListener` 会添加新闭包。

### M5: waitForCursorHelpSlot 200ms 轮询过激
**文件**: executor L1616-1667
**问题**: 每 200ms 全量 reconcile + load/save storage，创建多余 tab 且立即被下一轮覆盖。

### M6: closeExecution 无条件设 slot 为 idle
**文件**: executor L680-698
**问题**: 会覆盖 `recovering` 状态。

### M7: page-hook sender rejection 静默丢弃
**文件**: cursor-help-page-hook.ts ~L1056
**问题**: `!latest` 分支无日志。

### M8: page-hook postMessage 无 per-session nonce
**文件**: cursor-help-page-hook.ts ~L1098
**问题**: 同页面的其他脚本可伪造 `WEBCHAT_EXECUTE` 消息。

### M9: handleSave 连接探测失败后仍关闭对话框
**文件**: ProviderSettingsView.vue ~L833
**问题**: `localError` 被设置但 `emit("close")` 仍然执行。

---

## LOW（8 项）

| # | 位置 | 问题 |
|---|------|------|
| L1 | executor L1886 | `tabDecisionTrace` 不在 interface 声明中 |
| L2 | executor L282 | `cloneSlotRecord` 名称暗示深拷贝但只做浅拷贝 |
| L3 | executor 多处 | `clearLegacySessionSlots` 部分路径未调用 |
| L4 | page-hook | 构建产物无 CI 自动检查 top-level import |
| L5 | page-hook | `compiledPromptLength` 在 transport 事件中暴露 |
| L6 | Vue onMounted | fire-and-forget promise 无生命周期清理 |
| L7 | Vue | 心跳"下次约"显示为静态快照 |
| L8 | 测试 | guard-clause return 可能跳过后续断言 |
