---
id: ISSUE-023
title: "cursor_help_web Pool 架构后续 — multi-conversation / 扩缩容 / 健康检查"
status: in-progress
priority: p1
source: implementation-review
created: 2026-03-15
assignee: human
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

> **2026-03-15 当前分工**：Provider 连通性 / 连接恢复由 human 继续处理；agent 侧后续默认回到 backlog 梳理与其余未收口事项的拆分/记录，避免继续与连接修复共享写入面。

## 后续 slice 启动顺序（连接恢复之后）

建议顺序：`ISSUE-027` → `ISSUE-025` → `ISSUE-026` → `ISSUE-024`

- `ISSUE-027` 先明确窗口策略与用户干扰边界
- `ISSUE-025` 再补 slot 健康检查 / 恢复闭环
- `ISSUE-026` 之后再细化 lane conflict 语义
- `ISSUE-024` 最后再做自动扩缩容，避免在未稳定的 pool 上继续放大复杂度

## 后续工作项

### S1: in-page multi-conversation 真正流通 conversationKey

当前 conversationKey 的来源是 `request_started` 事件的 `meta.sessionKey`，但 page-hook 侧尚未实现真正的 sessionKey/conversationKey 生成和传递。需要：
- page-hook 为每个 slot 的每次新对话生成唯一 conversationKey
- 通过 `WEBCHAT_EXECUTE` payload 的 `conversationKey` 字段下发到 page-hook
- page-hook 据此决定在已有对话框继续还是开启新对话

参考：`/Users/envvar/P/Cursor-Toolbox` 的 sessionKey/conversationKey 设计

### S2: Slot 自动扩缩容

对应 backlog slice：[`ISSUE-024`](./2026-03-15-cursor-help-pool-autoscaling.md)

当前 slot 数量固定（默认 3）。可增加：
- 高负载时自动扩容到 `MAX_CURSOR_HELP_POOL_SLOT_COUNT`（6）
- 空闲超阈值后自动收缩回最小数量
- 扩缩容事件记录到 debug store

### S3: Slot 健康检查心跳

对应 backlog slice：[`ISSUE-025`](./2026-03-15-cursor-help-pool-heartbeat.md)

当前 slot 状态依赖 `ensureCursorHelpSlotUsable` 的按需检查。可增加：
- 定期心跳（如 30s）主动探测 slot tab 存活和页面状态
- 自动标记 stale/error 并触发恢复
- 减少请求时才发现 slot 不可用的延迟

### S4: 并发 conflict 细化

对应 backlog slice：[`ISSUE-026`](./2026-03-15-cursor-help-pool-lane-conflict-refinement.md)

当前 `ACTIVE_REQUEST_ID_BY_SESSION_LANE` 使用 `sessionId:lane` 作为互斥 key。可优化：
- 同一 session 的 compaction 和 title 请求允许真正并发（各占不同 auxiliary slot）
- primary + compaction 对同一 session 的互斥需更严格验证

### S5: Pool 窗口行为优化

对应 backlog slice：[`ISSUE-027`](./2026-03-15-cursor-help-pool-window-behavior.md)

- 确认 offscreen window minimized 状态在 macOS / Windows / Linux 的一致性
- 窗口被用户意外关闭后的自动重建策略优化
- 调研 `chrome.offscreen` API 是否可替代 minimized window（MV3 限制评估）

## 调查记录

### 2026-03-15 当前故障补记

- 当前实测故障并非 transport / SSE / conversationKey 末端链路，而是更早的 **native sender 输入探测阶段** 即失败。
- 现象为主/辅 slot 均返回：`Cursor Help 内部入口未就绪。未找到 Cursor Help 聊天输入组件`。
- 结合实现核对，当前风险最高的触发点是：
  - pool 专用窗口创建后立即 `minimized`
  - content/page hook 侧大量依赖 `getClientRects()` / `getBoundingClientRect()` 做“可见输入框”判定
  - macOS 下最小化窗口可能导致输入框、按钮和 React sender 探测全部退化为 0 命中
- 因此，本 issue 优先级上调到 `p1`。修复前建议先保留更细诊断日志，确认是“最小化窗口可见性问题”为主因，还是站点 DOM/文案变化导致 chat UI 自动展开失败。

## 工作总结

### 2026-03-15 诊断结论记录

- 已确认 `ISSUE-014` 的 `done` 状态不能代表当前 pool 架构下链路仍然可用，因为其结论发生在 `bfad744` / `f0ddbd3` 两次核心重构之前。
- 已将当前问题归类为 **pool/window 稳定化未完成**，而非单纯“某个调用没有接线”。
- 本次仅补充诊断方向与 backlog 结论，尚未提交行为修复。

## 相关 commits

- 未提交

## 工作总结（2026-03-15 15:29）

- 本轮完成 S1 的第一阶段落地：补齐了 `sessionId -> conversationKey` 的反向索引，并在 `webchat.execute -> content -> page-hook` 链路中真正下传 `conversationKey`。
- `request_started` 返回的 `meta.sessionKey` 现在会同步回写到 SW 的 `LAST_CONVERSATION_KEY_BY_SESSION`，后续同一 session 的下一次请求会自动复用最近一次已知 `conversationKey`。
- page-hook 的 `request_started` transport 事件现在会回传下发的 `conversationKey`，方便调试链路确认上下游一致性。
- 顺手补了一个 fail-fast 行为：当 slot inspect 命中 runtime mismatch 时，执行链路会立即报错，不再一直轮询到槽位等待超时。
- 为此补充并更新了 `web-chat-executor.browser` 的回归测试，覆盖 conversationKey 复用、runtime mismatch 快速失败、pool.v1 存储断言等场景。
- 残留说明：page-hook 目前仍然没有“按下发 conversationKey 主动切换/新建具体网页内对话”的显式控制能力；当前语义是“同 session 优先回到已绑定 slot，并把 conversationKey 链路打通”，已满足 S1 的核心流通目标，但若要做到网页内多对话精确切换，后续仍可继续深化。

## 相关 commits（2026-03-15 15:29）

- 未提交

## 工作总结（2026-03-15 当前修复轮）

- 已按高概率主因直接修改行为逻辑：
- 这轮目标是先打通“最小化窗口 + 过严可见性探测”导致的主链路断点。
- 中途验证发现：直接在 executor 里把 pool 窗口恢复到 `normal` 会造成新的用户可见弹窗干扰，因此该部分已回退；当前保留的是**不弹窗的 background/minimized 探测放宽**方向。
- 继续验证又发现：background/minimized 探测放宽会改变连接行为，导致问题进一步扩大，因此这部分实验性放宽也已撤回；当前代码回到更接近原始基线的探测口径，仅保留诊断增强与问题记录。
- 已确认一个更核心的 pool 根因：`waitForCursorHelpSlot()` 在筛选可用 slot 之前没有先回收过期执行，而 `chooseCursorHelpSlot()` 会先把 `ACTIVE_REQUEST_ID_BY_SLOT` 标记的 busy slot 排除掉，导致**过期 busy slot 永远进不了候选集，也就永远不会被清理**。该问题会直接表现为长时间/跨轮次的“主执行槽位繁忙”。
- 已补最小修复：在每轮 slot 选择前，先对当前 pool 的所有 slot 执行 stale reap，再进入候选筛选。
- 进一步对比 pre-pool 实现后确认：当前 pool 架构还丢失了一个更前置的关键语义——**旧版会先尝试复用现有可用的 Cursor Help tab，再决定是否新建 popup/window；现版则直接创建专用 pool 窗口**。这会让 provider 在“连上可用 Cursor Help 页”之前就偏离旧行为。
- 已补回该语义：当前实现会先扫描并接管现有可用的 Cursor Help tab（先占 primary slot），只有在没有任何可用 tab 时，才退回到创建专用 pool 窗口。
- 最新 diagnostics 又揭示了一个更靠前的连接层问题：失败首因已经不是业务错误，而是 `页面请求超时: WEBCHAT_EXECUTE`。排查后确认 page hook 的 `WEBCHAT_EXECUTE` / `WEBCHAT_INSPECT` RPC 缺少异常兜底，sender 探测一旦抛错，content 侧看到的就只是 timeout，而不是实际异常。
- 已补修：page hook 现在在 `executeNativeSend()` reject 或 `inspectSender()` throw 时也会显式 `replyRpc()`，把真实错误返回给 content/provider，而不是让 8 秒超时吞掉问题细节。
- 当前仅完成代码修正与静态错误检查，尚未拿到新的运行态复现结果，因此 issue 保持 `in-progress`。

## 相关 commits（2026-03-15 当前修复轮）

- 未提交

## 工作总结（2026-03-15 15:34）

- 继续深化 S1：不再依赖 DOM 侧“点击历史对话”来切换上下文，而是在 page-hook 的 fetch rewrite 层直接控制请求体里的 `conversationId` / `conversation_id`。
- 新增规则：
  - 下发了可解析的 `conversationKey`（如 `cursor-help:conv-123`）时，rewrite 阶段会强制把请求体绑定到对应 `conversationId`，实现“显式复用已有对话”。
  - 未下发 `conversationKey` 时，如果页面当前残留旧 `conversationId`，会在 rewrite 阶段清掉它，强制走“新对话”语义，避免串到旧会话里。
- 同时把 `deriveCursorHelpSessionKey()` 的直接 ID 优先级调整为优先 `conversationId` / `sessionId`，再退到 request 级 id，避免把瞬时 `requestId` 误当成稳定 conversation key。
- 为此补了协议层测试：覆盖“强制复用已有 conversationId”“清理旧 conversationId 触发新对话”两条分支。

## 相关 commits（2026-03-15 15:34）

- 未提交

## 工作总结（2026-03-15 15:47）

- 继续尝试了 S1 的最后一段：探索是否能在 UI/DOM 层显式切换“当前可见历史对话”。
- 通过临时 CDP 连接实测了 `https://cursor.com/help` 的公开页面结构；在未登录临时 profile 下，页面呈现的是 Help Center / Docs shell，而不是带聊天历史侧栏的 authenticated chat runtime，因此无法在该环境中可靠验证真实历史对话 DOM。
- 基于这个现实约束，本轮没有盲目写死某个 history selector，而是落了 **best-effort UI hook + request rewrite fallback**：
  - 若 DOM 中能找到匹配 `conversationId` 的可见历史项，则先尝试点击它切换当前可见对话。
  - 若未提供 `conversationKey`，则先尝试点击 `New Chat / Start Over / Reset Chat` 一类入口打开新对话。
  - 若上述 UI 入口不存在，则明确记录日志并回退到已验证可工作的 request rewrite 语义控制。
- 同时把 page-hook inspect 能力补齐了 `conversationMode` / `supportsConcurrentConversations` 两个诊断字段，便于后续在真实 authenticated runtime 里判断 UI 能力是否可用。
- 结论：S1 在“行为语义”层面已基本闭环；UI 层的历史对话可见切换目前已具备 best-effort 尝试，但由于缺少 authenticated DOM 证据，不宣称它对所有登录态页面都已完全可靠。

## 相关 commits（2026-03-15 15:47）

- 未提交

## 工作总结（2026-03-15 15:54）

- 用户反馈当前优先级变为“恢复 Cursor Help provider 连通性”，因此本轮停止继续扩展 UI 层对话切换逻辑。
- 已回退上一轮新增的 best-effort UI 层 history/new-chat 尝试，恢复到上一个已验证稳定的 provider 主路径：
  - 保留 request rewrite 层的 `conversationKey -> conversationId` 语义控制
  - 移除 page-hook execute 前的 UI 点击切换/新建尝试
  - 移除其对应的 inspect 诊断扩展字段，避免引入额外连接面噪音
- 回退过程中修复了 `cursor-help-page-hook.ts` 的一个残留语法错误（缺失 `}`），并重新通过聚焦测试 + build 验证。
- 当前结论：优先保证 provider 可连和原主链路稳定；UI 层显式切换如果后续还要推进，应在单独 authenticated 环境验证下重新进行。

## 相关 commits（2026-03-15 15:54）

- 未提交

## 工作总结（2026-03-15 16:05）

- 用户继续提供了两份新的 diagnostics / snapshot，结论与上一轮一致：当前主故障仍是 `页面请求超时: WEBCHAT_EXECUTE`，且这次单次失败已不再伴随 busy 连锁，说明首发故障仍是 content/page execute 握手，而非 LLM/tool/sandbox 层。
- 基于该结论，本轮继续做了两类修复：
  - **降低 execute 前置门槛**：`content.execute` 不再把 `waitForPageSenderReady()` 当作硬门槛；改为仅做 best-effort preflight inspect + chat UI 唤醒，然后直接把执行交给 page-hook 内部的 sender wait 逻辑，避免在 pooled background tab 上被 content 预检卡死。
  - **增加显式 page-bridge 诊断**：
    - `WEBCHAT_EXECUTE` 增加 page-hook 侧 3.5s 明确超时返回，不再默默悬空到 content 的 8s RPC timeout。
    - `content.execute` 在 preflight 和最终失败时都会附带 `pageHookReady/fetchHookReady/senderReady/runtimeMismatch/rpcError/lastSenderError` 摘要，便于下一轮直接从错误字符串定位断点。
- 同时补充了 page-hook `execute.sender_wait` / `execute.rpc` 级别日志，便于调试面板观察卡在 sender wait 还是 page bridge reply。
- 本轮代码已通过聚焦测试与构建；但是否真正恢复 live provider，需要用户在本地再跑一次并回传新错误/诊断，以验证新诊断是否已把超时坍缩拆开。

## 相关 commits（2026-03-15 16:05）

- 未提交

## 工作总结（2026-03-15 16:12）

- 用户再次提供新一轮 diagnostics / snapshot；这次表象从前一轮的 `WEBCHAT_EXECUTE timeout` 进一步演变为“新 session 立刻命中 `Cursor Help 主执行槽位繁忙`”。
- 结合代码与诊断对照，确认了第二个直接问题：`clearStaleExecution()` 原先只按 `EXECUTION_STALE_MS=90s` 回收旧执行，不会主动清理“从未 request_started、但已超过 boot timeout 的旧执行”。这会让上一轮未真正启动成功的 execution 长时间占住主槽位，并把下一轮直接挡成 busy。
- 已补两处针对性修复：
  - content/page 侧：去掉 content.execute 对 sender-ready 的硬性前置门槛；新增 page bridge 3.5s 明确 timeout 和 preflight/last inspect 摘要诊断。
  - SW/pool 侧：`clearStaleExecution()` 现在会优先回收 `startedAt === null && age >= EXECUTION_BOOT_TIMEOUT_MS` 的旧 execution，不再等 90 秒 stale timeout。
- 同时确认用户贴出的 service worker/plugin CSP 控制台错误与本次 provider 故障不是同一条根链：这些 plugin rehydrate failed 在多份 snapshot 中都作为并行 internalEvents 存在，但 provider 失败会话依旧表现为 llm 有 request、tools/sandbox 全空、rawEvent 直接 loop_error，因此它们更像长期噪音而不是 Cursor Help provider 当前失败的第一现场。

## 相关 commits（2026-03-15 16:12）

- 未提交
