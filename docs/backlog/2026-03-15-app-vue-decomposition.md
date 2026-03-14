---
id: ISSUE-021
title: App.vue 二阶段深拆 — plugin UI / ChatView / editing follow-up
status: open
priority: p2
source: ISSUE-017 follow-up after shell/controller split
created: 2026-03-15
assignee: unassigned
kind: refactor
tags: [panel, refactor, vue, composables, chat-view, follow-up]
---

# ISSUE-021: App.vue 二阶段深拆 — plugin UI / ChatView / editing follow-up

## 背景

`ISSUE-017` 现已校准为第一阶段的 shell/controller 拆分（含 `panel/types.ts`、`use-tool-pending-state.ts`、`shell-context.ts`）。本条目保留为第二阶段 follow-up：如果第一阶段完成后 `App.vue` / chat 区域仍偏大，再继续向 plugin UI / editing / ChatView 深拆。

> 说明：本条目**不替代** `ISSUE-017`。第一阶段先解决 shell/controller 边界；本条目只跟踪第二阶段残余热点，不与当前正在进行的 `ISSUE-017` 重复派工。

## 结构分析

| 行范围 | 区块 | 行数 |
|--------|------|------|
| 1-34 | Imports | 34 |
| 35-65 | Store init + UI refs | 30 |
| 66-124 | Runtime lifecycle computed | 58 |
| 125-230 | Type interfaces (12个) | 105 |
| 232-360 | Message actions + state refs | 128 |
| 361-552 | RunView state + Fork scene | 191 |
| 554-786 | Normalizer/formatter utilities | 232 |
| 787-1134 | Tool pending state + log buffering | 347 |
| 1135-1355 | applyRuntimeEventToolRun (单函数 220 行) | 220 |
| 1356-1630 | Bridge sync + tool pending card computed | 274 |
| 1631-1895 | Watchers + auto-scroll | 264 |
| 1896-2397 | Plugin UI lifecycle + render hooks | 501 |
| 2398-2478 | User message editing | 80 |
| 2480-2620 | SW runtime message handler | 140 |
| 2621-2834 | User action handlers | 213 |
| 2835-2854 | onUnmounted cleanup | 19 |

## 拆分计划（按优先级）

### Phase 1: 提取剩余大块 controller / render hooks

1. **`usePluginUiRender()`**
   - Panel notice 系统、plugin UI 生命周期
   - `toUi*Payload` / `normalizeUi*Payload` pairs
   - 目标是把 `panelUiRuntime` 相关 render hook 收到单一边界

2. **`ChatView.vue`（仅在 shell context 稳定后）**
   - 负责 chat 主区组合：消息列表、流式草稿、tool pending card、fork overlay、输入框
   - 前提是 shell actions / panel runtime 可通过 context 注入，而不是新增大量 props/emits

3. **`useConversationEditing()` / `useConversationExport()`**
   - user message editing、markdown/debug/export handlers
   - 把用户交互辅助逻辑从 `App.vue` 主体中继续挪出

### Phase 2: 收尾型小块拆分

4. **`useForkScene()`** — Fork 动画编排状态机
5. **`useRuntimeMessageBus()`** — `chrome.runtime.onMessage` 相关 wiring（若仍然过厚）

### 非目标 / 已并入 ISSUE-017 第一阶段

- `panel/types.ts`
- `use-tool-pending-state.ts`
- `shell-context.ts`

## 验收标准

- 第一阶段完成后，如仍有必要，再把剩余热点拆成独立 composable / ChatView
- 新增模块职责边界明确，不与 `ISSUE-017` 当前 scope 重叠
- `bun run build` 通过
- 功能无回归（手动验证 SidePanel 主流程）

## 约束

- 不改变任何用户可见行为
- 默认在 `ISSUE-017` 完成后再评估是否启动
- 不把第一阶段已经开始落地的边界（`types.ts` / `use-tool-pending-state.ts` / `shell-context.ts`）重新建一套重复方案
- 每个 composable 单独 commit，方便 review
