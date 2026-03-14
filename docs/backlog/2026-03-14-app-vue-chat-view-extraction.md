---
id: ISSUE-017
title: App.vue 壳层 / Controller 拆分 — tool pending state + shell context
status: open
priority: p0
source: architecture-evolution-phase2
created: 2026-03-14
assignee: unassigned
kind: slice
epic: EPIC-2026-03-14-ARCH-EVOLUTION-PHASE2
parallel_group: panel-shell
depends_on: []
write_scope:
  - extension/src/panel/App.vue
  - extension/src/panel/types.ts
  - extension/src/panel/utils/use-tool-pending-state.ts
  - extension/src/panel/shell-context.ts
  - extension/src/panel/components/ChatView.vue
acceptance_ref: docs/architecture-evolution-plan-2026-03-14.md
tags: [slice, panel, app-vue, controller, composable, architecture, phase2]
---

## 问题

`App.vue` 当前 3,247 行（script 2,854 + template 343 + style 50），技术债不只是模板过大，而是 **shell 路由、panel 级 runtime/plugin 生命周期、chat 运行态控制器、chat 主视图渲染** 四类职责叠加在一个 SFC 内。

## 目标

先把 `App.vue` 拆成更真实的边界：`types.ts` + `use-tool-pending-state.ts` + `shell-context.ts` + Shell；在 controller 边界稳定后，再决定是否引入 `ChatView.vue`。

## 验收标准

- [ ] `panel/types.ts` 集中 panel view-model / run-view 相关类型定义
- [ ] `use-tool-pending-state.ts` 独立承载 tool pending / llm streaming / run-view 状态机
- [ ] `shell-context.ts` 提供 shell actions / `panelUiRuntime` 的注入边界
- [ ] `App.vue` 不再直接内联上述 run-view / tool pending 控制器逻辑
- [ ] 若 props/emits 面已明显收敛，再评估是否引入 `ChatView.vue`（不是首轮硬约束）
- [ ] `bun run build` 通过
- [ ] `bun run test` 通过

## 写入范围

- `extension/src/panel/App.vue`（瘦身）
- `extension/src/panel/types.ts`
- `extension/src/panel/utils/use-tool-pending-state.ts`
- `extension/src/panel/shell-context.ts`
- `extension/src/panel/components/ChatView.vue`（可选后续）

## 泳道

`panel-shell`，App.vue 单写者

## 依赖

无
