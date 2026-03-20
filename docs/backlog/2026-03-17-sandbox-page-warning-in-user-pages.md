---
id: ISSUE-2026-03-17-sandbox-page-warning
title: user-facing extension page 直接挂 sandbox page 导致控制台同源告警
status: done
priority: p1
source: 调试对话（2026-03-17）
created: 2026-03-17
assignee: agent
resolved: 2026-03-17
tags: [bug, extension, sandbox, sidepanel, plugin-studio, offscreen]
---

# ISSUE: user-facing extension page 直接挂 sandbox page 导致控制台同源告警

## 现象

在 `sidepanel.html` / `plugin-studio.html` 的控制台出现告警：

`Unsafe attempt to load URL chrome-extension://.../eval-sandbox.html from frame with URL chrome-extension://.../eval-sandbox.html. Domains, protocols and ports must match.`

用户已确认不是旧 `dist`、旧插件实例或浏览器未重启导致。

## Root Cause

问题不在于重复加载旧构建，而在于用户可见页面直接创建隐藏 iframe，`src` 指向 manifest `sandbox.pages` 中的 `eval-sandbox.html`。

运行态证据：

- `sidepanel.html` 会直接发起 `chrome-extension://.../eval-sandbox.html` 的 `Document` 请求
- `eval-sandbox` 内部访问父窗口时会被浏览器按 `origin "null"` 的 sandbox 上下文处理

因此这条 warning 的触发点是“用户页面直接嵌 sandbox page”，不是构建缓存问题。

## 修复方向

把 `sandbox-*` 消息的唯一宿主收敛到 offscreen `sandbox-host.html`：

- `eval-bridge.ts` 始终确保 `OFFSCREEN_DOCUMENT`
- `panel/main.ts` 不再初始化页面内 `sandbox-relay`
- `panel/plugin-studio-main.ts` 不再初始化页面内 `sandbox-relay`

这样 `eval-sandbox.html` 只会由 `sandbox-host.html` 承载，用户可见页面本身不再直接挂载该 iframe。

## 关键文件

- `extension/src/sw/kernel/eval-bridge.ts`
- `extension/src/panel/main.ts`
- `extension/src/panel/plugin-studio-main.ts`
- `extension/src/panel/utils/sandbox-relay.ts`
- `extension/src/sandbox-host/main.ts`
- `extension/src/sw/kernel/__tests__/eval-bridge.browser.test.ts`

## 工作总结

### 2026-03-17 23:58 +0800

完成内容：

- 通过运行态 CDP 证据确认 sidepanel 直接请求了 `eval-sandbox.html`
- 重新构建并验证 `plugin-studio` 页面自身已不再包含 sandbox iframe
- 确认 sandbox iframe 已迁移到 `sandbox-host.html`
- 更新 `eval-bridge` 测试与相关注释

结果：

- `plugin-studio` 运行态 DOM 中 `iframeCount = 0`
- `sandbox-host` 运行态 DOM 中承载 `eval-sandbox.html`

残留：

- 无

## 相关 commits

- 未提交

### 2026-03-18 00:03 +0800

完成内容：

- 删除闲置文件 `extension/src/panel/utils/sandbox-relay.ts`
- 同步更新 `docs/sandbox-page-design.md`，去掉页面内 relay 的旧描述

结果：

- `eval-sandbox` 仅由 `sandbox-host.html` 承载
- `extension/src/` 中不再存在 `initSandboxRelay` / `sandbox-relay` 的代码引用

残留：

- 无
