---
id: ISSUE-016
title: Panel UX Bugs — 深度 Review 发现
status: done
priority: p0
source: product-review-2026-03-15
created: 2026-03-15
assignee: copilot
kind: bug-batch
tags: [panel, ux, accessibility, bug]
---

# ISSUE-016: Panel UX Bugs — 深度 Review 发现

## Bug 清单

### B1. Dark mode 加载闪白屏 (p0)
- **位置**: App.vue loading overlay `bg-white/80`
- **问题**: 硬编码白色背景，dark mode 用户每次加载闪白屏
- **修复**: 改为 `bg-white/80 dark:bg-neutral-900/80`

### B2. PluginsView `confirm()` 在 SidePanel 异常 (p0)  
- **位置**: PluginsView.vue 卸载确认
- **问题**: `globalThis.confirm()` 在 Chromium SidePanel 中可能不弹窗或行为异常
- **修复**: 替换为内联确认 UI（二次点击确认）

### B3. SessionList 删除无确认 (p0)
- **位置**: SessionList.vue trash icon
- **问题**: 点击直接删除，误触不可恢复
- **修复**: 二次点击确认或 undo toast

### B4. ChatInput textarea 缺 aria-label (p1)
- **位置**: ChatInput.vue textarea
- **问题**: 只有 placeholder，屏幕阅读器用户无法得知输入框用途
- **修复**: 添加 `aria-label="发送消息给 AI Agent"`

### B5. `@` Tab 引用异常未捕获 (p1)
- **位置**: ChatInput.vue `refreshTabs()`
- **问题**: `chrome.tabs.query` 权限缺失时 throw 未 catch
- **修复**: try-catch 包裹，失败时 tabs 设为空数组

## 交互改进清单

### I1. Tool 卡片展开/折叠无过渡 (p2)
### I2. 会话删除无退出动画 (p2)
### I3. 视图切换无退出动画 (p2)
### I4. Skill 缓存过期 (p2)
### I5. loadConversation 丢弃静默失败 (p2)

## 产品层面

### P1. DebugView 无入口
### P2. 空态文案技术化
### P3. App.vue 3192 行需拆分

## 验收

- 5 个 Bug 全部修复
- dark mode 加载不再闪白
- SidePanel 中卸载/删除有确认机制

## 工作记录

### 2026-03-15 Bug B1-B5 修复

- **B1** ✅ App.vue loading overlay `bg-white/80` → `bg-white/80 dark:bg-neutral-900/80`
- **B2** ✅ PluginsView.vue `globalThis.confirm()` → inline 二次点击确认 + 3s 超时自动取消
- **B3** ✅ SessionList.vue trash icon 直接删除 → inline 二次点击确认 + 3s 超时
- **B4** ⏭️ 跳过：textarea 已有 `aria-label="消息输入框"`，为误判
- **B5** ✅ ChatInput.vue `refreshTabs()` → try-catch 包裹，失败时 fallback 空数组

**commit**: `fbab780` fix(panel): B1-B5 UX bugs — dark mode flash, inline confirm, aria, tabs.query guard

### 2026-03-15 产品层面 P1-P2 修复

- **P1** ✅ DebugView 添加到 ViewMode 类型 + More 菜单 + 模板渲染，用 Bug icon
- **P2** ✅ 空态文案从 "系统就绪。发送指令开始自动化任务。CDP 与网桥协议已建立。" → "就绪。发送消息让 Agent 帮你完成浏览器任务。"
- **P3** ⏭️ App.vue 3192 行拆分为大型重构，需单独 issue 规划

**commit**: `a596707` feat(panel): P1 DebugView入口 + P2 空态文案优化
