---
id: ISSUE-010
title: "Plugin 使用面 / 开发面分离"
status: done
priority: p1
source: "next-development-master-plan-2026-03-14 + slice breakdown"
created: 2026-03-14
assignee: agent
resolved: 2026-03-14
kind: slice
epic: EPIC-2026-03-14-NEXT-PHASE
parallel_group: panel-shell
depends_on:
  - ISSUE-008
write_scope:
  - extension/src/panel/components/PluginsView.vue
  - extension/src/panel/components/PluginStudioView.vue
  - extension/src/panel/App.vue
acceptance_ref: docs/next-development-slices-2026-03-14.md
tags:
  - slice
  - plugin
  - panel
  - product
claimed_at: "2026-03-14T09:24:28.645Z"
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

## 工作总结

### 2026-03-14

**实施**：
- 把 `PluginsView` 收口为用户侧插件管理面，移除 hooks/capabilities/runtimeMessages/uiExtension/usage 这些低层控制面直出，改成高层能力标签与用户可理解的摘要
- 把 `PluginStudioView` 收口为“当前项目”的开发工作台，删除“所有已安装插件”的通用控制面，只保留项目编辑、安装/热更新、导出、日志与当前项目运行态绑定信息
- 在 `App.vue` 中把入口文案从“插件管理”收成更产品化的“插件”，与独立 `Plugin Studio` 的开发定位分开

**结果**：
- 现在可以清楚回答：启用/禁用/卸载在侧边栏插件页；创建/编辑/热更新/调试在独立 `Plugin Studio`
- 普通插件页不再直接暴露开发者控制面概念

**验证**：
- `cd extension && bunx tsc --noEmit`
- `cd extension && bun run build`
