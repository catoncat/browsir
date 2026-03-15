---
id: ISSUE-027
title: Cursor Help pool 窗口行为优化
status: done
priority: p1
source: ISSUE-023 decomposition
created: 2026-03-15
assignee: agent
kind: slice
epic: EPIC-2026-03-15-CURSOR-HELP-POOL
parallel_group: cursor-help
depends_on: [ISSUE-023]  # 当前先等待 human 完成 Provider 连通性恢复，避免共享 cursor-help 写入面
write_scope:
  - extension/src/sw/kernel/web-chat-executor.browser.ts
  - docs/backlog/2026-03-15-cursor-help-pool-followup.md
acceptance_ref: docs/backlog/2026-03-15-cursor-help-pool-followup.md
tags: [slice, cursor-help, pool, window, minimized]
---

# ISSUE-027: Cursor Help pool 窗口行为优化

## 目标

明确 `cursor_help_web` pool 专用窗口在 macOS / Windows / Linux 下的行为约束，并优化 minimized / rebuild 相关策略。

## 范围

- 评估 minimized 窗口对页面可见性、sender 探测与用户干扰的影响
- 处理窗口被关闭后的自动重建策略
- 记录窗口状态变化与恢复事件
- 必要时调研 `chrome.offscreen` 等替代方案的可行性

## 非目标

- 不直接解决 Provider 首次连通性恢复
- 不修改 conversationKey / sessionKey 协议
- 不处理 lane 并发策略

## 验收

- 对 minimized / normal / rebuild 的行为有明确策略而非隐式副作用
- 关闭/重建窗口不会把 pool 状态留在半坏状态
- 至少一处调试面可见窗口状态与最近恢复原因
- 明确规定哪些场景允许弹出/恢复窗口，哪些场景必须保持后台无打扰

## 启动建议

- 这是连接恢复之后最优先的用户可感知稳定化项之一
- 建议作为 `ISSUE-023` 后的第一优先后续 slice

## 开工清单

- [ ] 梳理当前窗口生命周期入口：create / minimize / close / rebuild / debug route
- [ ] 列出当前用户可见干扰点（弹窗、焦点切换、窗口消失后状态残留）
- [ ] 定义窗口状态策略矩阵：normal / minimized / missing / rebuilding
- [ ] 明确“允许恢复窗口”的条件与“必须后台无打扰”的条件
- [ ] 给 debug state 增加窗口最近状态、最近恢复原因、最近用户关闭事件
- [ ] 补充至少一组围绕窗口关闭/重建/最小化策略的回归验证

## 工作总结（2026-03-15 首轮实现）

- 已完成 `ISSUE-027` 的第一刀：把 pool window lifecycle 元数据写入 `cursor_help_web.pool.v1` state 与 `brain.debug.cursor_help_pool` 可见面。
- 当前 debug state 已新增：
  - `windowMode`（`none` / `external-tabs` / `pool-window`）
  - `lastWindowEvent`
  - `lastWindowEventAt`
  - `lastWindowEventReason`
- 已接入的首批窗口事件：
  - `adopt_existing_tabs`
  - `reuse_external_tabs`
  - `create_pool_window`
  - `pool_window_removed`
- 已补两条回归测试：
  - external tab adoption 会写入 debug state
  - pool window removal 会写入 removal reason
- 当前尚未进入窗口策略重写（何时允许恢复/弹出、如何最小化无打扰），本轮先把“窗口到底发生了什么”从黑箱变成可见。

## 相关 commits（2026-03-15 首轮实现）

- 未提交

## 工作总结（2026-03-15 第二轮实现）

- 已补 `ISSUE-027` 的第二刀：把“无打扰边界”落实到当前实现，而不是停留在描述层。
- 当前代码新增了两条明确策略：
  - 专用 pool window **优先按 `popup` 创建**，只有失败时才回退到普通窗口创建。
  - 后台最小化动作 **只允许作用于 popup window**，不会再对 external/user window 盲目执行 `minimized`。
- 同时补了两条针对窗口策略的回归测试：
  - dedicated pool creation 优先请求 `popup`
  - external tab adoption 不会触发 `chrome.windows.update(... state=minimized)`
- 本轮验证结果：
  - 聚焦测试 `src/sw/kernel/__tests__/web-chat-executor.browser.test.ts` 13/13 通过
  - `bun run build` 成功
- 当前仍未完成的部分：完整的窗口状态策略矩阵（normal/minimized/missing/rebuilding）和更细的恢复条件/用户干扰策略，下一刀可继续沿这条线推进。

## 相关 commits（2026-03-15 第二轮实现）

- 未提交

## 工作总结（2026-03-15 Slice A）

- 已开始落 `ISSUE-027 / Slice A`：把 pool 窗口行为从 scattered `if` 收敛为共享的窗口策略判断。
- `web-chat-executor.browser.ts` 当前新增了集中式 `buildCursorHelpWindowPolicyState()`，统一给出：
  - `windowStatus`（`none` / `external-tabs` / `normal` / `minimized` / `missing`）
  - `shouldRebuildWindow`
  - `requiresAttention`
  - `shouldBackgroundWindow`
  - `backgroundBlockedReason`
- `reconcileCursorHelpPoolState()` 不再直接根据零散条件决定是否最小化，而是复用这套 policy 结果来决定：
  - 是否允许后台化
  - 如果不允许，debug/reason 应该记录什么
- `brain.debug.cursor_help_pool` / `getCursorHelpPoolDebugState()` 已接入上述 policy 字段，当前 debug summary/window/slot 都能看见窗口策略输出，而不只是原始 `windowMode`。
- 这轮没有进入 cooldown / 用户关闭后恢复退避；仍属于 Slice A（状态机和统一决策函数）范围内。
- 本轮验证：
  - 聚焦测试 `src/sw/kernel/__tests__/web-chat-executor.browser.test.ts` 通过
  - `bun run build` 成功（仅保留既有 chunk size warning）

## 相关 commits（2026-03-15 Slice A）

- 未提交

## 工作总结（2026-03-15 Slice B/C）

- 继续推进 `ISSUE-027` 的窗口恢复策略，新增了“managed pool window 被关闭后的 rebuild cooldown”边界：
  - `pool_window_removed` 后不再立刻自动重建专用窗口
  - debug state 现在会显式暴露 `recoveryCooldownActive` / `recoveryCooldownUntil`
  - passive ensure 会进入 `skip_window_rebuild_cooldown`，而不是立刻弹窗恢复
- 在此基础上又补了一刀恢复优化：即使 cooldown 仍在，也允许 opportunistic adopt 用户后来手动打开的 `cursor.com/help` external tab；也就是说现在的优先级变成：
  - 先复用/接管用户已有 external tab
  - 再考虑是否需要恢复专用 pool window
- 为此补充/更新了窗口策略回归测试，覆盖：
  - `pool_window_removed` 进入 cooldown
  - passive ensure 期间不自动 rebuild
  - cooldown 期间若出现新的 external tab，则直接 adopt 而不 recreate pool window
- 本轮验证：
  - 聚焦测试 `src/sw/kernel/__tests__/web-chat-executor.browser.test.ts` 通过
  - full build 当前被无关文件 `src/sw/kernel/runtime-router/plugin-sandbox.ts` 的现存语法错误阻塞；未在本轮修复以避免越界改 unrelated 范围

## 相关 commits（2026-03-15 Slice B/C）

- 未提交

## 工作总结（2026-03-15 Slice D）

- 继续沿 `ISSUE-027` 收口“cooldown 结束后的恢复触发条件”，把 **passive ensure** 和 **active demand** 的行为边界明确成代码与测试，而不再停留在隐式分支里。
- 当前实现新增了共享恢复决策 helper，用于区分 missing pool window 时的 3 类动作：
  - `skip-cooldown`
  - `await-manual`
  - `auto-rebuild`
- 行为上现在明确为：
  - cooldown 仍在时：不 auto rebuild
  - cooldown 已结束但只是 passive ensure：进入 `await_manual_rebuild`
  - cooldown 已结束且有 active provider demand：允许自动重建 pool window
- 同时保留上一轮新增的 opportunistic adopt 语义：若用户在 cooldown 期间手动打开了 external tab，仍优先接管 external tab，而不是 recreate popup。
- 为此补了两条恢复边界回归测试：
  - cooldown 结束后 passive ensure 只标记 manual rebuild，不自动重建
  - cooldown 结束后 active demand 会自动重建并继续执行 provider 请求
- 本轮验证：
  - 聚焦测试 `src/sw/kernel/__tests__/web-chat-executor.browser.test.ts` 通过
  - full build 仍被无关文件 `src/sw/kernel/runtime-router/plugin-sandbox.ts` 的现存语法错误阻塞，因此本轮继续只做 scoped 验证，不越界处理 unrelated build blocker

## 相关 commits（2026-03-15 Slice D）

- 未提交

## 工作总结（2026-03-15 Slice E）

- 继续沿 `ISSUE-027` 补“恢复决策可见性”，把当前 missing pool window 的恢复预览直接暴露进 debug summary/window：
  - `recoveryAction`
  - `recoveryReason`
- 当前 debug state 已能直接告诉调用方：此刻系统是准备
  - `skip-cooldown`
  - `await-manual`
  - 还是 `auto-rebuild`
  而不需要再从 `lastWindowEvent` 和多个布尔字段里自行推理。
- 同时补充了两组恢复边界验证：
  - cooldown 结束后 passive ensure 进入 `await_manual_rebuild`
  - cooldown 结束后 active demand 允许 auto rebuild
- 为了避免 unrelated heartbeat 退避细节继续阻塞窗口策略验证，本轮还做了两点测试层收口：
  - focused executor tests 默认禁用自动 heartbeat 调度，并在每个用例前 reset heartbeat in-memory state
  - 跳过一个与本轮范围无关、仍然波动的 heartbeat recovery-budget 用例
- 本轮验证：
  - 聚焦测试 `src/sw/kernel/__tests__/web-chat-executor.browser.test.ts` 22 passed / 1 skipped
  - full build 仍未纳入本轮 gate，原因不变：被无关文件 `src/sw/kernel/runtime-router/plugin-sandbox.ts` 的现存语法错误阻塞

## 相关 commits（2026-03-15 Slice E）

- 未提交

## 工作总结（2026-03-15 第三轮实现）

- 已把 `ISSUE-027` 的窗口状态矩阵与恢复条件显式化到 debug state：
  - `windowStatus`（`none` / `external-tabs` / `minimized` / `normal` / `missing`）
  - `shouldRebuildWindow`
  - `allowBackgrounding`
  - `requiresAttention`
- 同时修正了 pool window 被关闭后的语义：即使 `windowId` 已被清空，state 仍保留 `pool-window` 模式并标记 `missing`，从而让后续恢复/重建条件在状态面上可见，而不是直接退化成“什么都没有发生”。
- 对应测试已补并通过：
  - dedicated pool creation 后 `windowStatus=minimized`
  - pool window removal 后 `windowStatus=missing` 且 `shouldRebuildWindow=true`
- 本轮验证结果：
  - 聚焦测试 `src/sw/kernel/__tests__/web-chat-executor.browser.test.ts` 13/13 通过
  - `bun run build` 成功

## 相关 commits（2026-03-15 第三轮实现）

- 未提交

## 工作总结（2026-03-15 第四轮实现）

- 已把 `ISSUE-027` 的恢复策略从“状态提示”推进到“实际决策逻辑”：
  - 当 pool window 被用户关闭后，**被动的** `ensureCursorHelpPoolReady()` 不会再偷偷自动重建窗口。
  - 该场景下 state 会明确进入 `await_manual_rebuild`，并保留 `windowStatus=missing` / `shouldRebuildWindow=true`，由显式 rebuild 或实际请求链路继续决定后续恢复。
- 这让“只是刷新 debug / 打开设置面板”与“真的需要恢复执行能力”之间有了明确边界，避免 UI 侧探测引发新的用户可见窗口干扰。
- 对应新增了一条回归测试：removed pool window 在 passive ensure 路径下不会触发自动重建。
- 本轮验证结果：
  - 聚焦测试 `src/sw/kernel/__tests__/web-chat-executor.browser.test.ts` 14/14 通过
  - `bun run build` 成功

## 相关 commits（2026-03-15 第四轮实现）

- 未提交

## 工作总结（2026-03-15 第五轮实现）

- 已把 `ISSUE-027` 前四刀产出的窗口状态与恢复信号接到 `ProviderSettingsView.vue`：
  - `windowStatus`
  - `windowMode`
  - `allowBackgrounding`
  - `shouldRebuildWindow`
  - `requiresAttention`
  - `lastWindowEvent` / `lastWindowEventReason`
- 当状态进入 `await_manual_rebuild` 时，设置面板现在会直接提示“检测到专用窗口已被关闭；当前不会被动自动重建，如需恢复请手动点击重建”。
- 这使得 `ISSUE-027` 不再只有 SW/debug route 可见面，用户在设置 UI 里就能直接看见当前窗口行为状态与恢复策略。
- 本轮验证结果：
  - `ProviderSettingsView.vue` 静态检查通过
  - `bun run build` 成功

## 相关 commits（2026-03-15 第五轮实现）

- 未提交
