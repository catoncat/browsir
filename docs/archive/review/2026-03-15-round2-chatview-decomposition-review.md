# Round 2 Review: ChatView 拆分

**日期**: 2026-03-15
**审查范围**: App.vue (-3216行), ChatView.vue (+887行), 10个 composables (+2731行)
**涉及 Agent**: Agent 2 (Chat/UI), ISSUE-017 commit `9501a7b`

---

## 总体评价

拆分整体结构合理：依赖图无循环，composable 边界逻辑清晰，Chrome listener 和定时器清理到位。

---

## CRITICAL（2 项）

### C1: fork title 的异步竞态
**文件**: `use-chat-session-effects.ts` L172-195
**问题**: 对 `activeForkSourceSessionId` 的 watch 回调中发起异步 `chrome.runtime.sendMessage`，无 staleness check。快速切换 session 时，旧响应会覆盖当前 `forkSourceResolvedTitle`。
**修复**: 在 await 前捕获 sourceId，await 后比对是否仍为当前值。

### C2: bindLlmStreaming 时序耦合
**文件**: `ChatView.vue` L254-272
**问题**: `useToolRunTracking` 的 `bindLlmStreaming()` 必须在 `useLlmStreaming()` 之后手动调用。若 `chrome.runtime.onMessage` 在 mount 同步阶段触发工具运行事件，`llmStreamingBindings` 仍为 null，事件被静默丢弃。
**修复**: 将 LLM streaming deps 直接注入 `useToolRunTracking` 构造函数，或添加 runtime assertion 防止漏调。

---

## HIGH（3 项）

### H1: WritableComputedRef 类型隐患
**文件**: `use-chat-session-effects.ts` L11
**问题**: `runPhase` 的类型签名要求 `WritableComputedRef`，但若 `useToolRunTracking` 重构为只读 computed，写入端静默失效。
**修复**: 在 `useToolRunTracking` 返回类型中显式声明。

### H2: 异步 watcher 无 unmount 守卫
**文件**: `use-chat-session-effects.ts` L79-83, L110-114
**问题**: `void deps.runSafely(...)` 在组件 unmount 后仍可能写入 stale refs。
**修复**: 使用 `disposed` flag 或 AbortController。

### H3: defineExpose 耦合 App → ChatView 内部
**文件**: `ChatView.vue` L480, `App.vue` L71-72
**问题**: App.vue 通过 templateRef 直接访问 ChatView 的 `sessionListRenderState`，破坏封装。
**修复**: 提升到共享 Pinia store 或暴露窄接口。

---

## MEDIUM（4 项）

| # | 问题 | 位置 |
|---|------|------|
| M1 | App.vue 中 `activeSessionId` 未使用 | App.vue L19 |
| M2 | `useChatSessionEffects` 接收 32 个依赖，接口过宽 | use-chat-session-effects.ts |
| M3 | `useToolRunTracking` 返回 28 项，仍是"mini-monolith" | use-tool-run-tracking.ts |
| M4 | `rebuildStableMessages` 异步 watch 可能并发执行插件 hook | ChatView.vue L428 |

---

## LOW（3 项）

| # | 问题 |
|---|------|
| L1 | `handleExport` 创建的 `<a>` 元素未清理 href |
| L2 | LLM streaming deps 类型窄化正确但应记录 |
| L3 | 无 composables/index.ts barrel 文件 |

---

## 正面评价

- 依赖图无循环
- Chrome listener 正确 add/remove
- VueUse 自动清理（useIntervalFn, onClickOutside）
- staleToken 防竞态模式正确
- 所有定时器有对应清理路径
- ChatView `onUnmounted` 调用全部 5 个 cleanup 函数
