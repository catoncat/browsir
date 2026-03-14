---
id: ISSUE-021
title: App.vue 拆分补充方案 — Composables 分层
status: open
priority: p2
source: ISSUE-016-P3 + ISSUE-017 follow-up
created: 2026-03-15
assignee: unassigned
kind: refactor
tags: [panel, refactor, vue, composables]
---

# ISSUE-021: App.vue 拆分补充方案 — Composables 分层

## 背景

App.vue `<script setup>` 当前 2854 行 + 342 行模板 + 48 行样式 = 3247 行，包含 25 个 ref、34 个 computed、~96 个函数、15 个 watch，严重违反 SRP。

> 说明：本条目**不替代** `ISSUE-017`。`ISSUE-017` 仍是 Phase 2 的正式主线（App shell + `ChatView.vue` + `panel/types.ts`）；本条目仅保留为后续补充拆分方案：若 `ISSUE-017` 完成后 `App.vue` 仍然偏大，再评估是否继续沿 composables 方向细拆。

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

### Phase 1: 提取 3 大 composable（减 ~1200 行）

1. **`useToolPendingState()`** (~843 行, L787-L1630)
   - Tool pending step 状态机、card computed、stream derivation、log buffering、display formatting
   - 自包含：输入是 runtime events，输出是 computed card props
   - **最大收益**

2. **`usePluginUiRender()`** (~500 行, L1896-L2397)
   - Panel notice 系统、plugin UI 生命周期
   - 所有 `toUi*Payload` / `normalizeUi*Payload` pairs
   - rebuild 函数
   - 围绕 `panelUiRuntime` 边界清晰

3. **`useToolFormatters.ts`** (~232 行, L554-L786)
   - 纯函数：`prettyToolAction`, `formatToolPendingDetail`, `inferBashIntent`, `clipText` 等
   - 无 refs — 可提为普通 .ts 工具模块

### Phase 2: 提取 4 小 composable（减 ~330 行）

4. **`useForkScene()`** (~102 行) — Fork 动画编排状态机
5. **`useLlmStreaming()`** (~60 行) — LLM streaming delta buffer
6. **`useUserEditing()`** (~90 行) — 消息编辑 refs + 5 个 handler
7. **`useExport()`** (~77 行) — markdown/debug/export handlers

### Phase 3: 类型/接口外移

8. 将 12 个 interfaces 移到 `types/panel.ts`

## 验收标准

- App.vue `<script setup>` 降至 ~1000 行以下
- 各 composable 有独立类型签名
- `bun run build` 通过
- 功能无回归（手动验证 SidePanel 主流程）

## 约束

- 不改变任何用户可见行为
- 模板部分保留在 App.vue（不拆子组件）
- 默认在 `ISSUE-017` 完成后再评估是否启动
- 每个 composable 单独 commit，方便 review
