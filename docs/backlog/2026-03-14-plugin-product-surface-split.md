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

### 2026-03-14 19:02 CST

**补充修复**：
- 为 `PluginStudioView` 的项目列表补上可聚焦按钮语义、`ArrowUp/ArrowDown/Home/End` 键盘导航和缺失的 icon button `aria-label`
- 收紧 Studio 日志边界，移除“全部插件”视图，未绑定 `pluginId` 的项目不再退化成全局日志面
- 把 `PluginsView` 中的 `Plugin Studio` 入口上移到头部与内容首屏，并统一插件状态文案为中文，减少“用户面 / 开发面”混杂感

**结果**：
- `PluginStudioView` 现在满足本仓库对核心列表键盘导航与 icon button 可访问性的基本要求
- Studio 更明确只围绕当前项目工作，不再重新暴露跨插件总控面
- 用户进入插件页后可以更快发现 `Plugin Studio`

**验证**：
- `cd extension && bun run build`
- `cd extension && bunx tsc --noEmit` 仍被仓库现有问题阻塞：`src/sw/kernel/loop-progress-guard.ts` 缺少 `./platform-types`

## 相关 commits

### 2026-03-14 19:02 CST

- 未提交
