# Runtime Debug Interface

面向外部 AI / Codex 的运行态调试接口，不替代诊断导出。

用途：

- 查当前 kernel / session / queue 运行态
- 查 plugin 持久化、UI 扩展、hook trace、runtime message
- 查 skill 安装清单
- 查最近的 `brain.*` 路由调用尾巴
- 查 sandbox 运行摘要

## 接口

通过扩展 runtime message 调用：

- `brain.debug.runtime`

可选参数：

- `sessionId`
- `routeLimit`
- `pluginMessageLimit`
- `pluginHookLimit`
- `internalEventLimit`

## 返回结构

- `schemaVersion = bbl.debug.runtime.v1`
- `generatedAt`
- `sessionId`
- `data.runtime`
  - `summary`
  - `kernel`
  - `sessions`
  - `activity`
- `data.sandbox`
  - 浏览器沙盒摘要与 recent tail
- `data.plugins`
  - `summary`
  - `plugins`
  - `persisted`
  - `uiExtensions`
  - `modeProviders`
  - `capabilityProviders`
  - `capabilityPolicies`
  - `toolContracts`
  - `llmProviders`
- `data.skills`
  - `summary`
  - `skills`

## activity 子块

`data.runtime.activity` 来自 runtime debug store，适合外部 AI 快速扫最近系统活动：

- `routes`
  - 最近 `brain.*` 路由调用结果
- `pluginRuntimeMessages`
  - plugin 发出的 runtime message 尾巴
- `pluginHookTrace`
  - plugin hook / ui hook 运行尾巴
- `internalEvents`
  - 例如 plugin rehydrate 成功/失败

## 推荐使用顺序

1. `data.runtime.summary`
2. `data.runtime.activity.routes`
3. `data.plugins.persisted`
4. `data.plugins.uiExtensions`
5. `data.runtime.activity.pluginHookTrace`
6. `data.runtime.activity.pluginRuntimeMessages`
7. `data.skills.skills`
8. `data.sandbox`
