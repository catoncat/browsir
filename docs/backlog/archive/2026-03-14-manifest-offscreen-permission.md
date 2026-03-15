---
id: ISSUE-003
title: manifest.json 缺少 offscreen 权限导致 plugin sandbox fallback 失败
status: done
priority: p0
source: 调试对话 session-816e926f（2026-03-14）
created: 2026-03-14
assignee: agent
resolved: 2026-03-14
commit: c5ae106
tags: [bug, manifest, offscreen, plugin, sandbox]
---

# ISSUE-003: manifest.json 缺少 offscreen 权限

## 现象

`example-mission-hud-dog` 插件注册成功（enabled=true）、hook 大量触发（usageTotalCalls=1503），但 chat 界面不显示小狗 UI。lastError: "Failed to create offscreen document: Cannot read properties of undefined (reading 'createDocument')"，errorCount=16。

## Root Cause

`manifest.json` 的 `permissions` 中没有声明 `"offscreen"`。Chrome MV3 要求显式声明才能使用 `chrome.offscreen` API。

`sandboxBash()`（`eval-bridge.ts:77`）先检查 SidePanel relay 是否可用，不可用时 fallback 到 offscreen document（`ensureOffscreenRelay()` → `chrome.offscreen.createDocument()`）。因缺少权限，`chrome.offscreen` 为 `undefined`，抛出错误。

影响范围不限于 dog plugin——所有通过 `sandboxBash`/`invokePluginSandboxRunner` 执行的 plugin hook 在 SidePanel 不可用时都会失败。

## 修复方向

在 `extension/manifest.json` 的 `permissions` 数组中添加 `"offscreen"`。

## 关键文件

- `extension/manifest.json` — permissions 声明
- `extension/src/sw/kernel/eval-bridge.ts` — ensureOffscreenRelay、sandboxBash
- `extension/plugins/example-mission-hud-dog/` — 插件源码
