---
id: ISSUE-017
title: App.vue 巨型组件拆分 — ChatView 提取
status: open
priority: p0
source: architecture-evolution-phase2
created: 2026-03-14
assignee: ""
kind: refactor
tags: [panel, app-vue, architecture, phase2]
---

## 问题

`App.vue` 当前 3,247 行（script 2,854 + template 343 + style 50），是项目最大的单文件组件。同时承载视图路由分发、chat 全场景逻辑、接口类型定义和 Plugin UI 挂载。

## 目标

将 App.vue 从 3,247 行降至 <500 行，使其仅作为 Shell 承载视图路由和全局布局。

## 验收标准

- [ ] `ChatView.vue` 独立存在，承载消息列表渲染、流式响应、工具快照、队列、fork/retry/intervention、Plugin UI 挂载
- [ ] `panel/types.ts` 承载所有从 App.vue 提取的接口/类型定义
- [ ] `App.vue` 仅保留 ViewMode 切换 + 顶栏 + 侧栏 + 视图容器 + 全局事件监听，<500 行
- [ ] `bun run build` 通过
- [ ] `bun run test` 通过

## 写入范围

- `extension/src/panel/App.vue`（瘦身）
- `extension/src/panel/components/ChatView.vue`（新建）
- `extension/src/panel/types.ts`（新建）

## 泳道

`panel-shell`，App.vue 单写者

## 依赖

无
