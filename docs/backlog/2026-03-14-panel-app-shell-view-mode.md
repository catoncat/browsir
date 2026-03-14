---
id: ISSUE-008
title: App Shell / View Mode 收口
status: done
priority: p0
source: next-development-master-plan-2026-03-14 + slice breakdown
created: 2026-03-14
assignee: agent
resolved: 2026-03-14
commit: 84c5507
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

## 工作总结

### 2026-03-14

**分析**：App.vue 中发现 4 个互斥布尔 `showSettings` / `showProviderSettings` / `showSkills` / `showPlugins`，另有 2 个独立弹出菜单标记 (`showMoreMenu`, `showExportMenu`) 和 1 个消息过滤开关 (`showToolHistory`)，后 3 个无需收口。

**实施**：
- 新增 `type ViewMode = "chat" | "settings" | "provider-settings" | "skills" | "plugins"`
- 用 `const activeView = ref<ViewMode>("chat")` 替代 4 个布尔 ref
- 更新模板 `v-if` 条件：`showSettings` → `activeView === "settings"` 等
- 更新 More Menu `@click` handler：直接赋值 `activeView = "xxx"` 替代布尔翻转
- TypeScript 类型检查通过，构建通过

**验收结果**：全部通过 ✅

## 相关 commits

- `84c5507` — refactor(panel): replace showXxx booleans with single ViewMode state

