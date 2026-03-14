---
id: ISSUE-010
title: Plugin 使用面 / 开发面分离
status: open
priority: p1
source: next-development-master-plan-2026-03-14 + slice breakdown
created: 2026-03-14
assignee: unassigned
kind: slice
epic: EPIC-2026-03-14-NEXT-PHASE
parallel_group: panel-shell
depends_on: [ISSUE-008]
write_scope:
  - extension/src/panel/components/PluginsView.vue
  - extension/src/panel/components/PluginStudioView.vue
  - extension/src/panel/App.vue
acceptance_ref: docs/next-development-slices-2026-03-14.md
tags: [slice, plugin, panel, product]
---

# ISSUE-010: Plugin 使用面 / 开发面分离

## 目标

让 `PluginsView` 与 `PluginStudioView` 不再重复承担同一套控制面。

## 范围

- 插件启停 / 状态 / 用户面管理
- Studio 开发 / 编辑 / 导出 / 调试
- App 中的入口关系

## 非目标

- 不改插件底层运行时
- 不改 widget API 核心契约

## 验收

- 能清楚回答“管理插件在哪里”“开发插件在哪里”
- 普通用户面不再暴露开发控制面概念

