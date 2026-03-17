---
id: ISSUE-038
title: ProviderSettingsView 在渲染阶段修改全局配置导致高 CPU
status: done
priority: p0
source: 调试对话 2026-03-17
created: 2026-03-17
assignee: agent
tags: [panel, provider-settings, performance, vue]
resolved: 2026-03-17
---

## 背景

`ProviderSettingsView` 在 `computed`/初始渲染路径里调用 `ensureManagedProviderRecord()`，会直接写入 `config.llmProviders`。
这会让模型设置弹层在打开时产生响应式副作用，触发异常重算，最终把 Chrome 扩展 renderer CPU 拉高。

## 处理结果

- 新增回归测试，约束“组件挂载时不得偷偷修改 provider 配置”
- 将 `ProviderSettingsView` 改为本地 draft 态，只有保存时才写回全局 `config`
- 保留原有产品交互：`API Base` / `API Key` / 获取模型 / 主模型 / 高级场景模型分配

## 工作总结

### 2026-03-17 17:00 +08:00

- 复现证据：Chrome Beta 扩展 renderer 进程持续高 CPU，打开扩展页会超时，组件测试确认挂载即修改 `llmProviders`
- 修复后验证：
  - `cd extension && bun run test` → `52 passed / 480 tests`
  - `cd extension && bun run build` → 成功
- 残留：需要用户重新加载扩展，让浏览器实际运行新的 bundle

## 相关 commits

- 未提交

## 工作总结

### 2026-03-17 19:12 +08:00

- 在原“挂载即改全局配置”的修复基础上，继续把模型设置页重做为 scene-first：
  - 主界面只保留 `主对话 / 标题与摘要 / 失败兜底` 三个场景模型选择
  - `+ 添加自定义服务商` 从选择器进入次级面板，不再把 provider 表单塞回主界面
  - 内置免费模型与自定义服务商模型统一进入同一选择列表，显示格式为 `服务商名 / 模型名`
- 补齐运行态目录接线：
  - panel store 新增 `builtinFreeCatalog`
  - SW 新增 `brain.debug.model-catalog`
  - 模型设置状态层新增 scene-first draft / apply / upsert 逻辑
- 修复一个与默认路由相关的保存问题：切回内置免费时，legacy config 转换不再错误过滤被当前路由引用的 builtin cursor profile
- 新增/更新回归测试，覆盖：
  - 挂载不修改 provider 配置
  - 从场景选择器打开添加服务商面板时，不改写当前选择
  - 添加服务商后模型回流到场景选择列表，但不自动切换当前场景
- 本轮验证：
  - `cd extension && bun run test` → `52 passed / 485 tests`
  - `cd extension && bun run build` → 成功
- 未完成：
  - 真实浏览器端到端交互还没跑完；持久 CDP 服务已改为默认流程，但本轮人工授权弹窗仍需用户点一次 `Allow`
