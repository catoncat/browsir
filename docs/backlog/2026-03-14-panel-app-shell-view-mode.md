---
id: ISSUE-008
title: App Shell / View Mode 收口
status: open
priority: p0
source: next-development-master-plan-2026-03-14 + slice breakdown
created: 2026-03-14
assignee: unassigned
kind: slice
epic: EPIC-2026-03-14-NEXT-PHASE
parallel_group: panel-shell
depends_on: []
write_scope:
  - extension/src/panel/App.vue
  - extension/src/panel/components/SettingsView.vue
  - extension/src/panel/components/SkillsView.vue
  - extension/src/panel/components/PluginsView.vue
  - extension/src/panel/components/DebugView.vue
acceptance_ref: docs/next-development-slices-2026-03-14.md
tags: [slice, panel, app-shell, ia]
---

# ISSUE-008: App Shell / View Mode 收口

## 目标

把 `showSettings/showSkills/showPlugins/showDebug` 收成显式 shell / view mode。

## 范围

- 默认聊天面
- 开发者面入口
- 壳层切换状态

推荐方案方向：`type ViewMode = 'chat' | 'settings' | 'skills' | 'plugins' | 'debug'` 单状态源（reactive ref 或 Pinia store），替换多个 `showXxx` 布尔开关。

## 非目标

- 不重做视觉设计
- 不拆 store

## 验收

- `App.vue` 不再依赖多个 `showXxx` 组织 IA
- 壳层切换有单一状态源
- Chat 主链保持可用

