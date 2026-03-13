# 内置插件清单

## 概述

系统包含 **11 个内核 Capability 插件** 和 **3 个示例插件**。内核插件在 Runtime Loop 初始化时自动注册，不可卸载，不暴露给用户。

---

## 内核 Capability 插件（11 个）

注册位置：`extension/src/sw/kernel/runtime-loop.browser.ts` → `ensureBuiltinCapabilityPlugins()`

ID 前缀：`runtime.builtin.plugin.`

### 文件/进程 Capability（8 个）

每个 Capability 有 bridge（宿主侧）和 sandbox（浏览器侧）两种执行模式，运行时根据路由策略自动选择。

| 插件 ID | Capability | Mode | 功能 | 映射工具 |
|---------|-----------|------|------|---------|
| `...capability.process.exec.bridge` | `process.exec` | bridge | 通过 Bridge WS 执行 bash 命令 | `host_bash` |
| `...capability.process.exec.sandbox` | `process.exec` | script | 通过浏览器沙箱执行 bash | `browser_bash` |
| `...capability.fs.read.bridge` | `fs.read` | bridge | 通过 Bridge 读取宿主文件 | `host_read_file` |
| `...capability.fs.read.sandbox` | `fs.read` | script | 通过浏览器 VFS 读取虚拟文件 | `browser_read_file` |
| `...capability.fs.write.bridge` | `fs.write` | bridge | 通过 Bridge 写入宿主文件 | `host_write_file` |
| `...capability.fs.write.sandbox` | `fs.write` | script | 通过浏览器 VFS 写入虚拟文件 | `browser_write_file` |
| `...capability.fs.edit.bridge` | `fs.edit` | bridge | 通过 Bridge 编辑宿主文件 | `host_edit_file` |
| `...capability.fs.edit.sandbox` | `fs.edit` | script | 通过浏览器 VFS 编辑虚拟文件 | `browser_edit_file` |

**路由逻辑**：`shouldRouteFrameToBrowserVfs(frame)` 判断 tool_call 走 bridge 还是 sandbox。bridge 优先级 -100，sandbox 优先级 -80。

### 浏览器 Capability（3 个）

| 插件 ID | Capability | Mode | 功能 |
|---------|-----------|------|------|
| `...capability.browser.snapshot.cdp` | `browser.snapshot` | cdp | CDP 抓取页面快照（A11y tree / 截图） |
| `...capability.browser.action.cdp` | `browser.action` | cdp | CDP 执行浏览器操作（click/fill/navigate 等 46 个工具） |
| `...capability.browser.verify.cdp` | `browser.verify` | cdp | CDP 执行验证步骤（`browser_verify` 工具） |

---

## 示例插件（3 个）

位于 `extension/plugins/` 目录，以外部插件形式加载。

### 1. Mission HUD Dog（任务看板吉祥物）

- **ID**：`plugin.example.ui.mission-hud.dog`
- **目录**：`extension/plugins/example-mission-hud-dog/`
- **Hook**：`runtime.route.after`、`tool.before_call`、`step.after_execute`、`agent_end.after`
- **功能**：任务运行时在界面展示小狗吉祥物 + 实时状态提示（"汪！我先闻闻线索"）
- **权限**：`runtimeMessages: ["bbloop.ui.mascot"]`
- **UI 模块**：有（当前为空实现）

### 2. Send Success Global Message（示例版）

- **ID**：`plugin.example.notice.send-success-global-message`
- **目录**：`extension/plugins/example-send-success-global-message/`
- **Hook**：`runtime.route.after`
- **功能**：Agent 启动成功时发送全局通知
- **UI 模块**：有（`ui.notice.before_show` 去重 + `ui.runtime.event` 消息补丁）

### 3. Send Success Global Message（正式版）

- **ID**：`plugin.global.message.send-success`
- **目录**：`extension/plugins/send-success-global-message/`
- **Hook**：`runtime.route.after`
- **功能**：同上，正式部署版本
- **权限**：`runtimeMessages: ["bbloop.global.message", "brain.event"]`、`brainEvents: ["plugin.global_message"]`
- **UI 模块**：有

---

## 架构关系

```
orchestrator.registerPlugin()
  ├── ensureBuiltinCapabilityPlugins()     ← 11 个 runtime.builtin.plugin.*
  │     ├── fileCapabilitySpecs (4 capability × 2 mode = 8)
  │     └── browserCapabilitySpecs (3)
  └── plugin-controller.ts                ← 外部插件 (extension/plugins/*)
        └── isBuiltinPluginId() 前缀检查 → 阻止卸载
```
